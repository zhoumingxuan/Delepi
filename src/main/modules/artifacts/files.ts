import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface InspectedFile {
  path: string; contentHash: string; sizeBytes: number; dev: number; ino: number;
  bytes?: Buffer;
}

export function assertLocalAbsolutePath(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error('ARTIFACT_PATH_INVALID');
  }
  return path.resolve(value);
}

/** Refuse link targets and link ancestors; this is a document boundary, not a Shell sandbox. */
export async function assertNoSymlinks(value: string): Promise<string> {
  const absolute = assertLocalAbsolutePath(value);
  let current = absolute;
  for (;;) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error('ARTIFACT_SYMLINK_DENIED');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return realpath(absolute);
}

export async function inspectArtifactFile(value: string, options: { readBytes?: boolean; maxBytes?: number } = {}): Promise<InspectedFile> {
  const absolute = assertLocalAbsolutePath(value);
  const canonical = await assertNoSymlinks(absolute);
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('ARTIFACT_NOT_REGULAR_FILE');
    if (options.maxBytes !== undefined && before.size > options.maxBytes) throw new Error('ARTIFACT_PREVIEW_TOO_LARGE');
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of handle.createReadStream({ autoClose: false })) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.length;
      if (options.maxBytes !== undefined && size > options.maxBytes) throw new Error('ARTIFACT_PREVIEW_TOO_LARGE');
      hash.update(chunk);
      if (options.readBytes) chunks.push(chunk);
    }
    const after = await handle.stat();
    const current = await lstat(canonical);
    if (current.isSymbolicLink() || before.dev !== current.dev || before.ino !== current.ino
      || before.size !== size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || await assertNoSymlinks(absolute) !== canonical) {
      throw new Error('ARTIFACT_IDENTITY_CHANGED');
    }
    return { path: canonical, contentHash: hash.digest('hex'), sizeBytes: size, dev: before.dev, ino: before.ino,
      ...(options.readBytes ? { bytes: Buffer.concat(chunks) } : {}) };
  } finally {
    await handle.close();
  }
}
