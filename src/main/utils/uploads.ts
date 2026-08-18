/**
 * 上传/沙箱 目录管理 + 输出文件清单
 *
 * P9 移植自 E:\\ai_fr lib/uploads.ts（去 userKey 多用户隔离层）
 */
import {
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  CONVERSATIONS_DIR_NAME,
  MANIFEST_FILE_NAME,
} from '../constants';
import {
  isPathInsideDir,
  resolveClientBinDir,
  resolveConversationDir,
  resolveOutputRootDir,
} from './storage-paths';

/** 解析 manifest 文件绝对路径:bin/conversations/{convId}/manifest.json */
function resolveConversationManifestPath(conversationId: string): string {
  const conversationDir = resolveConversationDir(conversationId);
  const manifestPath = path.join(conversationDir, MANIFEST_FILE_NAME);

  if (!isPathInsideDir(conversationDir, manifestPath)) {
    throw new Error('manifest path invalid');
  }

  return manifestPath;
}

interface ParsedManifestEntry {
  filePath: string;
  uploadedAt: string;
}

interface ParsedManifest {
  files: ParsedManifestEntry[];
}

function parseManifestContent(content: string): ParsedManifest {
  const parsed = JSON.parse(content) as { files?: unknown };

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray(parsed.files) ||
    parsed.files.some(
      (entry) =>
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as Record<string, unknown>).filePath !== 'string' ||
        typeof (entry as Record<string, unknown>).uploadedAt !== 'string',
    )
  ) {
    throw new Error('manifest format invalid');
  }

  return {
    files: (parsed.files as Array<Record<string, unknown>>).map((entry) => ({
      filePath: entry.filePath as string,
      uploadedAt: entry.uploadedAt as string,
    })),
  };
}

async function readConversationFileManifest(manifestPath: string): Promise<ParsedManifest> {
  try {
    return parseManifestContent(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { files: [] };
    }
    throw error;
  }
}
/**
 * 追加写入 manifest.json
 * - 路径:bin/conversations/{convId}/manifest.json
 * - 格式:JSON { files: [{ filePath, uploadedAt }, ...] }
 * - 文件去重（已存在的 filePath 不重复追加）
 * - 空 filePaths 直接返回,不写文件
 */
export async function appendConversationOutputFileManifest(
  conversationId: string,
  filePaths: string[],
): Promise<void> {
  if (filePaths.length === 0) {
    return;
  }

  const conversationDir = resolveConversationDir(conversationId);
  const manifestPath = resolveConversationManifestPath(conversationId);
  const manifest = await readConversationFileManifest(manifestPath);

  await mkdir(conversationDir, { recursive: true });

  const existingFilePaths = new Set(manifest.files.map((entry) => entry.filePath));
  const nowIso = new Date().toISOString();
  const newEntries: ParsedManifestEntry[] = [];
  for (const filePath of filePaths) {
    if (existingFilePaths.has(filePath)) continue;
    existingFilePaths.add(filePath);
    newEntries.push({ filePath, uploadedAt: nowIso });
  }

  if (newEntries.length === 0) {
    return;
  }

  const nextFiles: ParsedManifestEntry[] = [...manifest.files, ...newEntries];
  await writeFile(
    manifestPath,
    JSON.stringify({ files: nextFiles }, null, 2),
    'utf8',
  );
}
/**
 * 删除整个对话目录（含 uploads/ + tasks/ + manifest.json）
 * - 递归 rm -rf
 * - 防御性:目标必须在 bin/conversations/ 内
 */
export async function removeConversationUploadDir(conversationId: string): Promise<void> {
  const conversationDir = resolveConversationDir(conversationId);
  if (!isPathInsideDir(resolveClientBinDir(), conversationDir)) {
    throw new Error('conversation dir path invalid');
  }
  await rm(conversationDir, { recursive: true, force: true });
}

/**
 * 按 manifest 批量删除对话的输出文件 + manifest 自身
 * - 读 manifest.json 拿到 filePath 列表
 * - 校验 filePath 必须在 bin/output/ 内（防越权）
 * - 失败时静默跳过单个文件（最佳努力）
 * - 最后 rm manifest 自身
 */
export async function removeConversationOutputFiles(conversationId: string): Promise<void> {
  const manifestPath = resolveConversationManifestPath(conversationId);
  const outputRoot = resolveOutputRootDir();

  let manifest: ParsedManifest;
  try {
    manifest = await readConversationFileManifest(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  await Promise.all(
    manifest.files.map(async (entry) => {
      if (!path.isAbsolute(entry.filePath)) return;
      if (!isPathInsideDir(outputRoot, entry.filePath)) return;
      await rm(entry.filePath, { force: true }).catch(() => undefined);
    }),
  );

  await rm(manifestPath, { force: true }).catch(() => undefined);
}
/**
 * 扫描 conversations/ 目录,删除 SQLite 中无引用的孤儿会话目录
 *
 * 与 E:\\ai_fr lib/uploads.ts removeOrphanConversationUploadDirs 对齐,去 userKey 层:
 * - ai_fr 扫两层 userKey/conversationId;Delepi 单用户扫单层 conversationId
 * - 校验每个被删目录必须在 bin/conversations/ 内（防越权）
 */
export async function removeOrphanConversationUploadDirs(
  existingConversationIds: string[],
): Promise<string[]> {
  const conversationsRoot = path.join(resolveClientBinDir(), CONVERSATIONS_DIR_NAME);

  if (!isPathInsideDir(resolveClientBinDir(), conversationsRoot)) {
    throw new Error('conversations root path invalid');
  }

  const existingIdSet = new Set(existingConversationIds);
  const removed: string[] = [];

  let entries;
  try {
    entries = await readdir(conversationsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const conversationId = entry.name;
    const conversationDir = path.join(conversationsRoot, conversationId);

    if (existingIdSet.has(conversationId)) {
      continue;
    }

    if (!isPathInsideDir(conversationsRoot, conversationDir)) {
      continue;
    }

    await rm(conversationDir, { recursive: true, force: true });
    removed.push(conversationId);
  }

  return removed;
}
