import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Transform, type Readable } from 'node:stream';
import path from 'node:path';

import {
  type ToolRuntimeContext,
} from './runtime-context';
import {
  buildToolResult,
  type ToolResult,
} from './result';
import {
  ensureErrorMessage,
  normalizeString,
} from '../utils/index';
import {
  MAX_OUTPUT_LENGTH,
  ERR_INVALID_ARGUMENT,
  ERR_FILE_NOT_FOUND,
  ERR_PATH_NOT_FILE,
  ERR_FILE_READ_ERROR,
  ERR_OK,
  ERR_ABORTED,
} from '../constants';

type ReadFileInput = {
  path?: unknown;
  start_line?: unknown;
  end_line?: unknown;
  encoding?: unknown;
  include_total_lines?: unknown;
};

type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

type ReadRangeResult = {
  stdout: string;
  lastOutputLine: number | null;
  truncated: boolean;
  readBytes: number;
  /** 首行（输出范围内第一行）组回即超限：不输出任何内容，由主入口直接报错 */
  firstLineTooLong: boolean;
  /** 实际读取行数（触发截断时 = 触发前已完整读取行数） */
  readLines: number;
};

// 对齐 inspect-image.ts L70-72
function normalizeFilePath(value: unknown): string {
  return normalizeString(value).replace(/^["']+|["']+$/g, '');
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return parseInt(value.trim(), 10);
  }
  return null;
}

/**
 * 流式分段读取（4.4/4.5/4.7）：
 * - node:readline 流式逐行（\n 分界，行尾 \r 剥离），行号从 1 计数；
 * - start_line 行开始输出、end_line（含）结束输出；
 * - 非截断输出行格式：'行号| 内容'（行号宽度自适应，4.6）；
 * - 截断口径：将已完整读取的行组回 content（行间含换行符）后累计字符超 16384 即触发，触发行不输出；
 *   首行组回即超限不输出任何内容，由主入口直接报错。
 */
async function readLinesRange(
  filePath: string,
  startLine: number,
  endLine: number | null,
  encoding: TextEncoding,
  signal?: AbortSignal,
): Promise<ReadRangeResult> {
  return new Promise<ReadRangeResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('ABORTED'));
      return;
    }

    const contentLines: string[] = [];
    let currentLine = 0;
    let lastOutputLine: number | null = null;
    let charCount = 0;
    let rawBytes = 0;
    let truncated = false;
    let firstLineTooLong = false;
    let settled = false;
    let rl: ReturnType<typeof createInterface>;
    let stream: Readable;

    const padWidth = Math.max(1, String(endLine ?? 0).length);

    const cleanup = () => {
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    const abortHandler = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error('ABORTED'));
    };

    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const stopAtEndLine = () => {
      rl.close();
      stream.destroy();
    };

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      // 截断判断口径：将已完整读取的行组回 content（行间含换行符）后计算字符总数，累计超 16384 即触发
      const content = contentLines.join('\n');
      let stdout: string;

      if (truncated) {
        // 首行组回即超限：不输出任何内容，由主入口直接报错
        if (firstLineTooLong) {
          stdout = '';
        } else {
          // 触发行不输出，只输出触发前已完整读取的行（保留行结构/换行）
          stdout = `当前因总字符数超过${MAX_OUTPUT_LENGTH}字符产生截断，请关注实际读取行范围，目前已读取的内容为：${content}`;
        }
      } else {
        // 非截断：保留既有输出格式（行号| 内容）
        stdout = contentLines
          .map((c, i) => `${String(startLine + i).padStart(padWidth, ' ')}| ${c}`)
          .join('\n');
      }

      resolve({
        stdout,
        lastOutputLine,
        truncated,
        readBytes: rawBytes,
        firstLineTooLong,
        readLines: contentLines.length,
      });
    };

    // utf-16be：Node fs 无原生 utf16be 编码，经 Transform + TextDecoder 流式转码后喂 readline
    if (encoding === 'utf-16be') {
      const decoder = new TextDecoder('utf-16be');
      const converter = new Transform({
        transform(
          chunk: Buffer | string,
          _encoding: string,
          callback: (error?: Error | null, data?: string) => void,
        ) {
          callback(
            null,
            decoder.decode(
              Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
              { stream: true },
            ),
          );
        },
        flush(callback: (error?: Error | null, data?: string) => void) {
          callback(null, decoder.decode());
        },
      });

      stream = createReadStream(filePath).pipe(converter);
    } else {
      stream = createReadStream(filePath, {
        encoding: encoding === 'utf-8' ? 'utf-8' : 'utf16le',
      });
    }

    rl = createInterface({ input: stream });

    rl.on('line', (line: string) => {
      currentLine += 1;

      if (currentLine < startLine) {
        return;
      }

      // 行尾 \r 剥离（兼容 CRLF/LF）；首行剥离 BOM 残留 \uFEFF
      let content = line.replace(/\r$/, '');

      if (currentLine === 1) {
        content = content.replace(/^\uFEFF/, '');
      }

      // 触发判断口径：将已完整读取的行组回 content（行间含换行符）后计算字符总数，累计超 16384 即触发截断
      const addLen = content.length + (contentLines.length > 0 ? 1 : 0);

      if (charCount + addLen > MAX_OUTPUT_LENGTH) {
        truncated = true;

        // 触发行（使累计超限的那一行）不输出，只输出触发前已完整读取的行
        if (contentLines.length === 0) {
          // 第一行组回即超限：不输出任何内容，由主入口直接报错
          firstLineTooLong = true;
        }

        stopAtEndLine();
        return;
      }

      contentLines.push(content);
      charCount += addLen;
      lastOutputLine = currentLine;

      rawBytes +=
        (encoding === 'utf-8' ? Buffer.byteLength(content, 'utf8') : content.length * 2) +
        (encoding === 'utf-8' ? 1 : 2);

      // end_line 到达（含）——早停（4.4）
      if (endLine !== null && currentLine >= endLine) {
        stopAtEndLine();
        return;
      }
    });

    rl.on('close', () => {
      finish();
    });

    rl.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

/**
 * 总行数流式分块统计（4.5）：64KB 块顺序扫描，内存 O(块大小)；与读取分离（全文件口径，不受 end_line 早停影响）。
 * 口径与 node:readline 一致：末行无换行符仍计为一行，空文件为 0。
 * utf-16le/utf-16be 必须解码统计（utf-16le 中「上」字符首字节即 0x0A，按字节数会误计行数）。
 */
async function countFileLines(
  filePath: string,
  encoding: TextEncoding,
  signal?: AbortSignal,
): Promise<number> {
  const CHUNK = 64 * 1024;
  let newlineCount = 0;
  let sawChar = false;
  let lastWasNewline = false;

  const stream = createReadStream(filePath, { highWaterMark: CHUNK });

  const abortHandler = () => {
    stream.destroy(new Error('ABORTED'));
  };

  if (signal) {
    if (signal.aborted) {
      stream.destroy();
      throw new Error('ABORTED');
    }
    signal.addEventListener('abort', abortHandler, { once: true });
  }

  const countChar = (ch: string) => {
    sawChar = true;
    if (ch === '\n') {
      newlineCount += 1;
      lastWasNewline = true;
    } else {
      lastWasNewline = false;
    }
  };

  try {
    if (encoding === 'utf-8') {
      // BOM(EF BB BF) 不含 0x0A；UTF-8 多字节序列不含 0x0A，按字节计数安全
      for await (const chunk of stream) {
        const buffer = chunk as Buffer;

        if (buffer.length > 0) {
          sawChar = true;
          let idx = buffer.indexOf(0x0a);
          while (idx !== -1) {
            newlineCount += 1;
            idx = buffer.indexOf(0x0a, idx + 1);
          }
          lastWasNewline = buffer[buffer.length - 1] === 0x0a;
        }
      }
    } else {
      const decoder = new TextDecoder(encoding);

      for await (const chunk of stream) {
        const decoded = decoder.decode(chunk as Buffer, { stream: true });
        for (const ch of decoded) {
          countChar(ch);
        }
      }

      const tail = decoder.decode();
      for (const ch of tail) {
        countChar(ch);
      }
    }
  } finally {
    if (signal) {
      signal.removeEventListener('abort', abortHandler);
    }
  }

  return sawChar ? newlineCount + (lastWasNewline ? 0 : 1) : 0;
}

/**
 * read_file 主入口：
 * 校验（path 必填 + 存在 + isFile）→ start_line/end_line 校验 → encoding（默认 utf-8，不限定枚举）→ 流式读取（已完整读取行组回 content 累计字符超 MAX_OUTPUT_LENGTH 触发截断，触发行不输出；首行组回即超限直接报错）→ 按需统计总行数 → 结果组装。
 * 纯 Node fs 只读，无进程 spawn、无网络、无写操作。
 */
export async function readFileTool(
  input: unknown,
  context: ToolRuntimeContext,
): Promise<ToolResult> {
  const resolvedInput =
    input && typeof input === 'object' ? (input as ReadFileInput) : {};
  const filePath = normalizeFilePath(resolvedInput.path);

  // 校验：path 为空/非字符串（4.2 校验表①）
  if (!filePath) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'path 不能为空',
    });
  }

  const resolvedFilePath = path.resolve(filePath);

  // 校验：path 不存在 / 不是文件（4.2 校验表②③，对齐 inspect-image.ts L185-201）
  let fileStat;

  try {
    fileStat = await stat(resolvedFilePath);

    if (!fileStat.isFile()) {
      return buildToolResult({
        success: false,
        code: ERR_PATH_NOT_FILE,
        message: '路径不是文件,请确认输入的path参数是否存在问题',
      });
    }
  } catch {
    return buildToolResult({
      success: false,
      code: ERR_FILE_NOT_FOUND,
      message: '文件不存在,请确认输入的path参数是否存在问题',
    });
  }

  // 校验：start_line 必须为 >=1 的整数（4.2 校验表⑥）
  const startLine = toPositiveInteger(resolvedInput.start_line);

  if (startLine === null) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'start_line 必须为大于等于 1 的整数',
    });
  }

  // end_line 可选（4.2 校验表⑦）
  let endLine: number | null = null;

  if (
    resolvedInput.end_line !== undefined &&
    resolvedInput.end_line !== null &&
    String(resolvedInput.end_line).trim() !== ''
  ) {
    endLine = toPositiveInteger(resolvedInput.end_line);

    if (endLine === null) {
      return buildToolResult({
        success: false,
        code: ERR_INVALID_ARGUMENT,
        message: 'end_line 必须为大于等于 1 的整数',
      });
    }

    if (endLine < startLine) {
      return buildToolResult({
        success: false,
        code: ERR_INVALID_ARGUMENT,
        message: 'end_line 不能小于 start_line',
      });
    }
  }

  // encoding 可选：不限定枚举（用户定稿：仅默认 utf-8）；utf-16le/utf-16be 显式生效，其余任意值一律按默认 utf-8 读取，不报错
  let encoding: TextEncoding = 'utf-8';

  if (
    resolvedInput.encoding !== undefined &&
    resolvedInput.encoding !== null &&
    String(resolvedInput.encoding).trim() !== ''
  ) {
    const normalizedEncoding = String(resolvedInput.encoding).trim().toLowerCase();

    if (normalizedEncoding === 'utf-16le' || normalizedEncoding === 'utf-16be') {
      encoding = normalizedEncoding;
    }
  }

  // include_total_lines 可选：仅显式 true 时统计并返回文件总行数
  const includeTotalLines = resolvedInput.include_total_lines === true;

  // 流式分段读取（4.4/4.5）
  let range: ReadRangeResult;

  try {
    range = await readLinesRange(
      resolvedFilePath,
      startLine,
      endLine,
      encoding,
      context.signal,
    );
  } catch (error) {
    const message = ensureErrorMessage(error);

    if (message === 'ABORTED') {
      return buildToolResult({
        success: false,
        code: ERR_ABORTED,
        message: '文件读取已取消',
      });
    }

    return buildToolResult({
      success: false,
      code: ERR_FILE_READ_ERROR,
      message: `文件读取失败：${message}`,
    });
  }

  // 第一行组回即超 16384：不输出任何内容，直接报错（用户定稿文案逐字；"请改用其他工具"为原文，未擅改）
  if (range.firstLineTooLong) {
    return buildToolResult({
      success: false,
      code: ERR_FILE_READ_ERROR,
      message: `当前文件内容只有1行，1行的内容已超过${MAX_OUTPUT_LENGTH}字符，已拒绝读取，请改用其他工具（例如：run_with_python工具处理）`,
    });
  }

  // 总行数独立流式统计（4.5）：与读取分离，全文件口径；仅 include_total_lines === true 时执行
  let totalLines: number | null = null;

  if (includeTotalLines) {
    try {
      totalLines = await countFileLines(resolvedFilePath, encoding, context.signal);
    } catch (error) {
      const message = ensureErrorMessage(error);

      if (message === 'ABORTED') {
        return buildToolResult({
          success: false,
          code: ERR_ABORTED,
          message: '文件读取已取消',
        });
      }

      return buildToolResult({
        success: false,
        code: ERR_FILE_READ_ERROR,
        message: `文件读取失败：${message}`,
      });
    }
  }

  // 结果组装（4.6）：每行内容+行号（stdout）、起始行号、实读行数、总行数四要素必返
  // 实际读取行数由读取层直接返回（触发截断时 = 触发前已完整读取行数；截断文案含换行，不能依赖 stdout 分割）
  const readLines = range.readLines;
  let message: string;

  if (range.stdout === '') {
    if (fileStat.size === 0) {
      message = '文件为空';
    } else if (totalLines !== null && startLine > totalLines) {
      message = `起始行号超出文件总行数（共 ${totalLines} 行）`;
    } else {
      message = '未读取到内容';
    }
  } else {
    message = `已读取文件 ${startLine}-${range.lastOutputLine} 行${totalLines !== null ? `（共 ${totalLines} 行）` : ''}；行号是从 1 开始的`;
  }
  
  const data: Record<string, unknown> = {
      file_name: path.basename(resolvedFilePath),
        file_size: `${fileStat.size} B`,
        read_bytes: `${range.readBytes} B`,
        read_start_line: startLine,
        read_end_line: endLine,
        read_line_count: readLines,
        ...(includeTotalLines ? { total_lines: totalLines } : {}),
        read_content: range.stdout,
    }

  return buildToolResult({
    success: true,
    code: ERR_OK,
    message,
    data,
  });
}
