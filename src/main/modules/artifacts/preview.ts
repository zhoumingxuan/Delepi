import { BrowserWindow, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { InspectedFile } from './files';

const EXTERNAL_DOCUMENTS = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp']);
const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
const HTML = new Set(['.html', '.htm']);
const TEXT = new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.log', '.yaml', '.yml', '.xml', '.svg',
  '.py', '.js', '.ts', '.tsx', '.css', '.sh', '.sql', '.c', '.cpp', '.rs']);
const windows = new Set<BrowserWindow>();

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function usesExternalDocumentViewer(filename: string): boolean {
  return EXTERNAL_DOCUMENTS.has(path.extname(filename).toLowerCase());
}

/** Only called after ID lookup and path/hash verification. Never accepts renderer URLs. */
export async function openVerifiedArtifact(file: InspectedFile, title: string): Promise<void> {
  const extension = path.extname(file.path).toLowerCase();
  if (EXTERNAL_DOCUMENTS.has(extension)) {
    const error = await shell.openPath(file.path);
    if (error) throw new Error('ARTIFACT_EXTERNAL_OPEN_FAILED');
    return;
  }
  if (!file.bytes || (!HTML.has(extension) && !TEXT.has(extension) && !IMAGES[extension])) {
    throw new Error('ARTIFACT_PREVIEW_UNSUPPORTED');
  }
  const resourceUrls = new Set<string>();
  let body: string;
  if (HTML.has(extension)) body = file.bytes.toString('utf8');
  else if (IMAGES[extension]) {
    const resource = `data:${IMAGES[extension]};base64,${file.bytes.toString('base64')}`;
    resourceUrls.add(resource);
    body = `<html><body style="margin:0;background:#242424;text-align:center"><img style="max-width:100%" src="${resource}"></body></html>`;
  } else body = `<html><body><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(file.bytes.toString('utf8'))}</pre></body></html>`;
  const documentUrl = `data:text/html;charset=utf-8,${encodeURIComponent(body)}`;
  resourceUrls.add(documentUrl);
  const window = new BrowserWindow({
    width: 1000, height: 760, title, show: false,
    webPreferences: { partition: `artifact-preview-${randomUUID()}`, contextIsolation: true, sandbox: true,
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      javascript: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false },
  });
  windows.add(window);
  const session = window.webContents.session;
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !resourceUrls.has(details.url) }));
  session.on('will-download', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.once('closed', () => { windows.delete(window); });
  try {
    await window.loadURL(documentUrl);
    if (!window.isDestroyed()) window.show();
  } catch (error) {
    window.destroy();
    throw error;
  }
}
