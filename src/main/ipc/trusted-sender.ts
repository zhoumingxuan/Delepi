import { app, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface TrustedPageOptions { packagedPageUrl: string; devServerUrl?: string; isPackaged: boolean }

export function isTrustedPageUrl(raw: string, options: TrustedPageOptions): boolean {
  try {
    const url = new URL(raw);
    url.hash = '';
    const expected = new URL(!options.isPackaged && options.devServerUrl
      ? options.devServerUrl : options.packagedPageUrl);
    expected.hash = '';
    return url.href === expected.href;
  } catch { return false; }
}

/** Only the application main window's own top frame may use privileged APIs. */
export function assertTrustedSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  mainWindow: BrowserWindow | null,
  options: TrustedPageOptions = {
    isPackaged: app.isPackaged,
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
    packagedPageUrl: pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href,
  },
): asserts mainWindow is BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()
    || event.sender !== mainWindow.webContents
    || !event.senderFrame || event.senderFrame !== mainWindow.webContents.mainFrame
    || event.senderFrame.parent !== null
    || !isTrustedPageUrl(event.senderFrame.url, options)
    || !isTrustedPageUrl(mainWindow.webContents.getURL(), options)) {
    throw new Error('UNTRUSTED_SENDER');
  }
}
