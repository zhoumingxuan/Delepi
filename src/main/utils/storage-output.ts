/**
 * 存储输出工具
 * 简化版：local模式
 */

import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { appendConversationOutputFileManifest } from './uploads';
import { publishArtifactFile, registerExistingArtifact, type ArtifactCopyOptions } from '../modules/artifacts/service';

export type { ArtifactCopyOptions } from '../modules/artifacts/service';

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
      await lstat(candidatePath);
      // 文件存在，生成新名称
      candidatePath = path.join(outputDir, `${base}(${counter})${ext}`);
      counter += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // 文件不存在，可用
      return candidatePath;
    }
  }
}

export async function copyFileToOutputDir(
  sourcePath: string,
  outputDir: string | undefined,
  options?: ArtifactCopyOptions,
): Promise<string> {
  return publishArtifactFile(sourcePath, outputDir, options);
}

/** Read-only registration keeps legacy/direct deliverables in place. */
export async function registerExistingArtifactOutput(sourcePath: string, options?: ArtifactCopyOptions): Promise<string> {
  return (await registerExistingArtifact(sourcePath, options)).path;
}

export async function copyFilesToOutputDir(
  sourcePaths: string[],
  outputDir: string | undefined,
  options?: ArtifactCopyOptions & { conversationId?: string },
): Promise<string[]> {
  const outputPaths: string[] = [];

  for (const sourcePath of sourcePaths) {
    outputPaths.push(await copyFileToOutputDir(sourcePath, outputDir, options));
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
