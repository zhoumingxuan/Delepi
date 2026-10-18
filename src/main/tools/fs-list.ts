import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { type ToolRuntimeContext } from './runtime-context';
import { buildToolResult, type ToolResult } from './result';
import { ensureErrorMessage } from '../utils/index';
import {
  ERR_ABORTED,
  ERR_INVALID_ARGUMENT,
  ERR_FILE_NOT_FOUND,
  ERR_PATH_NOT_FILE,
  ERR_OK,
} from '../constants';

type FsListInput = {
  directory?: unknown;
  depth?: unknown;
};

type FsListEntry = {
  path: string;
  name: string;
  type: 'file' | 'dir';
  size_bytes: number | null;
  mtime: string;
};

/** 解析 depth：未传/null/空串 → undefined（默认 0）；0-3 整数 → 该值；其余 → null（非法） */
function parseDepth(value: unknown): number | null | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return undefined;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3) {
    return value;
  }
  return null;
}

/** 按 codePoint 升序比较（确定性排序；不使用 UTF-16 code unit 顺序） */
function compareByCodePoint(a: string, b: string): number {
  const aPoints = Array.from(a, (char) => char.codePointAt(0) as number);
  const bPoints = Array.from(b, (char) => char.codePointAt(0) as number);
  const length = Math.min(aPoints.length, bPoints.length);

  for (let index = 0; index < length; index += 1) {
    if (aPoints[index] !== bPoints[index]) {
      return aPoints[index] - bPoints[index];
    }
  }

  return aPoints.length - bPoints.length;
}

/**
 * fs_list 主入口：对【目标目录】做有限深度递归遍历，列举全部文件与目录条目。
 * - directory 必填：必须是已存在的目录绝对路径（不接受文件路径）；
 * - depth 0-3（默认 0）：depth=0 只列当前一层，depth=1 列出子目录内一层，依此类推；
 * - entries 每项固定 5 字段：path/name/type/size_bytes/mtime，按 path 的 codePoint 升序排序；
 * - 无法访问的条目记入 skipped_paths（relativePath: 错误信息）并跳过，不中断整体列举；
 * - 结果条数与 JSON 字符串长度均不做任何截断（不调用任何输出截断工具函数）。
 * 纯 Node fs 只读；仅支持本地文件系统。
 */
export async function fsList(
  input: unknown,
  context: ToolRuntimeContext,
): Promise<ToolResult> {
  const resolvedInput =
    input && typeof input === 'object' ? (input as FsListInput) : {};

  if (context.signal?.aborted) {
    return buildToolResult({
      success: false,
      code: ERR_ABORTED,
      message: '目录列举已取消',
    });
  }

  const directoryRaw =
    typeof resolvedInput.directory === 'string' ? resolvedInput.directory.trim() : '';

  if (!directoryRaw) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'directory 必填：要列举的【目标目录】绝对路径',
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

  const parsedDepth = parseDepth(resolvedInput.depth);

  if (parsedDepth === null) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'depth 必须为 0-3 的整数',
    });
  }

  const depth = parsedDepth ?? 0;
  const entries: FsListEntry[] = [];
  const skippedPaths: string[] = [];

  /** 相对 directory 的相对路径，统一 '/' 分隔（Windows 反斜杠转换；空串转 './'） */
  const toRelative = (absolutePath: string): string => {
    const relativePath = path.relative(directory, absolutePath);

    if (relativePath === '') {
      return './';
    }

    return relativePath.split(path.sep).join('/');
  };

  const walk = async (dir: string, level: number): Promise<void> => {
    if (context.signal?.aborted) {
      throw new Error(ERR_ABORTED);
    }

    const dirents = await readdir(dir, { withFileTypes: true });

    for (const entry of dirents) {
      if (context.signal?.aborted) {
        throw new Error(ERR_ABORTED);
      }

      const full = path.join(dir, entry.name);
      const isDirectory = entry.isDirectory();

      try {
        const entryStat = await stat(full);

        entries.push({
          path: full,
          name: entry.name,
          type: isDirectory ? 'dir' : 'file',
          size_bytes: isDirectory ? null : entryStat.size,
          mtime: entryStat.mtime.toISOString(),
        });
      } catch (error) {
        skippedPaths.push(`${toRelative(full)}: ${ensureErrorMessage(error)}`);
        continue;
      }

      if (isDirectory && level < depth) {
        try {
          await walk(full, level + 1);
        } catch (error) {
          const message = ensureErrorMessage(error);

          if (message === ERR_ABORTED) {
            throw error;
          }

          skippedPaths.push(`${toRelative(full)}: ${message}`);
        }
      }
    }
  };

  try {
    await walk(directory, 0);
  } catch (error) {
    const message = ensureErrorMessage(error);

    if (message === ERR_ABORTED) {
      return buildToolResult({
        success: false,
        code: ERR_ABORTED,
        message: '目录列举已取消',
      });
    }

    return buildToolResult({
      success: false,
      code: ERR_FILE_NOT_FOUND,
      message: `目录列举失败：${message}`,
    });
  }

  // path 的 codePoint 升序（确定性输出）
  entries.sort((a, b) => compareByCodePoint(a.path, b.path));

  const totalCount = entries.length;
  const fileCount = entries.filter((item) => item.type === 'file').length;
  const dirCount = totalCount - fileCount;

  return buildToolResult({
    success: true,
    code: ERR_OK,
    message: `- 目录列举完成：共 ${totalCount} 项（文件 ${fileCount}，目录 ${dirCount}）。`,
    data: {
      total_count: totalCount,
      file_count: fileCount,
      dir_count: dirCount,
      entries,
      skipped_paths: skippedPaths,
    },
  });
}
