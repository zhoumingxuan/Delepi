import { dialog, type BrowserWindow } from 'electron';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProfilePreviewResult, ProfileImportCommitResult, ProfileExportResult } from '@shared/types/config-profile-io';
import { configProfileService } from './config-profile-service';
import { ConfigRevisionConflict } from './settings-transaction';

class ProfileDestinationError extends Error {}

async function destinationState(filename: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    const stat = await lstat(filename);
    if (!stat.isFile()) throw new ProfileDestinationError('所选目标不是普通文件，请选择新的 JSON 文件名');
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Stage complete bytes beside the destination; an I/O failure must not truncate a user's existing file. */
async function writeProfileFile(filename: string, json: string): Promise<void> {
  const previous = await destinationState(filename);
  const directory = path.dirname(filename);
  const temporary = path.join(directory, `.delepi-profile-${randomUUID()}.tmp`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(json, { encoding: 'utf8' });
    await file.sync();
    await file.close();
    file = undefined;
    const current = await destinationState(filename);
    if (previous ? !current || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key =>
      previous[key as keyof typeof previous] !== current[key as keyof typeof current]) : current !== undefined) {
      throw new ProfileDestinationError('导出目标已变化，请重新选择文件');
    }
    await rename(temporary, filename);
    published = true;
    // The rename already published complete bytes. Directory sync is best effort across supported platforms.
    let parent: Awaited<ReturnType<typeof open>> | undefined;
    try { parent = await open(directory, 'r'); await parent.sync(); }
    catch { /* Some platforms do not allow opening/syncing a directory. */ }
    finally { await parent?.close().catch(() => {}); }
  } finally {
    await file?.close().catch(() => {});
    if (!published) await unlink(temporary).catch(() => {});
  }
}

export async function previewProfileImport(window: BrowserWindow, ownerId: number): Promise<ProfilePreviewResult> {
  const picked = await dialog.showOpenDialog(window, { title: '选择配置方案', properties: ['openFile'], filters: [{ name: 'Delepi 配置方案', extensions: ['json'] }] });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(picked.filePaths[0], 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('请使用小于 1 MB 的 JSON 文件');
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024 * 1024) throw new Error('配置文件超过 1 MB');
    return { ok: true, preview: configProfileService.previewImport(buffer.subarray(0, bytesRead).toString('utf8'), ownerId) };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '读取配置失败' }; }
  finally { await file?.close(); }
}
export function commitProfileImport(token: string, ownerId: number, expectedRevision: number): ProfileImportCommitResult {
  try { return { ok: true, ...configProfileService.commitImport(token, ownerId, expectedRevision) }; }
  catch (error) {
    return { ok: false, code: error instanceof ConfigRevisionConflict ? error.code : 'IMPORT_FAILED',
      error: error instanceof Error ? error.message : '导入失败',
      ...(error instanceof ConfigRevisionConflict ? { currentRevision: error.currentRevision } : {}) };
  }
}
export async function exportProfile(window: BrowserWindow, id: string, includeSecrets: boolean): Promise<ProfileExportResult> {
  try {
    if (includeSecrets) {
      const confirmation = await dialog.showMessageBox(window, { type: 'warning', title: '导出包含密钥', message: '此文件将包含明文 API 密钥。', detail: '只保存到你信任的位置。', buttons: ['取消', '包含密钥导出'], defaultId: 0, cancelId: 0 });
      if (confirmation.response !== 1) return { ok: false, canceled: true };
    }
    const prepared = configProfileService.exportProfile(id, includeSecrets);
    const safeName = prepared.name.replace(/[\\/:*?"<>|]/g, '-').slice(0, 100) || '配置方案';
    const picked = await dialog.showSaveDialog(window, { title: includeSecrets ? '导出配置（包含密钥）' : '导出配置（不含密钥）', defaultPath: `${safeName}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    await writeProfileFile(picked.filePath, prepared.json);
    return { ok: true, filePath: picked.filePath, containsSecrets: prepared.containsSecrets };
  } catch (error) { return { ok: false, error: error instanceof ProfileDestinationError ? error.message : '配置导出失败，请重试' }; }
}
