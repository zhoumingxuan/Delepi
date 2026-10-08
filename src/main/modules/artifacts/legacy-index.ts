import { lstat, opendir } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveOutputRootDir } from '../../utils/storage-paths';
import { assertNoSymlinks } from './files';

export interface LegacyArtifactIndexResult {
  scanned: number; indexed: number; skipped: number; errors: number; done: boolean; nextCursor?: string;
}
interface IndexSession {
  root: string; dev: number; ino: number; pending: Array<{ path: string; depth: number }>;
  directory?: Dir; currentDepth: number; expires: number; busy: boolean;
}
const LEGACY_TYPES = new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.html', '.htm', '.pdf',
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);

/** Server-held cursors contain no renderer-selected paths; never moves or edits legacy files. */
export function createLegacyArtifactIndexer(register: (sourcePath: string) => Promise<unknown>, rootResolver = resolveOutputRootDir) {
  const sessions = new Map<string, IndexSession>();
  return async function index(options: { cursor?: string; limit?: number } = {}): Promise<LegacyArtifactIndexResult> {
    const result: LegacyArtifactIndexResult = { scanned: 0, indexed: 0, skipped: 0, errors: 0, done: false };
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 200)));
    for (const [key, session] of sessions) if (session.expires < Date.now() && !session.busy) {
      await session.directory?.close().catch(() => undefined); sessions.delete(key);
    }
    let token = options.cursor; let session = token ? sessions.get(token) : undefined;
    if (token && !session) throw new Error('ARTIFACT_INDEX_CURSOR_EXPIRED');
    if (!session) {
      if (sessions.size >= 8) throw new Error('ARTIFACT_INDEX_BUSY');
      let root: string;
      try { root = await assertNoSymlinks(rootResolver()); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...result, done: true }; throw error; }
      const stat = await lstat(root);
      if (!stat.isDirectory()) throw new Error('ARTIFACT_INDEX_ROOT_INVALID');
      token = randomUUID();
      session = { root, dev: stat.dev, ino: stat.ino, pending: [{ path: root, depth: 0 }],
        currentDepth: 0, expires: Date.now() + 10 * 60 * 1000, busy: false };
      sessions.set(token, session);
    }
    if (session.busy) throw new Error('ARTIFACT_INDEX_BUSY');
    session.busy = true;
    try {
      const root = await assertNoSymlinks(rootResolver()); const stat = await lstat(root);
      if (root !== session.root || stat.dev !== session.dev || stat.ino !== session.ino) throw new Error('ARTIFACT_INDEX_ROOT_CHANGED');
      let readBytes = 0;
      while (result.scanned < limit && readBytes < 100 * 1024 * 1024) {
        if (!session.directory) {
          const next = session.pending.shift();
          if (!next) { result.done = true; break; }
          try {
            const canonical = await assertNoSymlinks(next.path);
            const relative = path.relative(session.root, canonical);
            if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('ARTIFACT_INDEX_OUTSIDE_ROOT');
            session.directory = await opendir(canonical); session.currentDepth = next.depth;
          } catch { result.errors++; result.scanned++; continue; }
        }
        const entry = await session.directory.read();
        if (!entry) { await session.directory.close(); session.directory = undefined; continue; }
        result.scanned++;
        const filePath = path.join(session.directory.path, entry.name);
        if (entry.isSymbolicLink()) { result.skipped++; continue; }
        if (entry.isDirectory()) {
          if (session.currentDepth < 6 && session.pending.length < 2000 && !['.app', '.bundle', '.framework'].includes(path.extname(entry.name).toLowerCase())) {
            session.pending.push({ path: filePath, depth: session.currentDepth + 1 });
          } else result.skipped++;
          continue;
        }
        if (!entry.isFile() || !LEGACY_TYPES.has(path.extname(entry.name).toLowerCase())) { result.skipped++; continue; }
        try {
          const fileStat = await lstat(filePath);
          if (fileStat.isSymbolicLink() || !fileStat.isFile() || (fileStat.mode & 0o111) !== 0
            || fileStat.size > 50 * 1024 * 1024) { result.skipped++; continue; }
          readBytes += fileStat.size;
          await register(filePath); result.indexed++;
        } catch { result.errors++; }
      }
      session.expires = Date.now() + 10 * 60 * 1000;
      if (result.done) sessions.delete(token!);
      else result.nextCursor = token;
      return result;
    } catch (error) {
      await session.directory?.close().catch(() => undefined); sessions.delete(token!);
      throw error;
    } finally { session.busy = false; }
  };
}
