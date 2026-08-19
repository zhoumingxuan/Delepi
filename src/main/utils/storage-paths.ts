/**
 * 存储路径工具
 * 简化版：local模式
 */

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { app } from 'electron';
import {
  BIN_DIR_NAME,
  CONVERSATIONS_DIR_NAME,
  OUTPUT_DIR_NAME,
  UPLOADS_DIR_NAME,
} from '../constants';

/** 客户端本地数据根目录（写死，不可配置） */
export function resolveClientBinDir(): string {
  const isDev = !app.isPackaged;
  return path.join(isDev ? process.cwd() : app.getPath('userData'), BIN_DIR_NAME);
}

/** 对话存储根目录（写死，不可配置） */
export function resolveConversationsRootDir(): string {
  return path.join(resolveClientBinDir(), CONVERSATIONS_DIR_NAME);
}

/** 独立输出文件根目录（写死，不可配置） */
export function resolveOutputRootDir(): string {
  return path.join(resolveClientBinDir(), OUTPUT_DIR_NAME);
}

/** 按年月分隔的输出目录 */
export function resolveMonthlyOutputDir(date = new Date()): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');

  return path.join(resolveOutputRootDir(), year, month);
}

/** 单次执行任务临时协议目录（summary.md / image_files.json 等最终输出协议文件） */
export function resolveTaskWorkspaceDir(conversationId: string, taskId: string): string {
  return path.join(resolveConversationDir(conversationId), 'tasks', taskId);
}

/** 净化文件名 */
export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .trim() || 'untitled';
}

/** 确保目录存在 */

/** 解析对话目录（per-conversation） */
export function resolveConversationDir(conversationId: string): string {
  return path.join(resolveConversationsRootDir(), conversationId);
}

/** 解析对话上传目录 */
export function resolveConversationUploadDir(conversationId: string): string {
  return path.join(resolveConversationDir(conversationId), UPLOADS_DIR_NAME);
}

export function normalizeStorageKey(storageKey: string): string {
  return storageKey.replace(/\\/g, '/').replace(/^\/+/, '');
}

export function buildConversationUploadStorageKey(
  conversationId: string,
  filename: string,
): string {
  return normalizeStorageKey(path.join(
    CONVERSATIONS_DIR_NAME,
    conversationId,
    UPLOADS_DIR_NAME,
    filename,
  ));
}

/**
 * 判断目标路径是否位于指定目录内(防止越权删除/越权读取)
 * 镜像 E:\ai_fr lib/utils/storage-paths.ts isPathInsideDir
 * - 用 path.resolve 规范化两端
 * - targetPath 必须严格位于 rootDir 之内(不等于 rootDir)
 */
export function isPathInsideDir(rootDir: string, targetPath: string): boolean {
  const rootPath = path.resolve(rootDir);
  const absolutePath = path.resolve(targetPath);

  return absolutePath !== rootPath && absolutePath.startsWith(rootPath + path.sep);
}

/** 判断 storageKey 是否属于指定对话的 uploads/ 目录 */
export function isConversationUploadStorageKey(
  conversationId: string,
  storageKey: string,
): boolean {
  const normalized = normalizeStorageKey(storageKey);
  // 兼容绝对路径输入（message 附件持久化为绝对路径）：剥离客户端 bin 前缀后再校验
  const binPrefix = `${normalizeStorageKey(resolveClientBinDir())}/`;
  const relativeKey = normalized.startsWith(binPrefix)
    ? normalized.slice(binPrefix.length)
    : normalized;
  return relativeKey.startsWith(
    `${CONVERSATIONS_DIR_NAME}/${conversationId}/${UPLOADS_DIR_NAME}/`,
  );
}

export function resolveStoragePath(storageKey: string): string {
  // 兼容绝对路径输入（message 附件持久化为绝对路径后直接返回，不再拼接 bin）
  if (path.isAbsolute(storageKey)) {
    return storageKey;
  }
  const normalizedStorageKey = normalizeStorageKey(storageKey);
  return path.join(resolveClientBinDir(), normalizedStorageKey);
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}
