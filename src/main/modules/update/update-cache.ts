/**
 * 客户端自动更新：下载缓存、.part 生命周期、启动扫描与清理
 *
 * 目录布局：<bin>/updates/<version>/<fileName>
 *           <bin>/updates/<version>/<fileName>.part
 *           <bin>/updates/<version>/.meta.json
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  UPDATE_PACKAGE_META_FILE_NAME,
  UPDATE_PART_FILE_SUFFIX,
} from '@shared/update-constants';
import { resolveUpdateDir } from '../../utils/storage-paths';
import { STALE_PART_MAX_AGE_MS } from './update-defaults';
import { compareUpdateVersion } from './update-version';
import { writeUpdateLog } from './update-log';

export interface CachedUpdatePackage {
  version: string;
  fileName: string;
  size: number;
  sha256: string;
  filePath: string;
  dir: string;
  baseUrlHost: string;
  downloadedAt: string;
}

interface PackageMeta {
  version: string;
  fileName: string;
  size: number;
  sha256: string;
  baseUrlHost: string;
  downloadedAt: string;
}

const SAFE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const SAFE_FILE_NAME_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,199}$/;
const ALLOWED_PACKAGE_EXTENSIONS = new Set(['.exe', '.dmg', '.appimage']);

/** 版本号白名单（禁止 `..` 与路径分隔符，防止路径穿越） */
export function isSafeUpdateVersion(value: string): boolean {
  return typeof value === 'string'
    && SAFE_VERSION_RE.test(value)
    && !value.includes('..')
    && !value.includes('/')
    && !value.includes('\\');
}

/** 安装包文件名白名单（只允许单段文件名 + 三平台扩展名） */
export function isSafePackageFileName(value: string): boolean {
  if (typeof value !== 'string' || !value || path.basename(value) !== value) {
    return false;
  }
  if (!SAFE_FILE_NAME_RE.test(value) || value.includes('..')) {
    return false;
  }
  return ALLOWED_PACKAGE_EXTENSIONS.has(path.extname(value).toLowerCase());
}

export async function ensureUpdateDir(): Promise<string> {
  const dir = resolveUpdateDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

export function resolveVersionDir(version: string): string {
  return path.join(resolveUpdateDir(), version);
}

export function resolvePackagePath(version: string, fileName: string): string {
  return path.join(resolveVersionDir(version), fileName);
}

export function resolvePackagePartPath(version: string, fileName: string): string {
  return `${resolvePackagePath(version, fileName)}${UPDATE_PART_FILE_SUFFIX}`;
}

export function resolvePackageMetaPath(version: string): string {
  return path.join(resolveVersionDir(version), UPDATE_PACKAGE_META_FILE_NAME);
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function readPackageMeta(version: string): Promise<PackageMeta | null> {
  try {
    const raw = await readFile(resolvePackageMetaPath(version), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PackageMeta>;
    if (parsed.version !== version) {
      return null;
    }
    if (typeof parsed.fileName !== 'string' || !isSafePackageFileName(parsed.fileName)) {
      return null;
    }
    if (typeof parsed.size !== 'number' || !Number.isSafeInteger(parsed.size) || parsed.size <= 0) {
      return null;
    }
    if (typeof parsed.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(parsed.sha256)) {
      return null;
    }
    if (typeof parsed.baseUrlHost !== 'string' || typeof parsed.downloadedAt !== 'string') {
      return null;
    }
    return {
      version,
      fileName: parsed.fileName,
      size: parsed.size,
      sha256: parsed.sha256.toLowerCase(),
      baseUrlHost: parsed.baseUrlHost,
      downloadedAt: parsed.downloadedAt,
    };
  } catch {
    return null;
  }
}

/**
 * 启动扫描：逐个版本目录复算元数据与 SHA-256。
 * - 元数据缺失/非法、文件缺失、字节数不符、哈希不符 → 整目录删除（含 .part 残留与元数据）；
 * - 全部合法 → 只保留版本号最高的一个，其余删除；
 * - updates/ 根目录下超过 24h 的 .part → 删除。
 */
export async function scanCachedPackages(): Promise<CachedUpdatePackage[]> {
  const root = resolveUpdateDir();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  const valid: CachedUpdatePackage[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (!entry.isDirectory()) {
      if (entry.name.endsWith(UPDATE_PART_FILE_SUFFIX)) {
        const info = await stat(entryPath).catch(() => null);
        if (info && now - info.mtimeMs > STALE_PART_MAX_AGE_MS) {
          await rm(entryPath, { force: true }).catch(() => undefined);
        }
      }
      continue;
    }

    if (!isSafeUpdateVersion(entry.name)) {
      await rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
      writeUpdateLog('WARN', 'update.cache.purge', { version: 'invalid', reason: 'unsafe_version' });
      continue;
    }

    const meta = await readPackageMeta(entry.name);
    if (!meta) {
      await rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
      writeUpdateLog('WARN', 'update.cache.purge', { version: entry.name, reason: 'meta_missing' });
      continue;
    }

    const filePath = resolvePackagePath(entry.name, meta.fileName);
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile() || info.size !== meta.size) {
      await rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
      writeUpdateLog('WARN', 'update.cache.purge', { version: entry.name, reason: 'size_mismatch' });
      continue;
    }

    const digest = await sha256File(filePath).catch(() => '');
    if (!digest || digest.toLowerCase() !== meta.sha256) {
      await rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
      writeUpdateLog('WARN', 'update.cache.purge', { version: entry.name, reason: 'hash_mismatch' });
      continue;
    }

    // 合法目录内的 .part 一律视为上次中断残留（启动时没有在途下载）
    const children = await readdir(entryPath, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (child.isFile() && child.name.endsWith(UPDATE_PART_FILE_SUFFIX)) {
        await unlink(path.join(entryPath, child.name)).catch(() => undefined);
      }
    }

    valid.push({
      version: entry.name,
      fileName: meta.fileName,
      size: meta.size,
      sha256: meta.sha256,
      filePath,
      dir: entryPath,
      baseUrlHost: meta.baseUrlHost,
      downloadedAt: meta.downloadedAt,
    });
  }

  valid.sort((left, right) => compareUpdateVersion(right.version, left.version));
  for (let index = 1; index < valid.length; index += 1) {
    await rm(valid[index].dir, { recursive: true, force: true }).catch(() => undefined);
    writeUpdateLog('INFO', 'update.cache.purge', { version: valid[index].version, reason: 'older_than_kept' });
  }
  return valid;
}

/** 清理全部缓存（版本目录 + .part + .meta.json） */
export async function purgeCachedPackages(): Promise<number> {
  const root = resolveUpdateDir();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
      removed += 1;
      continue;
    }
    if (entry.name.endsWith(UPDATE_PART_FILE_SUFFIX) || entry.name === UPDATE_PACKAGE_META_FILE_NAME) {
      await rm(entryPath, { force: true }).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}

/** 删除指定版本的整目录（校验失败 / 取消 / 版本不匹配时使用，覆盖 .part 与元数据） */
export async function removePackageArtifacts(version: string): Promise<void> {
  if (!isSafeUpdateVersion(version)) {
    return;
  }
  await rm(resolveVersionDir(version), { recursive: true, force: true }).catch(() => undefined);
}

/** 写入安装包旁注元数据（与正式文件同一轮操作落盘） */
export async function writePackageMeta(input: {
  version: string;
  fileName: string;
  size: number;
  sha256: string;
  baseUrlHost: string;
}): Promise<void> {
  const meta: PackageMeta = {
    version: input.version,
    fileName: input.fileName,
    size: input.size,
    sha256: input.sha256.toLowerCase(),
    baseUrlHost: input.baseUrlHost,
    downloadedAt: new Date().toISOString(),
  };
  await writeFile(
    resolvePackageMetaPath(input.version),
    `${JSON.stringify(meta, null, 2)}\n`,
    'utf8',
  );
}
