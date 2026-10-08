import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { IPC_CONFIG } from '@shared/ipc-channels';
import { assertTrustedSender } from '../../ipc/trusted-sender';
import { configManager } from './config-manager';
import { configProfileService } from './config-profile-service';
import { previewProfileImport, commitProfileImport, exportProfile } from './config-profile-io';

const object = (raw: unknown, allowed: readonly string[]): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('配置参数无效');
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new Error('配置参数无效');
  return raw as Record<string, unknown>;
};
function revision(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isSafeInteger(raw) || (raw as number) < 0) throw new Error('配置版本无效');
  return raw as number;
}
function id(raw: unknown): string { if (typeof raw !== 'string' || !/^[\w-]{1,128}$/.test(raw)) throw new Error('方案标识无效'); return raw; }

export function registerConfigIpc(getMainWindow: () => BrowserWindow | null, onReload: () => void): void {
  const handle = (channel: string, callback: (event: IpcMainInvokeEvent, raw?: unknown) => unknown) => {
    ipcMain.handle(channel, (event, raw) => { assertTrustedSender(event, getMainWindow()); return callback(event, raw); });
  };
  handle(IPC_CONFIG.GET, () => {
    const settings = { ...configManager.getSettings() };
    return { configured: configManager.isConfigured(), model: settings.mainModelName,
      baseUrl: settings.mainModelBaseUrl, settings, revision: configManager.getRevision() };
  });
  handle(IPC_CONFIG.SAVE, (_event, raw) => {
    const params = object(raw, ['key', 'value', 'expectedRevision']);
    if (typeof params.key !== 'string') throw new Error('配置键无效');
    return { revision: configProfileService.saveSettings({ [params.key]: params.value }, revision(params.expectedRevision)) };
  });
  handle(IPC_CONFIG.SAVE_BATCH, (_event, raw) => {
    const params = object(raw, ['patch', 'expectedRevision']);
    return { revision: configProfileService.saveSettings(params.patch, revision(params.expectedRevision)) };
  });
  handle(IPC_CONFIG.RELOAD, () => { configManager.reload(); onReload(); });
  handle(IPC_CONFIG.PROFILES_LIST, () => configProfileService.list());
  handle(IPC_CONFIG.PROFILES_SAVE, (_event, raw) => { const p = object(raw, ['name', 'blank', 'expectedRevision']); if (p.blank !== undefined && typeof p.blank !== 'boolean') throw new Error('配置参数无效'); return configProfileService.saveProfile(p.name, p.blank === true, revision(p.expectedRevision)); });
  handle(IPC_CONFIG.PROFILES_DELETE, (_event, raw) => { const p = object(raw, ['id', 'expectedRevision']); return configProfileService.deleteProfile(id(p.id), revision(p.expectedRevision)); });
  handle(IPC_CONFIG.PROFILES_SWITCH, (_event, raw) => { const p = object(raw, ['id', 'expectedRevision']); return configProfileService.switchProfile(id(p.id), revision(p.expectedRevision)); });
  handle(IPC_CONFIG.IMPORT_PREVIEW, (event, raw) => {
    if (raw !== undefined) throw new Error('请在主进程文件选择器中选择配置');
    const window = getMainWindow(); assertTrustedSender(event, window);
    return previewProfileImport(window, event.sender.id);
  });
  handle(IPC_CONFIG.IMPORT_COMMIT, (event, raw) => {
    const p = object(raw, ['token', 'expectedRevision', 'confirmed']), expectedRevision = revision(p.expectedRevision);
    if (expectedRevision === undefined || p.confirmed !== true) throw new Error('请确认导入预览');
    return commitProfileImport(id(p.token), event.sender.id, expectedRevision);
  });
  handle(IPC_CONFIG.IMPORT_CANCEL, (event, raw) => { const p = object(raw, ['token']); configProfileService.cancelImport(id(p.token), event.sender.id); });
  handle(IPC_CONFIG.PROFILES_IMPORT, () => { throw new Error('请先选择文件并预览确认；不接受直接文件路径导入'); });
  handle(IPC_CONFIG.PROFILES_EXPORT, (event, raw) => {
    const p = object(raw, ['profileId', 'includeSecrets']), window = getMainWindow(); assertTrustedSender(event, window);
    if (p.includeSecrets !== undefined && typeof p.includeSecrets !== 'boolean') throw new Error('导出选项无效');
    return exportProfile(window, id(p.profileId), p.includeSecrets === true);
  });
}
