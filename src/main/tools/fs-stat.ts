import type { Stats } from 'node:fs';
import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { type ToolRuntimeContext } from './runtime-context';
import { buildToolResult, type ToolResult } from './result';
import { ensureErrorMessage } from '../utils/index';
import {
  ERR_ABORTED,
  ERR_INVALID_ARGUMENT,
  ERR_FILE_NOT_FOUND,
  ERR_FILE_READ_ERROR,
  ERR_OK,
} from '../constants';

type FsStatInput = {
  path?: unknown;
};

type FsStatPathType = 'file' | 'dir' | 'symlink' | 'other';
type FsStatTargetType = 'file' | 'dir' | 'other' | null;

/** 把 errno 错误码映射为工具错误码与文案（lstat 与目录子项读取共用同一套分支口径） */
function buildFsStatErrorResult(error: unknown): ToolResult {
  const errnoCode =
    error && typeof error === 'object' && typeof (error as NodeJS.ErrnoException).code === 'string'
      ? ((error as NodeJS.ErrnoException).code as string)
      : '';

  if (errnoCode === 'ENOENT' || errnoCode === 'ENOTDIR') {
    return buildToolResult({
      success: false,
      code: ERR_FILE_NOT_FOUND,
      message: '路径不存在,请确认输入的path参数是否存在问题',
    });
  }

  if (errnoCode === 'EACCES' || errnoCode === 'EPERM') {
    return buildToolResult({
      success: false,
      code: ERR_FILE_READ_ERROR,
      message: '无权限访问该路径,请确认当前运行环境的访问权限',
    });
  }

  if (errnoCode === 'ELOOP') {
    return buildToolResult({
      success: false,
      code: ERR_FILE_READ_ERROR,
      message: '符号链接层级过深或存在循环,无法解析该路径',
    });
  }

  return buildToolResult({
    success: false,
    code: ERR_FILE_READ_ERROR,
    message: `路径信息读取失败：${ensureErrorMessage(error)}`,
  });
}

/** 判定路径自身的类型（lstat 口径：不跟随符号链接，符号链接优先于文件/目录判定） */
function resolvePathType(stats: Stats): FsStatPathType {
  if (stats.isSymbolicLink()) {
    return 'symlink';
  }

  if (stats.isFile()) {
    return 'file';
  }

  if (stats.isDirectory()) {
    return 'dir';
  }

  return 'other';
}

/** 判定符号链接指向对象的类型（跟随符号链接口径） */
function resolveTargetType(stats: Stats): Exclude<FsStatTargetType, null> {
  if (stats.isFile()) {
    return 'file';
  }

  if (stats.isDirectory()) {
    return 'dir';
  }

  return 'other';
}

/**
 * fs_stat 主入口：查询单个【文件或目录】路径自身的属性明细。
 * - type 只描述路径自身（lstat 口径，不跟随符号链接），取值为 file / dir / symlink / other；
 * - data 的字段随 type 裁剪：不适用于该类型的字段【不出现】，而不是出现后取值为 null；
 *   · file（12 项）：platform、type、size_bytes、real_path、mode、readonly、uid、gid 与四个时间字段；
 *   · dir（12 项）：把 file 的 size_bytes 换成 child_count，其余与 file 相同；
 *   · symlink（14 项）：file 的 size_bytes 之后插入 link_target，real_path 之后插入 target_type；
 *   · other（11 项）：与 file 相同但去掉 size_bytes。
 * - size_bytes 只有 file 与 symlink 有该字段，取 lstat.size（字节数）；
 * - child_count 只有 dir 有该字段，为直接子项数量（只读一层目录，不递归、不对子项取属性），目录不可读时为 null；
 * - link_target 与 target_type 只有 symlink 有这两个字段，解析失败时各自为 null；
 * - mode 为权限位的三位八进制文本，readonly 表示所属用户是否不可写；
 * - uid / gid 不参与类型裁剪（四种类型都保留），仅在 POSIX 平台有效，Windows 平台恒为 null；
 * - created_time 在文件系统不提供创建时间（birthtimeMs <= 0）时为 null；
 * - real_path 四种类型都尝试解析，失败为 null。
 * 纯 Node 标准模块只读实现；仅支持本地文件系统，支持 context.signal 取消。
 */
export async function fsStat(
  input: unknown,
  context: ToolRuntimeContext,
): Promise<ToolResult> {
  const resolvedInput =
    input && typeof input === 'object' ? (input as FsStatInput) : {};

  if (context.signal?.aborted) {
    return buildToolResult({
      success: false,
      code: ERR_ABORTED,
      message: '路径信息查询已取消',
    });
  }

  const pathRaw =
    typeof resolvedInput.path === 'string' ? resolvedInput.path.trim() : '';

  if (!pathRaw) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'path 必填：要查询的【目标文件或目录】绝对路径',
    });
  }

  if (!path.isAbsolute(pathRaw)) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message:
        'path 必须为绝对路径：请提供当前运行平台可识别的绝对路径（Windows 形如 E:\\dir\\file，POSIX 形如 /dir/file）',
    });
  }

  const targetPath = path.resolve(pathRaw);

  try {
    const stats = await lstat(targetPath);
    const type = resolvePathType(stats);
    const isSymlink = type === 'symlink';
    const hasSizeBytes = type === 'file' || isSymlink;

    let childCount: number | null = null;

    if (type === 'dir') {
      try {
        const children = await readdir(targetPath);
        childCount = children.length;
      } catch {
        childCount = null;
      }
    }

    let linkTarget: string | null = null;

    if (type === 'symlink') {
      try {
        linkTarget = await readlink(targetPath);
      } catch {
        linkTarget = null;
      }
    }

    let realPath: string | null = null;

    try {
      realPath = await realpath(targetPath);
    } catch {
      realPath = null;
    }

    let targetType: FsStatTargetType = null;

    if (type === 'symlink') {
      try {
        targetType = resolveTargetType(await stat(targetPath));
      } catch {
        targetType = null;
      }
    }

    // 字段随 type 裁剪：不适用于该类型的键直接不出现（不是出现后置为 null）
    const data: Record<string, unknown> = {
      platform: process.platform,
      type,
      ...(hasSizeBytes ? { size_bytes: stats.size } : {}),
      ...(type === 'dir' ? { child_count: childCount } : {}),
      ...(isSymlink ? { link_target: linkTarget } : {}),
      real_path: realPath,
      ...(isSymlink ? { target_type: targetType } : {}),
      mode: (stats.mode & 0o777).toString(8).padStart(3, '0'),
      readonly: (stats.mode & 0o200) === 0,
      uid: process.platform === 'win32' ? null : stats.uid,
      gid: process.platform === 'win32' ? null : stats.gid,
      created_time:
        stats.birthtimeMs > 0 ? stats.birthtime.toISOString() : null,
      modified_time: stats.mtime.toISOString(),
      accessed_time: stats.atime.toISOString(),
      changed_time: stats.ctime.toISOString(),
    };

    return buildToolResult({
      success: true,
      code: ERR_OK,
      message: `- 路径信息查询完成：${type}`,
      data,
    });
  } catch (error) {
    return buildFsStatErrorResult(error);
  }
}
