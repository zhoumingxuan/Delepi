import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { IPC_MUSE } from '@shared/ipc-channels';
import type { MuseResult } from '@shared/types/muse';
import { assertTrustedSender, isTrustedPageUrl } from '../ipc/trusted-sender';
import { getTaskService } from './tasks/task-service';
import { listArtifacts, getArtifact, openArtifact, acceptArtifact, indexLegacyArtifacts } from './artifacts/service';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let currentWindow: () => BrowserWindow | null = () => null;
let registered = false;
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_REQUEST');
  return raw as Record<string, unknown>;
}
function identifier(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[\w-]{1,128}$/.test(raw)) throw new Error('INVALID_REQUEST'); return raw;
}
function integer(raw: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) > max) throw new Error('INVALID_REQUEST'); return raw as number;
}
function payload(raw: unknown, allowed: readonly string[]): { requestId: string; expectedRevision?: number; data: Record<string, unknown> } {
  const envelope = record(raw);
  if (Object.keys(envelope).some((key) => !['requestId', 'expectedRevision', 'payload'].includes(key))) throw new Error('INVALID_REQUEST');
  const data = record(envelope.payload);
  if (Object.keys(data).some((key) => !allowed.includes(key))) throw new Error('INVALID_REQUEST');
  return { requestId: identifier(envelope.requestId),
    expectedRevision: envelope.expectedRevision === undefined ? undefined : integer(envelope.expectedRevision), data };
}
function query(data: Record<string, unknown>) {
  return { ...(data.conversationId !== undefined ? { conversationId: identifier(data.conversationId) } : {}),
    ...(data.runId !== undefined ? { runId: identifier(data.runId) } : {}),
    ...(data.limit !== undefined ? { limit: Math.max(1, integer(data.limit, 100)) } : {}) };
}

/** Registered once; every invoke and wake resolves the live application window. */
export function registerMuseIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  currentWindow = getMainWindow;
  if (registered) return;
  registered = true;
  const handle = (channel: string, allowed: readonly string[], callback: (params: ReturnType<typeof payload>) => unknown) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown): Promise<MuseResult<unknown>> => {
      try { assertTrustedSender(event, currentWindow()); return { ok: true, result: await callback(payload(raw, allowed)) }; }
      catch (error) {
        const code = error instanceof Error && error.message === 'STALE_REVISION' ? 'REVISION_CONFLICT'
          : error instanceof Error && ['UNTRUSTED_SENDER', 'INVALID_REQUEST'].includes(error.message)
          ? error.message : typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code) : 'OPERATION_FAILED';
        const revision = (error as { currentRevision?: unknown })?.currentRevision;
        return { ok: false, code, message: code === 'REVISION_CONFLICT' ? '内容已更新，请刷新后再操作' : code === 'UNTRUSTED_SENDER' ? '此页面不能访问应用数据' : '操作未完成，请刷新或重试', retryable: code !== 'UNTRUSTED_SENDER' && code !== 'INVALID_REQUEST', ...(typeof revision === 'number' ? { currentRevision: revision } : {}) };
      }
    });
  };
  handle(IPC_MUSE.APP_INFO, [], () => ({ version: app.getVersion(), platform: process.platform }));
  handle(IPC_MUSE.RUN_LIST, ['conversationId', 'limit'], ({ data }) => getTaskService().listRuns(query(data)));
  handle(IPC_MUSE.RUN_GET, ['runId'], ({ data }) => { const runId = identifier(data.runId); return { run: getTaskService().getRun(runId), attempts: getTaskService().listAttempts(runId) }; });
  handle(IPC_MUSE.ACTIVITY_LIST, ['runId', 'conversationId', 'afterEventId', 'throughEventId', 'limit'], ({ data }) => getTaskService().listActivity({ ...query(data),
    ...(data.afterEventId !== undefined ? { afterEventId: integer(data.afterEventId) } : {}), ...(data.throughEventId !== undefined ? { throughEventId: integer(data.throughEventId) } : {}) }));
  handle(IPC_MUSE.INBOX_LIST, ['runId'], ({ data }) => getTaskService().listInbox({ runId: identifier(data.runId) }));
  handle(IPC_MUSE.ARTIFACT_LIST, ['runId', 'conversationId', 'limit', 'cursor'], ({ data }) => {
    if (data.cursor !== undefined && (typeof data.cursor !== 'string' || data.cursor.length > 512)) throw new Error('INVALID_REQUEST');
    return listArtifacts({ ...query(data), ...(data.cursor !== undefined ? { cursor: data.cursor as string } : {}) });
  });
  handle(IPC_MUSE.ARTIFACT_GET, ['artifactId'], ({ data }) => getArtifact(identifier(data.artifactId)));
  handle(IPC_MUSE.ARTIFACT_INDEX, ['cursor', 'limit'], ({ data }) => {
    if (data.cursor !== undefined && (typeof data.cursor !== 'string' || data.cursor.length > 512)) throw new Error('INVALID_REQUEST');
    return indexLegacyArtifacts({ ...(data.cursor !== undefined ? { cursor: data.cursor as string } : {}), ...(data.limit !== undefined ? { limit: Math.max(1, integer(data.limit, 200)) } : {}) });
  });
  handle(IPC_MUSE.ARTIFACT_OPEN, ['artifactId'], ({ data }) => openArtifact(identifier(data.artifactId)));
  handle(IPC_MUSE.ARTIFACT_ACCEPT, ['artifactId', 'accepted'], ({ data, expectedRevision, requestId }) => {
    if (typeof data.accepted !== 'boolean' || expectedRevision === undefined) throw new Error('INVALID_REQUEST');
    return acceptArtifact({ artifactId: identifier(data.artifactId), expectedRevision, accepted: data.accepted, requestId });
  });
  getTaskService().setWakeListener((cursor: number) => {
    const window = currentWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    if (!isTrustedPageUrl(window.webContents.getURL(), { isPackaged: app.isPackaged, devServerUrl: process.env.VITE_DEV_SERVER_URL,
      packagedPageUrl: pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href })) return;
    try { window.webContents.send(IPC_MUSE.CHANGED, { cursor }); } catch { /* closed renderer; durable cursor is pulled next time */ }
  });
}
