import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { IPC_AUTONOMY } from '@shared/ipc-channels';
import { PUBLIC_CAPABILITIES, type AutonomyApi, type ApprovalChoice, type GoalState, type OsPermissionKind, type PermissionPolicy, type RuleDraft } from '@shared/types/autonomy';
import type { MuseResult } from '@shared/types/muse';
import { assertTrustedSender } from '../ipc/trusted-sender';
import { validateGoalDraft, type GoalService } from './goals/goal-service';
import type { PermissionAuthority } from './permissions/authority';
import { createCurrentOsAdapter, OS_PERMISSION_KINDS, type OsPermissionAdapter } from './permissions/os-adapter';

type GoalUiService = Pick<GoalService, 'list' | 'get' | 'listDestinations' | 'create' | 'update' | 'setState'>;
type AuthorityUiService = Pick<PermissionAuthority, 'listApprovals' | 'decideApproval' | 'previewRule' | 'issueRule' | 'listRules' | 'revokeRule' | 'listGrants' | 'revokeGrant' | 'getPolicy' | 'updatePolicy' | 'assertOsRequest'>;
type StageMethod<F, TrustedCaller extends boolean = false> = F extends (...args: infer A) => Promise<MuseResult<infer T>>
  ? (...args: TrustedCaller extends true ? [...A, callerId: number] : A) => T | Promise<T> : never;
type StageServices = { [K in 'budget' | 'planExploration' | 'startExploration' | 'stopExploration' | 'listExplorations' | 'appendPublicMessage']: StageMethod<AutonomyApi[K], K extends 'planExploration' | 'startExploration' | 'appendPublicMessage' ? true : false> };
export interface AutonomyIpcServices { goals: GoalUiService; authority: AuthorityUiService; os?: OsPermissionAdapter; stages?: Partial<StageServices>; explorationReady?: boolean }
let liveWindow: () => BrowserWindow | null = () => null;
let liveServices: AutonomyIpcServices | undefined;
let registered = false;
function invalid(): never { throw new Error('INVALID_REQUEST'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) invalid(); return value; }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(); return value as number; }
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid(); return value;
}
function members<T extends string>(value: unknown, choices: readonly T[], max = choices.length): T[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !choices.includes(item as T)) || new Set(value).size !== value.length) invalid(); return value as T[];
}
function ruleDraft(value: unknown): RuleDraft {
  const raw = object(value, ['goalId', 'expectedGoalRevision', 'capabilities', 'resourceRefs', 'expiresAt', 'resumeAfterRestart']);
  if (!Array.isArray(raw.resourceRefs) || !raw.resourceRefs.length || raw.resourceRefs.length > 100 || new Set(raw.resourceRefs).size !== raw.resourceRefs.length || typeof raw.resumeAfterRestart !== 'boolean') invalid();
  const capabilities = members(raw.capabilities, PUBLIC_CAPABILITIES); if (!capabilities.length) invalid();
  const expiresAt = text(raw.expiresAt, 30);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt).toISOString() !== expiresAt) invalid();
  return { goalId: id(raw.goalId), expectedGoalRevision: revision(raw.expectedGoalRevision), capabilities, resourceRefs: raw.resourceRefs.map(id), expiresAt, resumeAfterRestart: raw.resumeAfterRestart };
}
function envelope(raw: unknown, keys: readonly string[]) {
  const input = object(raw, ['requestId', 'expectedRevision', 'payload']);
  return { requestId: id(input.requestId), expectedRevision: input.expectedRevision === undefined ? undefined : revision(input.expectedRevision), payload: object(input.payload, keys) };
}
const errorMessages: Record<string, string> = {
  UNTRUSTED_SENDER: '此页面不能管理主题或授权', INVALID_REQUEST: '输入格式无效，请核对后重试', REVISION_CONFLICT: '内容已更新，请刷新后重新确认',
  APPROVAL_EXPIRED: '预览或批准卡已过期，请重新查看', APPROVAL_CHANGED: '操作范围已变化，请重新查看批准卡', APPROVAL_NOT_PENDING: '该批准卡已处理，请刷新查看',
  APPROVAL_NOT_FOUND: '批准卡已失效，请刷新查看', GOAL_CHANGED: '主题范围已变化，请重新预览', GOAL_INACTIVE: '主题已暂停或归档', GOAL_NOT_FOUND: '主题不存在，请刷新查看',
  DESTINATION_UNAVAILABLE: '模型目的地尚未配置或已经变化', DESTINATION_CHANGED: '模型目的地已变化，请重新预览', RESOURCE_CHANGED: '资源版本已变化，请重新预览',
  POLICY_BLOCKED: '当前权限限制了该动作', POLICY_CHANGED: '权限策略已变化，请重新预览', STALE_TASK_ATTEMPT: '该运行已失效，请刷新查看',
  AUTHORIZATION_REVOKED: '授权已撤回，请刷新查看', AUTHORIZATION_CHANGED: '授权范围已变化，请重新查看', UNTRUSTED_CALLER: '此预览属于已关闭的窗口，请重新生成',
  PERSISTENCE_FAILED: '记录未保存成功；已限制的操作保持停止，请刷新核对', OS_REQUEST_UNSUPPORTED: '此项仅提供系统设置引导', OS_USAGE_DESCRIPTION_MISSING: '当前客户端缺少用途声明，请使用系统设置入口',
  OS_REQUEST_BUSY: '系统权限申请正在进行，请稍后重试', STAGE_NOT_READY: '公开读取与硬额度尚未开放，当前不会启动探索',
  PLAN_EXPIRED: '探索计划已过期，请重新预览', PLAN_CHANGED: '计划范围已变化，请重新预览', PLAN_NOT_FOUND: '探索计划已失效，请重新预览',
  EXPLORATION_ACTIVE: '这个主题已有正在运行的探索，请先查看进度', GOAL_ALREADY_RUNNING: '这个主题已有正在运行的探索，请先查看进度', EXPLORATION_NOT_FOUND: '运行记录不存在，请刷新查看',
  PUBLIC_MESSAGE_NOT_ACCEPTED: '本次公开补充未被接纳，请保留内容并核对运行状态', BUDGET_EXHAUSTED: '自主阅读预算不足，操作已停止',
  PUBLIC_INBOX_SCOPE_CHANGED: '主题范围已变化，请保留补充并重新确认', PUBLIC_INBOX_SCOPE_MISMATCH: '补充范围与本次运行不一致，请重新核对', PUBLIC_INBOX_DEADLINE_EXPIRED: '本次运行期限已到，请在下一轮重新确认补充',
};
function safeError(error: unknown): MuseResult<never> {
  const candidate = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : error instanceof Error ? error.message : '';
  const code = typeof candidate === 'string' && Object.hasOwn(errorMessages, candidate) ? candidate : 'OPERATION_FAILED';
  const currentRevision = (error as { currentRevision?: unknown })?.currentRevision;
  return { ok: false, code, message: errorMessages[code] ?? '操作未完成，请刷新或重试', retryable: !['UNTRUSTED_SENDER', 'INVALID_REQUEST', 'STAGE_NOT_READY'].includes(code),
    ...(Number.isSafeInteger(currentRevision) && (currentRevision as number) >= 0 ? { currentRevision: currentRevision as number } : {}) };
}
/** UI is the sole grant-signing entry; no model or renderer-supplied action identity is accepted here. */
export function registerAutonomyIpcHandlers(getMainWindow: () => BrowserWindow | null, services: AutonomyIpcServices): void {
  liveWindow = getMainWindow;
  // Read execution readiness at invoke time, including when runtime disposal closes admission.
  liveServices = { goals: services.goals, authority: services.authority, os: services.os ?? createCurrentOsAdapter(),
    get stages() { return services.stages; }, get explorationReady() { return services.explorationReady; } };
  if (registered) return;
  registered = true;
  const changed = () => {
    const window = liveWindow(); if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    try { assertTrustedSender({ sender: window.webContents, senderFrame: window.webContents.mainFrame } as IpcMainInvokeEvent, window); window.webContents.send(IPC_AUTONOMY.CHANGED); } catch { /* Advisory only; next trusted pull recovers committed records. */ }
  };
  const handle = (channel: string, keys: readonly string[], callback: (data: ReturnType<typeof envelope>, services: AutonomyIpcServices, callerId: number) => unknown, writes = false) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown): Promise<MuseResult<unknown>> => {
      try {
        const window = liveWindow(); assertTrustedSender(event, window);
        if (!liveServices) throw new Error('STAGE_NOT_READY');
        const value = await callback(envelope(raw, keys), liveServices, window.webContents.id);
        if (writes) changed(); return { ok: true, result: value };
      } catch (error) { return safeError(error); }
    });
  };
  const requiredRevision = (value: number | undefined) => { if (value === undefined) invalid(); return value; };
  handle(IPC_AUTONOMY.STATUS, [], (_, svc) => ({ explorationReady: svc.explorationReady === true && ['budget', 'planExploration', 'startExploration', 'stopExploration', 'listExplorations', 'appendPublicMessage'].every(name => typeof svc.stages?.[name as keyof StageServices] === 'function') }));
  handle(IPC_AUTONOMY.GOAL_LIST, [], (_, svc) => svc.goals.list());
  handle(IPC_AUTONOMY.GOAL_GET, ['goalId'], ({ payload }, svc) => svc.goals.get(id(payload.goalId)));
  handle(IPC_AUTONOMY.DESTINATION_LIST, [], (_, svc) => svc.goals.listDestinations());
  handle(IPC_AUTONOMY.GOAL_CREATE, ['draft'], ({ payload }, svc) => svc.goals.create(validateGoalDraft(payload.draft)), true);
  handle(IPC_AUTONOMY.GOAL_UPDATE, ['goalId', 'draft'], ({ payload, expectedRevision }, svc) => svc.goals.update(id(payload.goalId), requiredRevision(expectedRevision), validateGoalDraft(payload.draft)), true);
  handle(IPC_AUTONOMY.GOAL_STATE, ['goalId', 'state'], ({ payload, expectedRevision }, svc) => {
    if (typeof payload.state !== 'string' || !['active', 'paused', 'archived'].includes(payload.state)) invalid();
    return svc.goals.setState(id(payload.goalId), requiredRevision(expectedRevision), payload.state as GoalState);
  }, true);
  handle(IPC_AUTONOMY.APPROVAL_LIST, [], (_, svc) => svc.authority.listApprovals());
  handle(IPC_AUTONOMY.APPROVAL_DECIDE, ['previewId', 'choice', 'confirmed'], ({ payload, expectedRevision }, svc, callerId) => {
    if (payload.confirmed !== true || typeof payload.choice !== 'string' || !['once', 'run', 'reject'].includes(payload.choice)) invalid();
    return svc.authority.decideApproval(id(payload.previewId), requiredRevision(expectedRevision), payload.choice as ApprovalChoice, callerId);
  }, true);
  handle(IPC_AUTONOMY.RULE_PREVIEW, ['draft'], ({ payload }, svc, callerId) => svc.authority.previewRule(ruleDraft(payload.draft), callerId));
  handle(IPC_AUTONOMY.RULE_ISSUE, ['previewId', 'confirmed'], ({ payload, expectedRevision }, svc, callerId) => {
    if (payload.confirmed !== true) invalid(); return svc.authority.issueRule(id(payload.previewId), requiredRevision(expectedRevision), callerId);
  }, true);
  handle(IPC_AUTONOMY.RULE_LIST, ['goalId'], ({ payload }, svc) => svc.authority.listRules(payload.goalId === undefined ? undefined : id(payload.goalId)));
  handle(IPC_AUTONOMY.RULE_REVOKE, ['ruleId'], ({ payload, expectedRevision }, svc) => svc.authority.revokeRule(id(payload.ruleId), requiredRevision(expectedRevision)), true);
  handle(IPC_AUTONOMY.GRANT_LIST, [], (_, svc) => svc.authority.listGrants());
  handle(IPC_AUTONOMY.GRANT_REVOKE, ['grantId'], ({ payload, expectedRevision }, svc) => svc.authority.revokeGrant(id(payload.grantId), requiredRevision(expectedRevision)), true);
  handle(IPC_AUTONOMY.POLICY_GET, [], (_, svc) => svc.authority.getPolicy());
  handle(IPC_AUTONOMY.POLICY_UPDATE, ['patch'], ({ payload, expectedRevision }, svc) => {
    const patch = object(payload.patch, ['deniedCapabilities', 'deniedLegacyTools']);
    return svc.authority.updatePolicy(requiredRevision(expectedRevision), { deniedCapabilities: members(patch.deniedCapabilities, PUBLIC_CAPABILITIES), deniedLegacyTools: members(patch.deniedLegacyTools, ['shell', 'python', 'scriptTools', 'dynamicTools', 'localFiles'] as const) } satisfies Pick<PermissionPolicy, 'deniedCapabilities' | 'deniedLegacyTools'>);
  }, true);
  const kind = (value: unknown) => { if (typeof value !== 'string' || !OS_PERMISSION_KINDS.includes(value as OsPermissionKind)) invalid(); return value as OsPermissionKind; };
  handle(IPC_AUTONOMY.OS_STATUS, [], (_, svc) => svc.os!.status());
  handle(IPC_AUTONOMY.OS_REQUEST, ['kind', 'confirmed'], ({ payload }, svc) => {
    if (payload.confirmed !== true) invalid(); const permission = kind(payload.kind);
    svc.authority.assertOsRequest(permission); return svc.os!.request(permission);
  }, true);
  handle(IPC_AUTONOMY.OS_SETTINGS, ['kind'], ({ payload }, svc) => svc.os!.openSettings(kind(payload.kind)));
  // No exploration is registered as executable during A/B. Future services must opt in explicitly.
  function stage<K extends keyof StageServices>(svc: AutonomyIpcServices, name: K): StageServices[K] {
    const method = svc.stages?.[name]; if (svc.explorationReady !== true || !method) throw new Error('STAGE_NOT_READY'); return method;
  }
  handle(IPC_AUTONOMY.BUDGET, ['goalId', 'runId'], ({ payload }, svc) => stage(svc, 'budget')(payload.goalId === undefined ? undefined : id(payload.goalId), payload.runId === undefined ? undefined : id(payload.runId)));
  handle(IPC_AUTONOMY.EXPLORATION_PLAN, ['goalId', 'protocol'], ({ payload, expectedRevision }, svc, callerId) => {
    if (payload.protocol !== undefined && payload.protocol !== 'chat-completions' && payload.protocol !== 'responses') invalid();
    return stage(svc, 'planExploration')(id(payload.goalId), requiredRevision(expectedRevision), payload.protocol ?? 'chat-completions', callerId);
  });
  handle(IPC_AUTONOMY.EXPLORATION_START, ['planId', 'confirmed'], ({ payload, expectedRevision }, svc, callerId) => { if (payload.confirmed !== true) invalid(); return stage(svc, 'startExploration')(id(payload.planId), requiredRevision(expectedRevision), callerId); }, true);
  handle(IPC_AUTONOMY.EXPLORATION_STOP, ['runId'], ({ payload }, svc) => stage(svc, 'stopExploration')(id(payload.runId)), true);
  handle(IPC_AUTONOMY.EXPLORATION_LIST, ['goalId'], ({ payload }, svc) => stage(svc, 'listExplorations')(payload.goalId === undefined ? undefined : id(payload.goalId)));
  handle(IPC_AUTONOMY.PUBLIC_APPEND, ['runId', 'messageId', 'text', 'confirmedPublic'], ({ payload }, svc, callerId) => {
    if (payload.confirmedPublic !== true) invalid(); return stage(svc, 'appendPublicMessage')(id(payload.runId), id(payload.messageId), text(payload.text, 4000), true, callerId);
  }, true);
}
