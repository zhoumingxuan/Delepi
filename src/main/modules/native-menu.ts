import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { IPC_MUSE } from '@shared/ipc-channels';
import { isTrustedPageUrl } from '../ipc/trusted-sender';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Menu sends UI intent only; rebuilding a window never restarts a service/run. */
export function registerNativeMenu(getMainWindow: () => BrowserWindow | null): void {
  const openSettings = () => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    if (!isTrustedPageUrl(window.webContents.getURL(), { isPackaged: app.isPackaged,
      devServerUrl: process.env.VITE_DEV_SERVER_URL,
      packagedPageUrl: pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href })) return;
    window.show(); window.focus(); window.webContents.send(IPC_MUSE.OPEN_SETTINGS);
  };
  const settings: MenuItemConstructorOptions = { label: '设置…', accelerator: 'CmdOrCtrl+,', click: openSettings };
  const template: MenuItemConstructorOptions[] = [
    process.platform === 'darwin'
      ? { label: app.name || 'Delepi', submenu: [{ role: 'about' }, { type: 'separator' }, settings, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }
      : { label: '文件', submenu: [settings, { type: 'separator' }, { role: 'quit' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, ...(process.platform === 'darwin' ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
