import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { type ToolRuntimeContext } from './runtime-context';
import {
  buildToolResult,
  truncateLinesToLimit,
  type ToolResult,
} from './result';
import { normalizeString, ensureErrorMessage } from '../utils/index';
import {
  ERR_INVALID_ARGUMENT,
  ERR_FILE_NOT_FOUND,
  ERR_PATH_NOT_FILE,
  ERR_OK,
} from '../constants';

type FsSearchInput = {
  directory?: unknown;
  keyword?: unknown;
  depth?: unknown;
};

type FsSearchMatch = {
  path: string;
  type: 'file' | 'dir';
  size: number | null;
  mtime: string;
};

/** 解析 depth：未传/空 → undefined（默认 0）；0-3 整数 → 该值；其余 → null（非法） */
function parseDepth(value: unknown): number | null | undefined {
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = parseInt(value.trim(), 10);
    if (parsed <= 3) {
      return parsed;
    }
  }
  return null;
}

/**
 * fs_search 主入口：目录内按名称关键字搜索（DFS 递归，depth 0-3，默认 0 不递归）。
 * 纯 Node fs 只读；仅按名称包含匹配（'*' 表示全部）；结果按路径升序；不做条数/长度限制。
 */
export async function fsSearch(
  input: unknown,
  context: ToolRuntimeContext,
): Promise<ToolResult> {
  const resolvedInput =
    input && typeof input === 'object' ? (input as FsSearchInput) : {};

  // 校验：directory 必填且必须是存在的目录
  const directoryRaw = normalizeString(resolvedInput.directory);

  if (!directoryRaw) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'directory 必须为非空字符串（目录绝对路径）',
    });
  }

  const directory = path.resolve(directoryRaw);

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

  // keyword 空串/未传 → '*'（全部）；depth 默认 0（仅当前目录层，不递归），允许 0-3
  const keyword = normalizeString(resolvedInput.keyword) || '*';
  const parsedDepth = parseDepth(resolvedInput.depth);

  if (parsedDepth === null) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'depth 必须为 0-3 的整数',
    });
  }

  const depth = parsedDepth ?? 0;

  const keywordLower = keyword.toLowerCase();
  const matches: FsSearchMatch[] = [];
  const skipped: string[] = [];

/** 相对 source_dir 的相对路径，统一 '/' 分隔（Windows 反斜杠转换） */
  const toRelative = (absolutePath: string): string =>
  {
      let relative_path=path.relative(directory, absolutePath);
      if(relative_path==="")
      {
          return "./";
      }
      else
      {
         return relative_path.split(path.sep).join('/');
      }
  }
    

  const walk = async (dir: string, level: number): Promise<void> => {
    if (context.signal?.aborted) {
      throw new Error('ABORTED');
    }

    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (keyword === '*' || entry.name.toLowerCase().includes(keywordLower)) {
        try {
          const entryStat = await stat(full);

          matches.push({
            path: full,
            type: entry.isDirectory() ? 'dir' : 'file',
            size: entry.isDirectory() ? null : entryStat.size,
            mtime: entryStat.mtime.toISOString(),
          });
        } catch (error) {
          skipped.push(`${toRelative(full)}: ${ensureErrorMessage(error)}`);
          continue;
        }
      }

      if (entry.isDirectory() && level < depth) {
        try {
          await walk(full, level + 1);
        } catch (error) {
          const message = ensureErrorMessage(error);

          if (message === 'ABORTED') {
            throw error;
          }

          skipped.push(`${toRelative(full)}: ${message}`);
          continue;
        }
      }
    }
  };

  try {
    await walk(directory, 0);
  } catch (error) {
    const message = ensureErrorMessage(error);

    if (message === 'ABORTED') {
      return buildToolResult({
        success: false,
        code: 'ABORTED',
        message: '目录搜索已取消',
      });
    }

    return buildToolResult({
      success: false,
      code: ERR_FILE_NOT_FOUND,
      message: `目录搜索失败：${message}`,
    });
  }

  // 路径 codePoint 升序（确定性输出）
  matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  
  const stdoutLines = matches.map(
    (m) => `\`${toRelative(m.path)}\` | ${m.type} | ${m.size === null ? '-' : `${m.size}B`} | ${m.mtime}`,
  );

  const fileCount = matches.filter((m) => m.type === 'file').length;
  const dirCount = matches.length - fileCount;

  const message = `
- 共匹配 ${matches.length} 项（文件 ${fileCount}，目录 ${dirCount}）${skipped.length ? `，跳过 ${skipped.length} 个无法访问的路径` : ''};
- 【search_results】包含的【所有路径类型的信息】均为相对于【source_dir】的路径，**对外使用请务必拼接成绝对路径使用**。`;
  return buildToolResult({
    success: true,
    code: ERR_OK,
    message,
    data: {
      search_keyword:keyword,
      search_depth:depth,
      source_dir: directory,
      match_count: matches.length,
      match_file_count: fileCount,
      match_dir_count: dirCount,
      search_results: truncateLinesToLimit(stdoutLines),
    },
  });
}
