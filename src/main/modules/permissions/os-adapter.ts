import { app, shell, systemPreferences } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { OsPermissionKind, OsPermissionStatus } from '@shared/types/autonomy';

export const OS_PERMISSION_KINDS: readonly OsPermissionKind[] = ['camera', 'microphone', 'screen', 'accessibility', 'inputMonitoring', 'automation', 'fullDisk'];
const names: Record<OsPermissionKind, string> = { camera: '摄像头', microphone: '麦克风', screen: '屏幕录制', accessibility: '辅助功能', inputMonitoring: '输入监控', automation: '自动化', fullDisk: '完全磁盘访问' };
const anchors: Record<OsPermissionKind, string> = { camera: 'Privacy_Camera', microphone: 'Privacy_Microphone', screen: 'Privacy_ScreenCapture', accessibility: 'Privacy_Accessibility', inputMonitoring: 'Privacy_ListenEvent', automation: 'Privacy_Automation', fullDisk: 'Privacy_AllFiles' };
export interface OsAdapterOptions {
  platform: string; client: string; usageDescriptions: Partial<Record<OsPermissionKind, boolean>>;
  preferences: {
    getMediaAccessStatus?: (kind: 'camera' | 'microphone' | 'screen') => string;
    isTrustedAccessibilityClient?: (prompt: boolean) => boolean;
    askForMediaAccess?: (kind: 'camera' | 'microphone') => Promise<boolean>;
  };
  shell: { openExternal: (url: string) => Promise<void>; openPath: (filename: string) => Promise<string> };
  now?: () => string;
}
export interface OsPermissionAdapter {
  status(): Promise<OsPermissionStatus[]>;
  query(kind: OsPermissionKind): Promise<OsPermissionStatus>;
  request(kind: OsPermissionKind): Promise<OsPermissionStatus>;
  openSettings(kind: OsPermissionKind): Promise<{ opened: boolean }>;
}
const media = (kind: OsPermissionKind): kind is 'camera' | 'microphone' => kind === 'camera' || kind === 'microphone';
function valid(kind: OsPermissionKind): void { if (!OS_PERMISSION_KINDS.includes(kind)) throw new Error('INVALID_REQUEST'); }

/** Queries never capture media, install input hooks, or request TCC. */
export function createElectronOsAdapter(options: OsAdapterOptions): OsPermissionAdapter {
  const now = options.now ?? (() => new Date().toISOString());
  let requestBusy = false;
  const query = async (kind: OsPermissionKind): Promise<OsPermissionStatus> => {
    valid(kind);
    const mac = options.platform === 'darwin', windowsMedia = options.platform === 'win32' && media(kind);
    const row: OsPermissionStatus = { kind, label: names[kind], status: 'unknown', querySupported: false,
      requestSupported: false, settingsSupported: mac || windowsMedia, checkedAt: now(),
      detail: `${options.client} · 当前系统用户；授权状态由系统确认。` };
    if (!mac && !windowsMedia) { row.detail = '当前系统没有接入此项检测或设置入口。'; return row; }
    try {
      if ((media(kind) || kind === 'screen') && options.preferences.getMediaAccessStatus) {
        row.querySupported = true;
        const state = options.preferences.getMediaAccessStatus(kind);
        row.status = state === 'granted' ? 'granted' : ['denied', 'restricted'].includes(state) ? 'not-granted' : 'unknown';
        row.detail += state === 'not-determined' ? ' 尚未向系统申请。' : state === 'denied' ? ' 系统当前已拒绝。' : state === 'restricted' ? ' 系统当前受限制。' : state === 'granted' ? ' 系统当前已授权。' : ' 检测结果尚未确认。';
        row.requestSupported = mac && media(kind) && options.usageDescriptions[kind] === true
          && Boolean(options.preferences.askForMediaAccess) && state === 'not-determined';
        if (mac && media(kind) && options.usageDescriptions[kind] !== true) row.detail += ' 当前客户端缺少用途声明，仅提供系统设置入口。';
      } else if (mac && kind === 'accessibility' && options.preferences.isTrustedAccessibilityClient) {
        row.querySupported = true;
        row.status = options.preferences.isTrustedAccessibilityClient(false) ? 'granted' : 'not-granted';
        row.requestSupported = row.status !== 'granted';
      } else row.detail += ' 未接入可靠只读查询，请在系统设置确认。';
    } catch { row.status = 'unknown'; row.requestSupported = false; row.detail = `${options.client} · 本次系统检测未确认，请在系统设置核对。`; }
    return row;
  };
  return {
    query, status: () => Promise.all(OS_PERMISSION_KINDS.map(query)),
    async request(kind) {
      valid(kind);
      if (options.platform !== 'darwin') throw new Error('OS_REQUEST_UNSUPPORTED');
      if (requestBusy) throw new Error('OS_REQUEST_BUSY');
      requestBusy = true;
      try {
        if (media(kind)) {
          if (options.usageDescriptions[kind] !== true) throw new Error('OS_USAGE_DESCRIPTION_MISSING');
          if (!options.preferences.getMediaAccessStatus || !options.preferences.askForMediaAccess) throw new Error('OS_REQUEST_UNSUPPORTED');
          const state = options.preferences.getMediaAccessStatus(kind);
          if (state === 'not-determined') await options.preferences.askForMediaAccess(kind);
        } else if (kind === 'accessibility' && options.preferences.isTrustedAccessibilityClient) {
          options.preferences.isTrustedAccessibilityClient(true);
        } else throw new Error('OS_REQUEST_UNSUPPORTED');
        return query(kind);
      } finally { requestBusy = false; }
    },
    async openSettings(kind) {
      valid(kind);
      if (options.platform === 'darwin') {
        try { await options.shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchors[kind]}`); return { opened: true }; }
        catch { try { return { opened: !(await options.shell.openPath('/System/Applications/System Settings.app')) }; } catch { return { opened: false }; } }
      }
      if (options.platform === 'win32' && media(kind)) {
        try { await options.shell.openExternal(`ms-settings:privacy-${kind === 'camera' ? 'webcam' : 'microphone'}`); return { opened: true }; } catch { return { opened: false }; }
      }
      return { opened: false };
    },
  };
}

function usageDescriptions(): OsAdapterOptions['usageDescriptions'] {
  const usage: OsAdapterOptions['usageDescriptions'] = {};
  if (process.platform !== 'darwin') return usage;
  try {
    const plist = readFileSync(path.resolve(process.execPath, '../../Info.plist'), 'utf8');
    for (const [kind, key] of [['camera', 'NSCameraUsageDescription'], ['microphone', 'NSMicrophoneUsageDescription']] as const) {
      usage[kind] = new RegExp(`<key>${key}</key>\\s*<string>[^<]+</string>`).test(plist);
    }
  } catch { /* A missing declaration keeps media requests unavailable. */ }
  return usage;
}
export function createCurrentOsAdapter(): OsPermissionAdapter {
  return createElectronOsAdapter({ platform: process.platform,
    client: app.isPackaged ? 'Delepi 安装客户端' : 'Electron 开发客户端（与安装包身份不同）',
    usageDescriptions: usageDescriptions(), preferences: systemPreferences, shell });
}
