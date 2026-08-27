import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Transform, type Readable } from 'node:stream';
import path from 'node:path';

import {
  type ToolRuntimeContext,
} from './runtime-context';
import {
  buildExecutedToolResultData,
  buildOutputTruncationSuffix,
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
  ERR_NOT_TEXT_FILE,
  ERR_UNSUPPORTED_ENCODING,
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
};

/** 嗅探头大小（字节）：只读前 8192B 做二进制/编码判定（4.3） */
const SNIFF_BYTES = 8192;

/** 文本文件扩展名白名单（全小写）：白名单外扩展名直接拒绝；无扩展名/点文件走内容嗅探兜底 */
const TEXT_FILE_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'xml', 'html', 'htm', 'xhtml', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'astro',
  'py', 'pyw', 'ipynb', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'hh', 'cs', 'php', 'pl', 'lua', 'r', 'dart', 'scala', 'groovy',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'psd1', 'bat', 'cmd',
  'sql', 'toml', 'ini', 'cfg', 'conf', 'config', 'properties', 'env',
  'csv', 'tsv', 'diff', 'patch', 'text',
]);

/** 控制字符占比阈值：>0.5% 判二进制（4.3） */
const CONTROL_CHAR_RATIO_THRESHOLD = 0.005;

/** 可读文本特征判定：可打印字符占比阈值（utf-16le 无 BOM 试探，4.3） */
const READABLE_TEXT_RATIO_THRESHOLD = 0.8;

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
 * 二进制判定（4.3）：含 0x00 NUL 字节 → 二进制；控制字符
 * （0x00-0x08/0x0B/0x0C/0x0E-0x1F，不含 \t=0x09/\n=0x0A/\r=0x0D）占比 >0.5% → 二进制。
 */
function isBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.includes(0x00)) {
    return true;
  }

  let controlCount = 0;

  for (const byte of buffer) {
    if (
      (byte >= 0x00 && byte <= 0x08) ||
      byte === 0x0b ||
      byte === 0x0c ||
      (byte >= 0x0e && byte <= 0x1f)
    ) {
      controlCount += 1;
    }
  }

  return buffer.length > 0 && controlCount / buffer.length > CONTROL_CHAR_RATIO_THRESHOLD;
}

/** 可读文本特征：可打印 ASCII / 常见中文区字符占比（utf-16le 无 BOM 试探用） */
function hasReadableText(text: string): boolean {
  if (!text) {
    return false;
  }

  const sample = text.slice(0, 4096);
  let printable = 0;

  for (const ch of sample) {
    const code = ch.charCodeAt(0);

    if (
      (code >= 0x20 && code <= 0x7e) ||
      code === 0x0a ||
      code === 0x0d ||
      code === 0x09 ||
      (code >= 0x4e00 && code <= 0x9fff)
    ) {
      printable += 1;
    }
  }

  return sample.length > 0 && printable / sample.length > READABLE_TEXT_RATIO_THRESHOLD;
}

/**
 * 编码识别（4.3 判定流水线 c）：
 * - BOM 检测：EF BB BF → utf-8；FF FE → utf-16le；FE FF → utf-16be；
 * - 无 BOM → TextDecoder('utf-8', {fatal:true}) 严格解码成功 → utf-8；
 *   失败 → TextDecoder('utf-16le', {fatal:true}) 尝试成功且含可读文本特征 → utf-16le；
 *   失败 → null（UNSUPPORTED_ENCODING）。
 */
function detectTextEncoding(buffer: Buffer): TextEncoding | null {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'utf-8';
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return 'utf-16le';
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return 'utf-16be';
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return 'utf-8';
  } catch {
    try {
      const decoded = new TextDecoder('utf-16le', { fatal: true }).decode(buffer);

      return hasReadableText(decoded) ? 'utf-16le' : null;
    } catch {
      return null;
    }
  }
}

/**
 * 流式分段读取（4.4/4.5/4.7）：
 * - node:readline 流式逐行（\n 分界，行尾 \r 剥离），行号从 1 计数；
 * - start_line 行开始输出、end_line（含）结束输出；
 * - 输出行格式：'行号| 内容'（行号宽度自适应，4.6）。
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

    const outputLines: string[] = [];
    let currentLine = 0;
    let lastOutputLine: number | null = null;
    let charCount = 0;
    let rawBytes = 0;
    let truncated = false;
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
      const content = outputLines.join('\n');
      resolve({
        stdout: truncated ? `${content}${buildOutputTruncationSuffix()}` : content,
        lastOutputLine,
        truncated,
        readBytes: rawBytes,
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

      const formatted = `${String(currentLine).padStart(padWidth, ' ')}| ${content}`;

      rawBytes +=
        (encoding === 'utf-8' ? Buffer.byteLength(content, 'utf8') : content.length * 2) +
        (encoding === 'utf-8' ? 1 : 2);

      const addLen = formatted.length + (outputLines.length > 0 ? 1 : 0);

      if (charCount + addLen > MAX_OUTPUT_LENGTH) {
        truncated = true;

        if (outputLines.length === 0) {
          outputLines.push(formatted.slice(0, MAX_OUTPUT_LENGTH));
          lastOutputLine = currentLine;
        }

        stopAtEndLine();
        return;
      }

      outputLines.push(formatted);
      charCount += addLen;
      lastOutputLine = currentLine;

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
 * read_file 主入口（7.2）：
 * 校验（4.2）→ stat（存在 + isFile）→ 扩展名白名单（4.3）→ 嗅探/编码识别（4.3）→ 流式读取（4.4/4.5）→ 总行数统计（4.5）→ 结果组装（4.6）。
 * 纯 Node fs 只读，无进程 spawn、无网络、无写操作。
 */
export async function readFileTool(
  input: unknown,
  context: ToolRuntimeContext,
): Promise<ToolResult> {
  const resolvedInput =
    input && typeof input === 'object' ? (input as ReadFileInput) : {};
  const responseId = randomUUID();
  const execId = randomUUID();
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
        message: '路径不是文件',
      });
    }
  } catch {
    return buildToolResult({
      success: false,
      code: ERR_FILE_NOT_FOUND,
      message: '文件不存在',
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

  // encoding 可选（4.2）：显式提供时跳过探测直接生效
  let explicitEncoding: TextEncoding | null = null;

  if (
    resolvedInput.encoding !== undefined &&
    resolvedInput.encoding !== null &&
    String(resolvedInput.encoding).trim() !== ''
  ) {
    const normalizedEncoding = String(resolvedInput.encoding).trim().toLowerCase();

    if (
      normalizedEncoding === 'utf-8' ||
      normalizedEncoding === 'utf-16le' ||
      normalizedEncoding === 'utf-16be'
    ) {
      explicitEncoding = normalizedEncoding;
    } else {
      return buildToolResult({
        success: false,
        code: ERR_INVALID_ARGUMENT,
        message: 'encoding 必须为 utf-8/utf-16le/utf-16be',
      });
    }
  }

  // include_total_lines 可选：仅显式 true 时统计并返回文件总行数
  const includeTotalLines = resolvedInput.include_total_lines === true;

  // 扩展名白名单（4.3）：白名单外扩展名直接拒绝
  const fileExt = path.extname(resolvedFilePath).slice(1).toLowerCase();

  if (fileExt !== '' && !TEXT_FILE_EXTENSIONS.has(fileExt)) {
    return buildToolResult({
      success: false,
      code: ERR_NOT_TEXT_FILE,
      message: '文件扩展名不在文本扩展名白名单，拒绝读取',
    });
  }

  // 嗅探：只读前 8192B 做二进制/编码判定（4.3；超大二进制文件不会整读）。
  // 白名单命中且显式 encoding 时跳过（少一次 IO）；无扩展名/点文件必须嗅探做二进制兜底。
  let sniffBuffer: Buffer | null = null;

  if (fileExt === '' || !explicitEncoding) {
    try {
      sniffBuffer = await new Promise<Buffer>((resolve, reject) => {
        const sniffStream = createReadStream(resolvedFilePath, {
          start: 0,
          end: SNIFF_BYTES - 1,
        });
        const chunks: Buffer[] = [];

        sniffStream.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        sniffStream.on('end', () => resolve(Buffer.concat(chunks)));
        sniffStream.on('error', reject);
      });
    } catch (error) {
      return buildToolResult({
        success: false,
        code: ERR_FILE_READ_ERROR,
        message: `文件读取失败：${ensureErrorMessage(error)}`,
      });
    }
  }

  // 校验：二进制文件（4.2 校验表④，仅无扩展名/点文件嗅探路径）
  if (fileExt === '' && isBinaryBuffer(sniffBuffer as Buffer)) {
    return buildToolResult({
      success: false,
      code: ERR_NOT_TEXT_FILE,
      message: '文件是二进制文件，拒绝读取',
    });
  }

  // 编码识别（4.2 校验表⑤）：显式 encoding 直接生效，未提供则嗅探探测
  let encoding: TextEncoding | null = explicitEncoding;

  if (!encoding && sniffBuffer) {
    encoding = detectTextEncoding(sniffBuffer);
  }

  if (!encoding) {
    return buildToolResult({
      success: false,
      code: ERR_UNSUPPORTED_ENCODING,
      message: '文件编码非 UTF-8/UTF-16，可用 run_with_python 读取转换',
    });
  }

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
        data: buildExecutedToolResultData({
          returncode: 130,
          stdout: '',
          stderr: 'ABORTED',
          execId,
          responseId,
        }),
      });
    }

    return buildToolResult({
      success: false,
      code: ERR_FILE_READ_ERROR,
      message: `文件读取失败：${message}`,
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
          data: buildExecutedToolResultData({
            returncode: 130,
            stdout: '',
            stderr: 'ABORTED',
            execId,
            responseId,
          }),
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
  const readLines = range.stdout === '' ? 0 : range.stdout.split('\n').length;
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
    message = `已读取文件 ${startLine}-${range.lastOutputLine} 行${totalLines !== null ? `（共 ${totalLines} 行）` : ''}；行号从 1 开始`;
  }

  const data: Record<string, unknown> = {
    ...buildExecutedToolResultData({
      returncode: 0,
      stdout: range.stdout,
      stderr: '',
      execId,
      responseId,
      extra: {
        file_name: path.basename(resolvedFilePath),
        file_size: `${fileStat.size} B`,
        read_bytes: `${range.readBytes} B`,
        start_line: startLine,
        end_line: endLine,
        read_lines: readLines,
        ...(includeTotalLines ? { total_lines: totalLines } : {}),
      },
    }),
  };

  return buildToolResult({
    success: true,
    code: ERR_OK,
    message,
    data,
  });
}
