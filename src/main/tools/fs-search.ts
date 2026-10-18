import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

import { type ToolRuntimeContext } from './runtime-context';
import { buildToolResult, truncateFsResultJson, type ToolResult } from './result';
import { normalizeString, ensureErrorMessage } from '../utils/index';
import {
  ERR_ABORTED,
  ERR_INVALID_ARGUMENT,
  ERR_FILE_NOT_FOUND,
  ERR_PATH_NOT_FILE,
  ERR_OK,
} from '../constants';

/**
 * 单行摘要保留的最大字符数：仅影响 line_content 的展示长度，
 * 不参与匹配判定，也不改变 match_start_index / match_end_index 的完整行口径。
 */
const CONTENT_LINE_SUMMARY_LIMIT = 8192;

/** 二进制探测窗口（字节）：窗口内出现 0x00 即判定为二进制文件并跳过内容搜索。 */
const BINARY_PROBE_BYTES = 8192;

type FsSearchInput = {
  directory?: unknown;
  file_path?: unknown;
  content?: unknown;
  regex?: unknown;
  case_sensitive?: unknown;
};

/** 单条内容命中：行内容 + 命中在【完整原始行】中的起止字符位置（1 基、首尾均含）。 */
type ContentLineMatch = {
  line_index: number;
  line_content: string;
  match_start_index: number;
  match_end_index: number;
  line_truncated: boolean;
  line_original_length: number;
};

/** 单个文件的内容命中结果集：file_path 为命中文件路径，matches 为命中数组。 */
type ContentFileHit = {
  file_path: string;
  matches: ContentLineMatch[];
};

type SkippedContentFile = {
  file_path: string;
  reason: string;
};

/** 待搜索文件：path 为该文件的绝对路径。 */
type SearchFile = {
  path: string;
};

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

/** content 为普通字面量时转义正则元字符，保证按字面量匹配 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 编译逐行匹配用的正则：
 * - regex=false：content 按普通字面量转义后编译；
 * - regex=true：content 直接作为 JavaScript 正则表达式编译；
 * - case_sensitive=false 时追加 i 标志。
 * 返回 { error } 表示正则编译失败（非法正则）。
 */
function compileLinePattern(
  content: string,
  useRegex: boolean,
  caseSensitive: boolean,
): { regexp: RegExp } | { error: string } {
  const source = useRegex ? content : escapeRegExp(content);
  const flags = caseSensitive ? 'g' : 'gi';

  try {
    return { regexp: new RegExp(source, flags) };
  } catch (error) {
    return { error: ensureErrorMessage(error) };
  }
}

/** 在单行内收集所有非重叠命中；零长度命中通过 lastIndex+1 推进，避免死循环 */
function collectLineMatches(
  regexp: RegExp,
  line: string,
): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];

  regexp.lastIndex = 0;
  let match = regexp.exec(line);

  while (match) {
    matches.push({ start: match.index, end: match.index + match[0].length });

    if (match[0].length === 0) {
      regexp.lastIndex += 1;
    }

    match = regexp.exec(line);
  }

  return matches;
}

/** 二进制探测：读取文件头 BINARY_PROBE_BYTES 字节，出现 NUL(0x00) 判定为二进制 */
async function probeBinaryFile(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r');

  try {
    const probe = Buffer.alloc(BINARY_PROBE_BYTES);
    const { bytesRead } = await handle.read(probe, 0, BINARY_PROBE_BYTES, 0);

    for (let index = 0; index < bytesRead; index += 1) {
      if (probe[index] === 0) {
        return true;
      }
    }

    return false;
  } finally {
    await handle.close();
  }
}

/**
 * 逐行收集单个文件的内容命中（readline 流式读取，\r\n / \r / \n 均为行边界）：
 * - line_index 从 1 开始计数（首行为 1，与字符位置同一基数）；
 * - 单行超过 CONTENT_LINE_SUMMARY_LIMIT 字符时，line_content 仅保留前 8192 字符，
 *   并以 line_truncated / line_original_length 标记；索引始终基于完整原始行。
 */
async function collectContentFileMatches(
  filePath: string,
  regexp: RegExp,
  signal?: AbortSignal,
): Promise<ContentLineMatch[]> {
  const lineMatches: ContentLineMatch[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let lineIndex = 1;

  try {
    for await (const line of reader) {
      if (signal?.aborted) {
        throw new Error(ERR_ABORTED);
      }

      const hits = collectLineMatches(regexp, line);

      if (hits.length > 0) {
        const lineTruncated = line.length > CONTENT_LINE_SUMMARY_LIMIT;
        const lineContent = lineTruncated
          ? line.slice(0, CONTENT_LINE_SUMMARY_LIMIT)
          : line;

        for (const hit of hits) {
          lineMatches.push({
            line_index: lineIndex,
            line_content: lineContent,
            match_start_index: hit.start + 1,
            match_end_index: hit.end,
            line_truncated: lineTruncated,
            line_original_length: line.length,
          });
        }
      }

      lineIndex += 1;
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return lineMatches;
}

/**
 * fs_search 主入口：文件内容搜索（纯文本逐行匹配，支持普通字面量与 JavaScript 正则）。
 * - directory 与 file_path 必须且只能传一个：directory 为全递归遍历的目录，file_path 为单个普通文件；
 * - content 为必填的匹配文本；regex 控制是否按正则编译；case_sensitive 控制是否区分大小写；
 * - 每条命中给出文件绝对路径、行号、行文本、命中起止字符位置与行截断信息，索引为 1 基且基于完整原始行；
 * - 单行超过 8192 字符仅输出前 8192 字符摘要，索引仍基于完整行；
 * - 二进制或不可读文件记入 skipped_content_files；不可访问路径记入 skipped_paths；
 * - 结果 JSON 序列化后超过 MAX_OUTPUT_LENGTH(16384) 字符时，仅保留前 16384 字符并标注截断。
 * 纯 Node fs 只读；仅支持本地文件系统。
 */
export async function fsSearch(
  input: unknown,
  context: ToolRuntimeContext,
): Promise<ToolResult> {
  const resolvedInput =
    input && typeof input === 'object' ? (input as FsSearchInput) : {};

  const contentText =
    resolvedInput.content === undefined || resolvedInput.content === null
      ? ''
      : String(resolvedInput.content);

  if (contentText.length === 0) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'content 必填：内容搜索的匹配文本不能为空',
    });
  }

  // 校验：directory 与 file_path 必须且只能传一个；directory 必须是已存在目录，file_path 必须是已存在普通文件
  const directoryRaw = normalizeString(resolvedInput.directory);
  const filePathRaw = normalizeString(resolvedInput.file_path);

  if (!directoryRaw && !filePathRaw) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message:
        'directory 与 file_path 必须二选一：directory 用于目录搜索，file_path 用于单文件搜索，二者不能同时为空',
    });
  }

  if (directoryRaw && filePathRaw) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message:
        'directory 与 file_path 不能同时传入：二者必须二选一，directory 用于目录搜索，file_path 用于单文件搜索',
    });
  }

  const directory = directoryRaw ? path.resolve(directoryRaw) : null;
  const targetFilePath = filePathRaw ? path.resolve(filePathRaw) : null;

  if (targetFilePath) {
    try {
      const targetStat = await stat(targetFilePath);

      if (!targetStat.isFile()) {
        return buildToolResult({
          success: false,
          code: ERR_PATH_NOT_FILE,
          message: '路径不是文件,请确认输入的file_path参数是否存在问题',
        });
      }
    } catch {
      return buildToolResult({
        success: false,
        code: ERR_FILE_NOT_FOUND,
        message: '文件不存在,请确认输入的file_path参数是否存在问题',
      });
    }
  } else if (directory) {
    try {
      const dirStat = await stat(directory);

      if (!dirStat.isDirectory()) {
        return buildToolResult({
          success: false,
          code: ERR_PATH_NOT_FILE,
          message: '路径不是目录,请确认输入的directory参数是否存在问题',
        });
      }
    } catch {
      return buildToolResult({
        success: false,
        code: ERR_FILE_NOT_FOUND,
        message: '目录不存在,请确认输入的directory参数是否存在问题',
      });
    }
  }

  const rootPath = (targetFilePath ?? directory) as string;
  const parsedRegex = parseBooleanOption(resolvedInput.regex);

  if (parsedRegex === null) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'regex 必须为布尔值（true/false）',
    });
  }

  const useRegex = parsedRegex ?? false;
  const parsedCaseSensitive = parseBooleanOption(resolvedInput.case_sensitive);

  if (parsedCaseSensitive === null) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'case_sensitive 必须为布尔值（true/false）',
    });
  }

  const caseSensitive = parsedCaseSensitive ?? false;
  const compiled = compileLinePattern(contentText, useRegex, caseSensitive);

  if ('error' in compiled) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: `content 正则表达式无效：${compiled.error}`,
    });
  }

  const regexp = compiled.regexp;
  const files: SearchFile[] = [];
  const skipped: string[] = [];

  /** 相对搜索根目录的相对路径，统一 '/' 分隔（Windows 反斜杠转换） */
  const toDisplayPath = (absolutePath: string): string => {
    const relativePath = path.relative(rootPath, absolutePath);

    if (relativePath === '') {
      return './';
    }

    return relativePath.split(path.sep).join('/');
  };

  const walk = async (dir: string): Promise<void> => {
    if (context.signal?.aborted) {
      throw new Error(ERR_ABORTED);
    }

    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const isDirectory = entry.isDirectory();

      try {
        await stat(full);
      } catch (error) {
        skipped.push(`${toDisplayPath(full)}: ${ensureErrorMessage(error)}`);
        continue;
      }

      if (isDirectory) {
        try {
          await walk(full);
        } catch (error) {
          const message = ensureErrorMessage(error);

          if (message === ERR_ABORTED) {
            throw error;
          }

          skipped.push(`${toDisplayPath(full)}: ${message}`);
          continue;
        }
      } else {
        files.push({ path: full });
      }
    }
  };

  const abortedMessage = targetFilePath ? '文件搜索已取消' : '目录搜索已取消';

  try {
    if (targetFilePath) {
      files.push({ path: targetFilePath });
    } else {
      await walk(rootPath);
    }
  } catch (error) {
    const message = ensureErrorMessage(error);

    if (message === ERR_ABORTED) {
      return buildToolResult({
        success: false,
        code: ERR_ABORTED,
        message: abortedMessage,
      });
    }

    return buildToolResult({
      success: false,
      code: ERR_FILE_NOT_FOUND,
      message: `目录搜索失败：${message}`,
    });
  }

  // 路径 codePoint 升序（确定性输出）
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const contentResults: ContentFileHit[] = [];
  const skippedContentFiles: SkippedContentFile[] = [];
  let totalHits = 0;

  for (const file of files) {
    if (context.signal?.aborted) {
      return buildToolResult({
        success: false,
        code: ERR_ABORTED,
        message: abortedMessage,
      });
    }

    try {
      if (await probeBinaryFile(file.path)) {
        skippedContentFiles.push({
          file_path: file.path,
          reason: 'binary',
        });
        continue;
      }

      const lineMatches = await collectContentFileMatches(
        file.path,
        regexp,
        context.signal,
      );

      if (lineMatches.length > 0) {
        contentResults.push({
          file_path: file.path,
          matches: lineMatches,
        });
        totalHits += lineMatches.length;
      }
    } catch (error) {
      const message = ensureErrorMessage(error);

      if (message === ERR_ABORTED) {
        return buildToolResult({
          success: false,
          code: ERR_ABORTED,
          message: abortedMessage,
        });
      }

      skippedContentFiles.push({
        file_path: file.path,
        reason: message,
      });
    }
  }

  const messageLines: string[] = [
    `内容搜索完成：命中 ${contentResults.length} 个文件、${totalHits} 处匹配。`,
  ];

  if (skippedContentFiles.length > 0) {
    messageLines.push(`已跳过 ${skippedContentFiles.length} 个二进制或不可读文件。`);
  }

  return truncateFsResultJson(
    buildToolResult({
      success: true,
      code: ERR_OK,
      message: messageLines.join('\n'),
      data: {
        index_base: 1,
        content_line_summary_limit: CONTENT_LINE_SUMMARY_LIMIT,
        match_file_count: contentResults.length,
        total_content_match_count: totalHits,
        content_results: contentResults,
        skipped_content_files: skippedContentFiles,
        skipped_paths: skipped,
      },
    }),
  );
}
