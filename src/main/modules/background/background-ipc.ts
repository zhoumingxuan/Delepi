import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { IPC_AUTONOMY, IPC_BACKGROUND } from '@shared/ipc-channels';
import type { BackgroundConfiguration, BackgroundSchedule, LearnedSkill, LearnedSkillRollback } from '@shared/types/background';
import type { MuseResult } from '@shared/types/muse';
import { assertTrustedSender } from '../../ipc/trusted-sender';

export interface BackgroundRuntimePort {
  ready(): boolean;
  list(): BackgroundSchedule[] | Promise<BackgroundSchedule[]>;
  configure(goalId: string, goalRevision: number, config: BackgroundConfiguration, callerId: number): BackgroundSchedule | Promise<BackgroundSchedule>;
  setEnabled(id: string, revision: number, enabled: boolean): BackgroundSchedule | Promise<BackgroundSchedule>;
  runNow(id: string, revision: number): BackgroundSchedule | Promise<BackgroundSchedule>;
  listSkills(goalId?: string): LearnedSkill[] | Promise<LearnedSkill[]>;
  rollbackSkill(id: string, revision: number): LearnedSkillRollback | Promise<LearnedSkillRollback>;
}
let liveWindow: () => BrowserWindow | null = () => null;
let liveRuntime: () => BackgroundRuntimePort | undefined = () => undefined;
let registered = false;
function invalid(): never { throw new Error('INVALID_REQUEST'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) invalid(); return value; }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(); return value as number; }
function envelope(raw: unknown, keys: readonly string[]) {
  const input = object(raw, ['requestId', 'expectedRevision', 'payload']);
  return { requestId: id(input.requestId), expectedRevision: input.expectedRevision === undefined ? undefined : revision(input.expectedRevision), payload: object(input.payload, keys) };
}
function configuration(raw: unknown): BackgroundConfiguration {
  const value = object(raw, ['intervalMinutes', 'dailyRoundLimit', 'expiresAt', 'protocol', 'learningEnabled', 'autoPromote']);
  if (!Number.isSafeInteger(value.intervalMinutes) || (value.intervalMinutes as number) < 30 || (value.intervalMinutes as number) > 1440
    || !Number.isSafeInteger(value.dailyRoundLimit) || (value.dailyRoundLimit as number) < 1 || (value.dailyRoundLimit as number) > 3
    || typeof value.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.expiresAt)
    || !Number.isFinite(Date.parse(value.expiresAt)) || new Date(value.expiresAt).toISOString() !== value.expiresAt
    || (value.protocol !== 'chat-completions' && value.protocol !== 'responses')
    || typeof value.learningEnabled !== 'boolean' || typeof value.autoPromote !== 'boolean'
    || value.autoPromote && !value.learningEnabled) invalid();
  return value as unknown as BackgroundConfiguration;
}
const errors: Record<string, string> = {
  UNTRUSTED_SENDER: '此页面不能管理后台与学习', INVALID_REQUEST: '输入格式无效，请核对后重试',
  STAGE_NOT_READY: '后台与学习尚未就绪，当前不会开始运行', REVISION_CONFLICT: '内容已更新，请刷新后重新确认',
  GOAL_CHANGED: '主题范围已变化，请重新确认后台范围', GOAL_INACTIVE: '主题已暂停或归档', GOAL_NOT_FOUND: '主题不存在，请刷新查看',
  DESTINATION_CHANGED: '模型目的地已变化，请重新确认', DESTINATION_UNAVAILABLE: '模型目的地尚未配置或已变化',
  POLICY_CHANGED: '权限策略已变化，请重新确认', POLICY_BLOCKED: '当前权限阻止继续运行',
  AUTHORIZATION_REVOKED: '范围规则已撤回，请重新配置后台', AUTHORIZATION_CHANGED: '范围规则已变化，请重新配置后台',
  BUDGET_EXHAUSTED: '自主阅读预算不足，后台保持停止', GOAL_ALREADY_RUNNING: '这个主题已有运行，请先查看进度',
  BACKGROUND_NOT_FOUND: '后台计划不存在，请刷新查看', BACKGROUND_EXPIRED: '后台范围已过期，请重新配置',
  BACKGROUND_PAUSED: '后台计划已暂停，请先恢复', BACKGROUND_BLOCKED: '后台范围已失效，请重新配置',
  BACKGROUND_RECONFIGURE_REQUIRED: '后台范围已失效，请重新配置', BACKGROUND_RUNNING: '本计划已有轮次在运行，请先等待收尾',
  FOREGROUND_BUSY: '专业任务正在执行，后台等待安全空闲时机', OUTCOME_UNKNOWN: '上轮回执不明，请核对活动记录',
  PROCESS_INTERRUPTED: '上轮进程中断，请核对活动记录', AUTHORIZATION_REQUIRED: '后台范围需要重新批准', RESOURCE_CHANGED: '公开来源版本已变化，请重新配置',
  BACKGROUND_DAILY_LIMIT: '今天的后台轮数已用完，等待下一个 UTC 日', BACKGROUND_BUSY: '后台正在收尾，请稍后重试',
  LEARNING_NOT_FOUND: '学习记录不存在，请刷新查看', LEARNING_ROLLBACK_UNAVAILABLE: '当前没有可回退的学习版本',
  SKILL_NOT_FOUND: '学习记录不存在，请刷新查看', PERSISTENCE_FAILED: '记录未确认保存，请刷新核对',
};
function safeError(error: unknown): MuseResult<never> {
  const candidate = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : error instanceof Error ? error.message : '';
  const code = typeof candidate === 'string' && Object.hasOwn(errors, candidate) ? candidate : 'OPERATION_FAILED';
  const current = (error as { currentRevision?: unknown })?.currentRevision;
  return { ok: false, code, message: errors[code] ?? '操作未完成，请刷新或重试', retryable: !['UNTRUSTED_SENDER', 'INVALID_REQUEST', 'STAGE_NOT_READY'].includes(code),
    ...(Number.isSafeInteger(current) && (current as number) >= 0 ? { currentRevision: current as number } : {}) };
}
/** All mutations are restricted to the live main frame. Runtime derives scope, paths and action identity. */
export function registerBackgroundIpcHandlers(getMainWindow: () => BrowserWindow | null, runtimeProvider: () => BackgroundRuntimePort | undefined): void {
  liveWindow = getMainWindow; liveRuntime = runtimeProvider;
  if (registered) return;
  registered = true;
  const changed = () => {
    const window = liveWindow(); if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    try { assertTrustedSender({ sender: window.webContents, senderFrame: window.webContents.mainFrame } as IpcMainInvokeEvent, window); window.webContents.send(IPC_AUTONOMY.CHANGED); } catch { /* Next trusted pull recovers durable facts. */ }
  };
  const handle = (channel: string, keys: readonly string[], callback: (input: ReturnType<typeof envelope>, runtime: BackgroundRuntimePort | undefined, callerId: number) => unknown, writes = false) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown): Promise<MuseResult<unknown>> => {
      try {
        const window = liveWindow(); assertTrustedSender(event, window);
        const value = await callback(envelope(raw, keys), liveRuntime(), window.webContents.id);
        if (writes) changed(); return { ok: true, result: value };
      } catch (error) { return safeError(error); }
    });
  };
  const required = (runtime: BackgroundRuntimePort | undefined) => { if (!runtime?.ready()) throw new Error('STAGE_NOT_READY'); return runtime; };
  const cas = (value: number | undefined) => { if (value === undefined) invalid(); return value; };
  const consent = (value: unknown) => { if (value !== true) invalid(); };
  handle(IPC_BACKGROUND.STATUS, [], (_, runtime) => ({ ready: runtime?.ready() === true, appMustRemainRunning: true }));
  handle(IPC_BACKGROUND.LIST, [], (_, runtime) => required(runtime).list());
  handle(IPC_BACKGROUND.CONFIGURE, ['goalId', 'config', 'confirmed'], ({ payload, expectedRevision }, runtime, callerId) => {
    consent(payload.confirmed); return required(runtime).configure(id(payload.goalId), cas(expectedRevision), configuration(payload.config), callerId);
  }, true);
  handle(IPC_BACKGROUND.SET_ENABLED, ['scheduleId', 'enabled', 'confirmed'], ({ payload, expectedRevision }, runtime) => {
    consent(payload.confirmed); if (typeof payload.enabled !== 'boolean') invalid();
    return required(runtime).setEnabled(id(payload.scheduleId), cas(expectedRevision), payload.enabled);
  }, true);
  handle(IPC_BACKGROUND.RUN_NOW, ['scheduleId', 'confirmed'], ({ payload, expectedRevision }, runtime) => {
    consent(payload.confirmed); return required(runtime).runNow(id(payload.scheduleId), cas(expectedRevision));
  }, true);
  handle(IPC_BACKGROUND.SKILL_LIST, ['goalId'], ({ payload }, runtime) => required(runtime).listSkills(payload.goalId === undefined ? undefined : id(payload.goalId)));
  handle(IPC_BACKGROUND.SKILL_ROLLBACK, ['skillId', 'confirmed'], ({ payload, expectedRevision }, runtime) => {
    consent(payload.confirmed); return required(runtime).rollbackSkill(id(payload.skillId), cas(expectedRevision));
  }, true);
}
