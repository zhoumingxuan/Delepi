import type { Stats } from 'node:fs';
import { createReadStream } from 'node:fs';
import { appendFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { type ToolRuntimeContext } from './runtime-context';
import { buildToolResult, type ToolResult } from './result';
import { ensureErrorMessage, normalizeString } from '../utils/index';
import {
  ERR_ABORTED,
  ERR_APPEND_VERIFY_FAILED,
  ERR_FILE_NOT_FOUND,
  ERR_FILE_READ_ERROR,
  ERR_INVALID_ARGUMENT,
  ERR_NOT_TEXT_FILE,
  ERR_OK,
  ERR_PATH_NOT_FILE,
  ERR_UNSUPPORTED_ENCODING,
  ERR_WRITE_FILE_ERROR,
} from '../constants';

/** 全文件扫描分块大小（字节）：64KB 顺序流式扫描，内存占用 O(块大小) */
const SCAN_CHUNK_BYTES = 64 * 1024;

type FsAppendTextInput = {
  path?: unknown;
  content?: unknown;
  ensure_leading_newline?: unknown;
};

/** 单次全文件扫描的实测统计（行数按 CRLF / LF / 孤立 CR 三态口径统计） */
type FileTextStats = {
  /** 文件总字节数（实测） */
  size: number;
  /** 行数：空文件 0；非空 =（0x0A 个数 + 孤立 0x0D 个数）+（末字节非 0x0A/0x0D ? 1 : 0），只含 BOM 的文件计 1 行 */
  lineCount: number;
  /** 0x0A 总数 */
  newlineCount: number;
  /** 其中前一字节为 0x0D 的数量（CRLF 数量） */
  crlfCount: number;
  /** 孤立 0x0D 数量（其后一字节不是 0x0A；文件末尾的 0x0D 也计为孤立 CR） */
  crOnlyCount: number;
  /** 文件末字节；空文件为 null */
  lastByte: number | null;
};

type ScanOutcome =
  | { ok: true; stats: FileTextStats }
  | { ok: false; code: string; message: string };

/** 解析布尔开关：未传/空 → undefined（走默认值）；true/false 及其字符串形式 → 布尔；其余 → null（非法） */
function parseBooleanOption(value: unknown): boolean | null | undefined {
  if (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '')
  ) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();

    if (lower === 'true') {
      return true;
    }
    if (lower === 'false') {
      return false;
    }
  }
  return null;
}

/**
 * 定位严格解码失败在本分块内最早的 0 基字节偏移（仅用于错误信息；成败判定始终由致命解码器给出）。
 * 二分前缀长度：前缀一旦包含非法字节即失败，且更长前缀必然继续失败，具备单调性。
 */
function locateUtf8ErrorOffset(chunk: Buffer, chunkStartOffset: number): number {
  const decodeFails = (end: number): boolean => {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(chunk.subarray(0, end), {
        stream: true,
      });
      return false;
    } catch {
      return true;
    }
  };

  let low = 1;
  let high = chunk.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (decodeFails(middle)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return chunkStartOffset + low - 1;
}

/**
 * 全文件流式扫描：一次读盘同时完成四项判定与统计（不是只看文件头部）。
 * - 首 2 字节为 UTF-16 BOM（FF FE / FE FF）→ UNSUPPORTED_ENCODING（仅支持 UTF-8，不转码、不降级）；
 * - 任一字节 0x00 → NOT_TEXT_FILE（带 0 基字节偏移）；
 * - UTF-8 严格解码（TextDecoder fatal 流式）失败 → NOT_TEXT_FILE（带 0 基字节偏移近似值）；
 * - 行数口径（CRLF / LF / 孤立 CR 三态）：空文件 0 行；非空 =（0x0A 个数 + 孤立 0x0D 个数）+（末字节非 0x0A 且非 0x0D ? 1 : 0）；read_file 的 countFileLines 只数 0x0A，含孤立 CR 时会与本口径不同。
 * 同时统计 0x0A 总数、其中前一字节为 0x0D 的数量（CRLF 数量）与孤立 0x0D 数量（其后一字节不是 0x0A；分块末字节的 0x0D 延后到下一分块首字节判定），供换行风格探测使用。
 */
async function scanTextFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<ScanOutcome> {
  const stream = createReadStream(filePath, { highWaterMark: SCAN_CHUNK_BYTES });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let newlineCount = 0;
  let crlfCount = 0;
  let crOnlyCount = 0;
  let pendingCrAtChunkEnd = false;
  let lastByte: number | null = null;

  try {
    for await (const chunk of stream) {
      if (signal?.aborted) {
        stream.destroy();
        return { ok: false, code: ERR_ABORTED, message: '文本追加已取消' };
      }

      const buffer = chunk as Buffer;

      if (buffer.length === 0) {
        continue;
      }

      if (size === 0 && buffer.length >= 2) {
        const isUtf16Bom =
          (buffer[0] === 0xff && buffer[1] === 0xfe) ||
          (buffer[0] === 0xfe && buffer[1] === 0xff);

        if (isUtf16Bom) {
          stream.destroy();
          return {
            ok: false,
            code: ERR_UNSUPPORTED_ENCODING,
            message:
              '仅支持 UTF-8 编码：目标文件以 UTF-16 BOM 开头（0 基字节偏移 0），已拒绝追加且未做任何转码',
          };
        }
      }

      const nulIndex = buffer.indexOf(0x00);

      if (nulIndex !== -1) {
        stream.destroy();
        return {
          ok: false,
          code: ERR_NOT_TEXT_FILE,
          message: `目标不是纯文本文件：在 0 基字节偏移 ${size + nulIndex} 处检测到 0x00 字节`,
        };
      }

      try {
        decoder.decode(buffer, { stream: true });
      } catch {
        stream.destroy();
        return {
          ok: false,
          code: ERR_NOT_TEXT_FILE,
          message: `目标不是纯文本文件：UTF-8 严格解码失败（0 基字节偏移约 ${locateUtf8ErrorOffset(buffer, size)}）`,
        };
      }

      let newlineIndex = buffer.indexOf(0x0a);

      while (newlineIndex !== -1) {
        newlineCount += 1;

        const previousByte = newlineIndex > 0 ? buffer[newlineIndex - 1] : lastByte;

        if (previousByte === 0x0d) {
          crlfCount += 1;
        }

        newlineIndex = buffer.indexOf(0x0a, newlineIndex + 1);
      }

      if (pendingCrAtChunkEnd) {
        // 上一分块末字节为 0x0D：由本分块首字节判定其是 CRLF 还是孤立 CR
        if (buffer[0] !== 0x0a) {
          crOnlyCount += 1;
        }
        pendingCrAtChunkEnd = false;
      }

      let crIndex = buffer.indexOf(0x0d);

      while (crIndex !== -1) {
        if (crIndex === buffer.length - 1) {
          // 0x0D 落在分块末字节：延后到下一分块首字节判定，禁止跨 64KB 边界误计
          pendingCrAtChunkEnd = true;
        } else if (buffer[crIndex + 1] !== 0x0a) {
          crOnlyCount += 1;
        }

        crIndex = buffer.indexOf(0x0d, crIndex + 1);
      }

      lastByte = buffer[buffer.length - 1];
      size += buffer.length;
    }

    // 文件末字节为 0x0D（分块末字节延后判定且无后续分块）→ 计为孤立 CR
    if (pendingCrAtChunkEnd) {
      crOnlyCount += 1;
    }

    // 刷新解码器残留：文件末尾存在不完整的多字节序列时在此失败
    try {
      decoder.decode();
    } catch {
      return {
        ok: false,
        code: ERR_NOT_TEXT_FILE,
        message:
          '目标不是纯文本文件：UTF-8 严格解码失败（文件末尾存在不完整的多字节序列）',
      };
    }
  } catch (error) {
    const message = ensureErrorMessage(error);

    if (message === ERR_ABORTED) {
      return { ok: false, code: ERR_ABORTED, message: '文本追加已取消' };
    }

    return {
      ok: false,
      code: ERR_FILE_READ_ERROR,
      message: `目标文件读取失败：${message}`,
    };
  }

  return {
    ok: true,
    stats: {
      size,
      lineCount:
        size > 0
          ? newlineCount + crOnlyCount + (lastByte === 0x0a || lastByte === 0x0d ? 0 : 1)
          : 0,
      newlineCount,
      crlfCount,
      crOnlyCount,
      lastByte,
    },
  };
}

/**
 * 换行风格探测（三态多数决）：CRLF / 裸 LF / 孤立 CR 三者中严格多数者胜出，任一平票一律回退 LF；
 * 文件不含任何换行符（含 0 字节空文件）时按运行平台兜底（win32 → CRLF，其它 → LF），不写死单一换行符。
 */
function resolveTargetNewline(stats: FileTextStats): string {
  if (stats.newlineCount === 0 && stats.crOnlyCount === 0) {
    return process.platform === 'win32' ? '\r\n' : '\n';
  }

  const bareLfCount = stats.newlineCount - stats.crlfCount;

  if (stats.crlfCount > bareLfCount && stats.crlfCount > stats.crOnlyCount) {
    return '\r\n';
  }

  if (stats.crOnlyCount > stats.crlfCount && stats.crOnlyCount > bareLfCount) {
    return '\r';
  }

  return '\n';
}

/** content 换行规范化：CRLF→LF → 剩余孤立 CR→LF → LF→目标换行符；不 trim、不补空格、不做转义 */
function normalizeAppendContent(content: string, targetNewline: string): string {
  const unified = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return targetNewline === '\n' ? unified : unified.replace(/\n/g, targetNewline);
}

/**
 * lines_added 精确算法（独立计算，不取 lines_after - lines_before，供写后恒等式校验使用）。
 * 记追加前字节串 B、本次实际写入字节串 A，行数函数
 *   L(P) = 0（P 为空）/（0x0A 个数 + 孤立 0x0D 个数）+（末字节非 0x0A 且非 0x0D ? 1 : 0）（P 非空）。
 * 当 |A| = 0 时 L 不变，增量为 0；当 |A| > 0 时 L(B||A) = N_B + N_A - M +（A 末字节为 0x0A 或 0x0D ? 0 : 1），
 *   M =（B 末字节为 0x0D 且 A 首字节为 0x0A ? 1 : 0，此时两者合并为 1 个 CRLF）；
 * 故增量 = L(A) -（B 为空 ? 0 :（B 末字节为 0x0A 或 0x0D ? 0 : 1））- M。
 */
function computeLinesAdded(options: {
  sizeBefore: number;
  lastByteBefore: number | null;
  appendedLength: number;
  appendedStartsWithLf: boolean;
  appendedNewlineCount: number;
  appendedEndsWithNewline: boolean;
}): number {
  if (options.appendedLength === 0) {
    return 0;
  }

  const appendedLineCount =
    options.appendedNewlineCount + (options.appendedEndsWithNewline ? 0 : 1);

  if (options.sizeBefore === 0) {
    return appendedLineCount;
  }

  const linesBeforeTail =
    options.lastByteBefore === 0x0a || options.lastByteBefore === 0x0d ? 0 : 1;
  // 追加前末字节为 0x0D 且追加首字节为 0x0A 时，拼接后合并为 1 个 CRLF：
  // 原末尾孤立 CR 不再独立成行，需扣除 1，否则写后恒等式必然失败
  const mergedCrlfCount =
    options.lastByteBefore === 0x0d && options.appendedStartsWithLf ? 1 : 0;

  return appendedLineCount - linesBeforeTail - mergedCrlfCount;
}

/** 把 errno 错误码映射为工具错误码与文案（与 fs_stat 的只读分支口径一致） */
function buildFileAccessErrorResult(error: unknown): ToolResult {
  const errnoCode =
    error && typeof error === 'object' && typeof (error as NodeJS.ErrnoException).code === 'string'
      ? ((error as NodeJS.ErrnoException).code as string)
      : '';

  if (errnoCode === 'ENOENT' || errnoCode === 'ENOTDIR') {
    return buildToolResult({
      success: false,
      code: ERR_FILE_NOT_FOUND,
      message: '文件不存在,请确认输入的path参数是否存在问题',
    });
  }

  if (errnoCode === 'EACCES' || errnoCode === 'EPERM') {
    return buildToolResult({
      success: false,
      code: ERR_FILE_READ_ERROR,
      message: '无权限访问该路径,请确认当前运行环境的访问权限',
    });
  }

  return buildToolResult({
    success: false,
    code: ERR_FILE_READ_ERROR,
    message: `路径信息读取失败：${ensureErrorMessage(error)}`,
  });
}

/**
 * fs_append_text 主入口：把一段文本【只追加】到单个纯文本文件的末尾（不覆盖、不插入、不截断）。
 * - path 必填：已存在的普通文件绝对路径，写入时使用 realpath 解析后的绝对路径；
 * - content 必填：要追加的文本，写入前按目标换行风格规范化，不 trim、不补空格、不做转义；
 * - ensure_leading_newline（补齐换行开关）可选，默认 true：目标文件非空、末尾不是换行字节、
 *   且 content 开头第一个字符不是换行符时，写入前自动补一个目标换行符；文件为空（0 字节）时任何情况下都不补；
 * - 编码仅支持 UTF-8（BOM 原样保留）；UTF-16 BOM → UNSUPPORTED_ENCODING；NUL 或严格解码失败 → NOT_TEXT_FILE；
 * - 返回恰好四个字段：lines_before / lines_added / lines_after / file_path，且 lines_after 为写后重新完整扫描实测；
 *   若实测不满足 lines_before + lines_added = lines_after，返回 APPEND_VERIFY_FAILED 而不是破坏恒等式的数据。
 * 纯 Node fs 实现；仅支持本地文件系统，支持 context.signal 取消。
 */
export async function fsAppendText(
  input: unknown,
  context: ToolRuntimeContext,
): Promise<ToolResult> {
  const resolvedInput =
    input && typeof input === 'object' ? (input as FsAppendTextInput) : {};

  if (context.signal?.aborted) {
    return buildToolResult({
      success: false,
      code: ERR_ABORTED,
      message: '文本追加已取消',
    });
  }

  const pathRaw = normalizeString(resolvedInput.path);

  if (!pathRaw) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'path 必填：要追加文本的【纯文本文件】绝对路径',
    });
  }

  if (!path.isAbsolute(pathRaw)) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message:
        'path 必须为绝对路径：请提供当前运行平台可识别的绝对路径（Windows 形如 E:\\dir\\file.txt，POSIX 形如 /dir/file.txt）',
    });
  }

  const contentText =
    resolvedInput.content === undefined || resolvedInput.content === null
      ? ''
      : String(resolvedInput.content);

  if (contentText.length === 0) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'content 必填：要追加的文本不能为空',
    });
  }

  const parsedEnsureLeadingNewline = parseBooleanOption(
    resolvedInput.ensure_leading_newline,
  );

  if (parsedEnsureLeadingNewline === null) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'ensure_leading_newline 必须为布尔值（true/false）',
    });
  }

  const ensureLeadingNewline = parsedEnsureLeadingNewline ?? true;
  const targetPath = path.resolve(pathRaw);
  let fileStat: Stats;

  try {
    fileStat = await stat(targetPath);
  } catch (error) {
    return buildFileAccessErrorResult(error);
  }

  if (!fileStat.isFile()) {
    return buildToolResult({
      success: false,
      code: ERR_PATH_NOT_FILE,
      message: '路径不是文件,请确认输入的path参数是否存在问题',
    });
  }

  let realPath: string;

  try {
    realPath = await realpath(targetPath);
  } catch (error) {
    return buildToolResult({
      success: false,
      code: ERR_FILE_READ_ERROR,
      message: `目标文件路径解析失败：${ensureErrorMessage(error)}`,
    });
  }

  const beforeScan = await scanTextFile(realPath, context.signal);

  if (!beforeScan.ok) {
    return buildToolResult({
      success: false,
      code: beforeScan.code,
      message: beforeScan.message,
    });
  }

  const before = beforeScan.stats;
  const targetNewline = resolveTargetNewline(before);
  // 末尾为 0x0A 或孤立 0x0D 都视为「末尾已是换行」，避免补出 "\r\r\n" 之类的空行
  const fileEndsWithNewline = before.lastByte === 0x0a || before.lastByte === 0x0d;
  const needsLeadingNewline =
    ensureLeadingNewline &&
    before.size > 0 &&
    !fileEndsWithNewline &&
    !contentText.startsWith('\n') &&
    !contentText.startsWith('\r');
  const appendBuffer = Buffer.from(
    (needsLeadingNewline ? targetNewline : '') +
      normalizeAppendContent(contentText, targetNewline),
    'utf8',
  );
  const appendedNewlineByte = targetNewline === '\r' ? 0x0d : 0x0a;
  let appendedNewlineCount = 0;
  let appendNewlineIndex = appendBuffer.indexOf(appendedNewlineByte);

  while (appendNewlineIndex !== -1) {
    appendedNewlineCount += 1;
    appendNewlineIndex = appendBuffer.indexOf(appendedNewlineByte, appendNewlineIndex + 1);
  }

  const linesAdded = computeLinesAdded({
    sizeBefore: before.size,
    lastByteBefore: before.lastByte,
    appendedLength: appendBuffer.length,
    appendedStartsWithLf: appendBuffer.length > 0 && appendBuffer[0] === 0x0a,
    appendedNewlineCount,
    appendedEndsWithNewline:
      appendBuffer.length > 0 &&
      appendBuffer[appendBuffer.length - 1] === appendedNewlineByte,
  });

  if (context.signal?.aborted) {
    return buildToolResult({
      success: false,
      code: ERR_ABORTED,
      message: '文本追加已取消',
    });
  }

  try {
    await appendFile(realPath, appendBuffer);
  } catch (error) {
    return buildToolResult({
      success: false,
      code: ERR_WRITE_FILE_ERROR,
      message: `文本追加写入失败：${ensureErrorMessage(error)}`,
    });
  }

  const afterScan = await scanTextFile(realPath, context.signal);

  if (!afterScan.ok) {
    return buildToolResult({
      success: false,
      code: afterScan.code,
      message: `追加后重新实测失败：${afterScan.message}`,
    });
  }

  const after = afterScan.stats;

  if (before.lineCount + linesAdded !== after.lineCount) {
    return buildToolResult({
      success: false,
      code: ERR_APPEND_VERIFY_FAILED,
      message:
        `追加后行数恒等式校验失败：lines_before(${before.lineCount}) + ` +
        `lines_added(${linesAdded}) ≠ lines_after(${after.lineCount})，` +
        '目标文件可能在追加期间被其它进程改写',
    });
  }

  return buildToolResult({
    success: true,
    code: ERR_OK,
    message: `文本追加完成：${before.lineCount} 行 → ${after.lineCount} 行（新增 ${linesAdded} 行）`,
    data: {
      lines_before: before.lineCount,
      lines_added: linesAdded,
      lines_after: after.lineCount,
      file_path: realPath,
    },
  });
}
