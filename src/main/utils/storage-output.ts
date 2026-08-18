/**
 * 存储输出工具
 * 简化版：local模式
 */

import path from 'node:path';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { sanitizeFilename } from './storage-paths';
import { appendConversationOutputFileManifest } from './uploads';

/**
 * 解析唯一输出路径（避免覆盖）
 */
export async function resolveUniqueOutputPath(
  outputDir: string,
  filename: string,
): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);

  // 先尝试原始文件名
  let candidatePath = path.join(outputDir, filename);
  let counter = 1;

  while (true) {
    try {
      await stat(candidatePath);
      // 文件存在，生成新名称
      candidatePath = path.join(outputDir, `${base}(${counter})${ext}`);
      counter += 1;
    } catch {
      // 文件不存在，可用
      return candidatePath;
    }
  }
}

export async function copyFileToOutputDir(
  sourcePath: string,
  outputDir: string | undefined,
): Promise<string> {
  if (!sourcePath || !outputDir) {
    return sourcePath;
  }

  const resolvedSource = path.resolve(sourcePath);
  const resolvedOutputDir = path.resolve(outputDir);
  const relativeToOutput = path.relative(resolvedOutputDir, resolvedSource);

  if (relativeToOutput && !relativeToOutput.startsWith('..') && !path.isAbsolute(relativeToOutput)) {
    return resolvedSource;
  }

  const sourceStat = await stat(resolvedSource);
  if (!sourceStat.isFile()) {
    return sourcePath;
  }

  await mkdir(resolvedOutputDir, { recursive: true });
  const targetPath = await resolveUniqueOutputPath(
    resolvedOutputDir,
    sanitizeFilename(path.basename(resolvedSource)),
  );
  await copyFile(resolvedSource, targetPath);
  return targetPath;
}

export async function copyFilesToOutputDir(
  sourcePaths: string[],
  outputDir: string | undefined,
  options?: { conversationId?: string },
): Promise<string[]> {
  const outputPaths: string[] = [];

  for (const sourcePath of sourcePaths) {
    outputPaths.push(await copyFileToOutputDir(sourcePath, outputDir));
  }

  // P9: 追加写入 manifest.json(沿用 ai_fr appendConversationOutputFileManifest)
  //   - 仅当传入了 conversationId 时才写入(向后兼容)
  //   - 文件去重由 appendConversationOutputFileManifest 内部处理
  if (options?.conversationId && outputPaths.length > 0) {
    await appendConversationOutputFileManifest(
      options.conversationId,
      outputPaths,
    );
  }

  return outputPaths;
}
