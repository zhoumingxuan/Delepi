import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { PUBLIC_CAPABILITIES, type ApprovalChoice, type ApprovalPreview, type BudgetAmounts, type DecisionReceipt, type GrantProjection, type ModelDestination, type PermissionPolicy, type PublicAction, type PublicResource, type RuleDraft, type RulePreview, type StandingRule } from '@shared/types/autonomy';
import type { TaskRunContext } from '../tasks/types';
import { appendAutonomyAudit } from '../goals/autonomy-store';
import { LEGACY_TOOL_GROUPS, LEGACY_OS_IDS, normalizeLegacyDeny } from './legacy-policy';
import { canonicalPermissionJson, permissionDate, permissionHash, permissionId, permissionInteger, permissionObject, permissionText, PermissionError } from './permission-validation';

type Row = Record<string, unknown>;
export type OperationOutcome = 'completed' | 'failed' | 'cancelled' | 'unknown' | 'not_started';
export interface OperationUsage { known?: Partial<BudgetAmounts>; unknown?: Partial<BudgetAmounts> }
export interface AuthorityBudget {
  reserveInTransaction(operationId: string, action: PublicAction, context: TaskRunContext): string;
  settleInTransaction(operationId: string, outcome: OperationOutcome, usage?: OperationUsage): void;
  reconcileInterruptedInTransaction?(): void;
}
export interface PreparedOperation { operationId: string; leaseId: string; expiresAt: string; signal: AbortSignal }
export interface AuthorityOptions {
  taskService: { ownerId: string; isCurrent(context: TaskRunContext, options?: { allowStopping?: boolean; allowTerminal?: boolean }): boolean; getTrustedContext(attemptId: string): TaskRunContext | null };
  budget?: AuthorityBudget; now?: () => number; uuid?: () => string; wake?: () => void;
  resolveDestination?: (id: string) => { revision: number; configHash: string };
}
const amountKeys = ['modelRequests', 'fetchRequests', 'downloadBytes', 'storageBytes', 'tokenUnits'] as const;
const identityKeys = ['runId', 'attemptId', 'taskId', 'conversationId', 'ownerId', 'generation', 'parentAttemptId', 'delegateCallId'] as const;
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const capabilities = (raw: unknown): PublicAction['capability'][] => {
  if (!Array.isArray(raw) || !raw.length || raw.length > PUBLIC_CAPABILITIES.length || new Set(raw).size !== raw.length
    || raw.some(value => !(PUBLIC_CAPABILITIES as readonly unknown[]).includes(value))) throw new PermissionError('INVALID_REQUEST');
  return [...raw].sort() as PublicAction['capability'][];
};

/** The only producer of public grants/leases. It does no network, filesystem or agent execution. */
export function createPermissionAuthority(db: Database.Database, options: AuthorityOptions) {
  const now = options.now ?? Date.now, uuid = options.uuid ?? randomUUID;
  const blocked = new Set<string>();
  const controllers = new Map<string, AbortController>();
  const ownership = new Map<string, { goalId: string; runId: string; leaseId: string; context: TaskRunContext; grantId?: string; ruleId?: string }>();
  const leaseOperations = new Map<string, string>();
  const leaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let previewOwnership = new WeakMap<ApprovalPreview, { id: string; context: TaskRunContext }>();
  const listeners = new Set<() => void>();
  let failedPolicyClose: PermissionPolicy | undefined;
  let disposed = false;
  let lastClock = 0;
  const clock = () => (lastClock = Math.max(lastClock, now()));
  const at = () => new Date(clock()).toISOString();
  const row = (sql: string, ...args: Array<string | number>): Row | undefined => db.prepare(sql).get(...args) as Row | undefined;
  const audit = (kind: string, refs: Record<string, string | number | boolean>, context?: TaskRunContext) => {
    appendAutonomyAudit(db, kind, refs, context, at());
  };
  const changed = () => { try { options.wake?.(); } catch { /* durable pull is authoritative */ } for (const notify of listeners) { try { notify(); } catch { /* listeners cannot reverse a commit */ } } };
  const transaction = <T>(callback: () => T): T => { if (disposed) throw new PermissionError('AUTHORITY_CLOSED'); const result = db.transaction(callback)(); if (!db.inTransaction) changed(); return result; };
  const releaseOperation = (operationId: string) => {
    const own = ownership.get(operationId);
    if (own) leaseOperations.delete(own.leaseId);
    controllers.delete(operationId); ownership.delete(operationId);
    clearTimeout(leaseTimers.get(operationId)); leaseTimers.delete(operationId);
  };
  const memoryOwnsLease = (leaseId: string, context: TaskRunContext): string | undefined => {
    const operationId = leaseOperations.get(leaseId), own = operationId ? ownership.get(operationId) : undefined;
    return own && context.ownerId === options.taskService.ownerId && identityKeys.every(key => context[key] === own.context[key]) ? operationId : undefined;
  };
  const requireFresh = (value: unknown) => { if (Date.parse(String(value)) <= clock() || !Number.isFinite(Date.parse(String(value)))) throw new PermissionError('APPROVAL_EXPIRED'); };
  const getResource = (id: string): PublicResource => {
    const value = row('SELECT * FROM m2_resources WHERE id=?', permissionId(id));
    if (!value) throw new PermissionError('RESOURCE_NOT_FOUND');
    return { id: String(value.id), goalId: String(value.goal_id), dataScopeId: String(value.data_scope_id), kind: value.kind as PublicResource['kind'], ...(value.url ? { url: String(value.url) } : {}), contentHash: String(value.content_hash), sizeBytes: Number(value.size_bytes), revision: Number(value.revision), ...(value.parent_id ? { parentId: String(value.parent_id) } : {}) };
  };
  const resourceVersion = (resource: PublicResource) => `${resource.revision}:${resource.contentHash}`;
  const destination = (id: string): ModelDestination & { configHash: string } => {
    const current = options.resolveDestination?.(id);
    const value = row('SELECT * FROM m2_model_destinations WHERE id=?', permissionId(id));
    if (!value) throw new PermissionError('DESTINATION_NOT_FOUND');
    if (current && (current.revision !== Number(value.revision) || current.configHash !== value.config_hash)) throw new PermissionError('DESTINATION_CHANGED');
    const endpoint = new URL(String(value.endpoint));
    return { id: String(value.id), label: String(value.source_key), endpointOrigin: endpoint.origin, model: String(value.model), revision: Number(value.revision), available: true, configHash: String(value.config_hash) };
  };
  function legacyPolicy() {
    const legacyRow = row("SELECT value_json FROM settings WHERE key='permissionPolicy'");
    try { return normalizeLegacyDeny(legacyRow ? parse(legacyRow.value_json) : undefined); }
    catch { return normalizeLegacyDeny(null); }
  }
  function getPolicy(): PermissionPolicy {
    const value = row('SELECT * FROM m2_permission_policy WHERE id=1');
    if (!value) throw new PermissionError('POLICY_NOT_READY');
    const saved = parse<Row>(value.policy_json);
    if (!Array.isArray(saved.deniedCapabilities) || saved.deniedCapabilities.some(item => !(PUBLIC_CAPABILITIES as readonly unknown[]).includes(item))
      || !Array.isArray(saved.deniedLegacyTools) || saved.deniedLegacyTools.some(item => !(LEGACY_TOOL_GROUPS as readonly unknown[]).includes(item))) throw new PermissionError('POLICY_INVALID');
    const legacy = legacyPolicy();
    const denied = new Set(saved.deniedCapabilities as PublicAction['capability'][]);
    if (legacy.denyAll) for (const capability of PUBLIC_CAPABILITIES) denied.add(capability);
    if (legacy.deniedToolGroups.includes('localFiles')) { denied.add('file.read_public'); denied.add('artifact.publish'); }
    if (failedPolicyClose) for (const capability of failedPolicyClose.deniedCapabilities) denied.add(capability);
    const warnings = [...legacy.warnings, ...(legacy.assistantRequestsDenied ? ['旧权限策略已关闭助手申请权限'] : []), ...(legacy.deniedOSRequests.length ? [`旧权限策略已关闭系统权限申请：${legacy.deniedOSRequests.join('、')}`] : []), ...(legacy.deniedOSUse.length ? [`旧权限策略已关闭系统能力使用：${legacy.deniedOSUse.join('、')}`] : [])];
    return { revision: Number(value.revision), deniedCapabilities: [...denied].sort(), deniedLegacyTools: [...new Set([...(saved.deniedLegacyTools as PermissionPolicy['deniedLegacyTools']), ...legacy.deniedToolGroups, ...(failedPolicyClose?.deniedLegacyTools ?? [])])].sort(), warnings };
  }
  const policyHash = () => permissionHash(getPolicy());
  const assertCapability = (capability: PublicAction['capability']) => { if (getPolicy().deniedCapabilities.includes(capability)) throw new PermissionError('POLICY_BLOCKED'); };
  function validateAction(raw: PublicAction): PublicAction {
    const value = permissionObject(raw, ['capability', 'resourceRef', 'resourceVersion', 'destinationRef', 'payloadHash', 'summary', 'units']);
    if (!(PUBLIC_CAPABILITIES as readonly unknown[]).includes(value.capability)) throw new PermissionError('MODE_BLOCKED');
    const units = permissionObject(value.units, amountKeys);
    const amounts = Object.fromEntries(amountKeys.map(key => [key, permissionInteger(units[key])])) as unknown as BudgetAmounts;
    const action: PublicAction = { capability: value.capability as PublicAction['capability'], resourceRef: permissionId(value.resourceRef), resourceVersion: permissionText(value.resourceVersion, 200), summary: permissionText(value.summary, 500), units: amounts };
    if (value.destinationRef !== undefined) action.destinationRef = permissionId(value.destinationRef);
    if (value.payloadHash !== undefined) {
      if (typeof value.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.payloadHash)) throw new PermissionError('INVALID_REQUEST');
      action.payloadHash = value.payloadHash;
    }
    if (action.capability === 'model.invoke' && (!action.destinationRef || !action.payloadHash)) throw new PermissionError('INVALID_REQUEST');
    if (action.capability === 'artifact.publish' && !action.payloadHash) throw new PermissionError('INVALID_REQUEST');
    return action;
  }
  function scopeFor(context: TaskRunContext) {
    if (!options.taskService.isCurrent(context) || context.ownerId !== options.taskService.ownerId) throw new PermissionError('STALE_TASK_ATTEMPT');
    const binding = row('SELECT * FROM m2_run_scopes WHERE run_id=?', context.runId);
    if (!binding || binding.mode !== 'public' || binding.owner_id !== context.ownerId || Number(binding.generation) !== context.generation) throw new PermissionError('MODE_BLOCKED');
    const goal = row('SELECT * FROM m2_goals WHERE id=?', String(binding.goal_id));
    const data = row('SELECT * FROM m2_data_scopes WHERE id=?', String(binding.data_scope_id));
    if (!goal || goal.state !== 'active' || Number(goal.revision) !== Number(binding.goal_revision)) throw new PermissionError('GOAL_CHANGED');
    if (!data || data.classification !== 'public' || data.goal_id !== goal.id || data.id !== goal.data_scope_id || data.destination_id !== binding.destination_id) throw new PermissionError('SCOPE_BLOCKED');
    requireFresh(binding.deadline_at);
    return { binding, goal, data };
  }
  function assertAction(context: TaskRunContext, action: PublicAction) {
    const scope = scopeFor(context); assertCapability(action.capability);
    const allowedUses = parse<unknown>(scope.data.allowed_uses_json);
    if (!Array.isArray(allowedUses) || !allowedUses.includes(action.capability)) throw new PermissionError('SCOPE_BLOCKED');
    const resource = getResource(action.resourceRef);
    if (resource.goalId !== scope.goal.id || resource.dataScopeId !== scope.data.id || resourceVersion(resource) !== action.resourceVersion) throw new PermissionError('RESOURCE_CHANGED');
    if (action.destinationRef !== undefined && action.destinationRef !== scope.binding.destination_id) throw new PermissionError('DESTINATION_CHANGED');
    const model = destination(String(scope.binding.destination_id));
    const snapshot = parse<{ resources: PublicResource[]; destination?: { id: string; revision: number; configHash: string } }>(scope.binding.snapshot_json);
    if (!snapshot.destination || snapshot.destination.id !== model.id || snapshot.destination.revision !== model.revision || snapshot.destination.configHash !== model.configHash) throw new PermissionError('DESTINATION_CHANGED');
    if (!Array.isArray(snapshot.resources)) throw new PermissionError('SCOPE_BLOCKED');
    const pinned = new Map(snapshot.resources.map(value => [value.id, value]));
    const assertPinned = (value: PublicResource) => {
      const old = pinned.get(value.id);
      if (!old || old.kind !== value.kind || resourceVersion(old) !== resourceVersion(value)) throw new PermissionError('RESOURCE_CHANGED');
    };
    if (action.capability === 'fetch.public') { if (resource.kind !== 'public_url' || !pinned.has(resource.id)) throw new PermissionError('SCOPE_BLOCKED'); assertPinned(resource); }
    if (action.capability === 'file.read_public') {
      if (resource.kind !== 'public_snapshot' || !resource.parentId) throw new PermissionError('SCOPE_BLOCKED');
      const parent = getResource(resource.parentId);
      if (parent.kind !== 'public_url' || !pinned.has(parent.id) || parent.goalId !== resource.goalId || parent.dataScopeId !== resource.dataScopeId) throw new PermissionError('SCOPE_BLOCKED');
      assertPinned(parent);
    }
    if (action.capability === 'model.invoke' || action.capability === 'artifact.publish') {
      const internal = row('SELECT file_path FROM m2_resources WHERE id=?', resource.id)!;
      if (resource.kind !== 'artifact' || !pinned.has(resource.id) || internal.file_path !== null) throw new PermissionError('SCOPE_BLOCKED');
      assertPinned(resource);
    }
    return { ...scope, resource, model };
  }
  const actionKey = (action: PublicAction) => permissionHash(action);
  function projection(value: Row): ApprovalPreview {
    const intent = parse<{ action: PublicAction; resourceLabel: string; destinationLabel?: string; authorizationExpiresAt: string }>(value.intent_json);
    const state = value.state === 'pending' && Date.parse(String(value.expires_at)) <= clock() ? 'expired'
      : value.state === 'pending' && blocked.has(String(value.id)) ? 'revoked' : value.state as ApprovalPreview['state'];
    return { id: String(value.id), revision: Number(value.revision), state, goalId: String(value.goal_id), goalRevision: Number(value.goal_revision), runId: String(value.run_id), attemptId: String(value.attempt_id), action: intent.action, resourceLabel: intent.resourceLabel, ...(intent.destinationLabel ? { destinationLabel: intent.destinationLabel } : {}), expiresAt: String(value.expires_at), authorizationExpiresAt: intent.authorizationExpiresAt, createdAt: String(value.created_at) };
  }
  function previewAction(context: TaskRunContext, rawAction: PublicAction, callerId: number): ApprovalPreview {
    permissionInteger(callerId); const action = validateAction(rawAction);
    const preview = transaction(() => {
      if (legacyPolicy().assistantRequestsDenied) throw new PermissionError('POLICY_BLOCKED');
      const scope = assertAction(context, action), policy = getPolicy();
      const previous = row('SELECT * FROM m2_approval_previews WHERE attempt_id=? AND intent_hash=? AND caller_id=? AND policy_revision=? AND generation=? ORDER BY created_at DESC LIMIT 1', context.attemptId, actionKey(action), callerId, policy.revision, context.generation);
      if (previous && previous.owner_id === context.ownerId && Date.parse(String(previous.expires_at)) > clock()
        && parse<{ policyHash: string }>(previous.intent_json).policyHash === policyHash()) {
        if (previous.state === 'rejected') throw new PermissionError('APPROVAL_REJECTED');
        if (previous.state === 'pending') return projection(previous);
      }
      const id = uuid(), createdAt = at(), expiresAt = new Date(Math.min(clock() + 120000, Date.parse(String(scope.binding.deadline_at)))).toISOString();
      const parent = scope.resource.kind === 'public_snapshot' && scope.resource.parentId ? getResource(scope.resource.parentId) : undefined;
      const intent = { action, authorizationExpiresAt: String(scope.binding.deadline_at), resourceLabel: parent ? `${parent.url ?? parent.id} · 公开副本 ${scope.resource.contentHash.slice(0, 12)}` : scope.resource.url ?? scope.resource.id,
        ...(parent ? { derivedParent: { id: parent.id, version: resourceVersion(parent) } } : {}),
        ...(action.destinationRef ? { destinationLabel: `${scope.model.label} · ${scope.model.endpointOrigin} · ${scope.model.model}` } : {}), destinationVersion: `${scope.model.revision}:${scope.model.configHash}`, policyHash: policyHash() };
      db.prepare('INSERT INTO m2_approval_previews(id,run_id,attempt_id,owner_id,generation,goal_id,goal_revision,policy_revision,caller_id,intent_hash,intent_json,revision,state,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,\'pending\',?,?)')
        .run(id, context.runId, context.attemptId, context.ownerId, context.generation, String(scope.goal.id), Number(scope.goal.revision), policy.revision, callerId, actionKey(action), canonicalPermissionJson(intent), expiresAt, createdAt);
      audit('approval.pending', { previewId: id }, context);
      return projection(row('SELECT * FROM m2_approval_previews WHERE id=?', id)!);
    });
    // Main-process object identity is the only fallback proof when the first durable card read fails.
    // Context stays in this WeakMap and is never added to the renderer DTO.
    previewOwnership.set(preview, { id: preview.id, context: Object.freeze({ ...context }) });
    return preview;
  }
  function contextForPreview(preview: Row): TaskRunContext {
    const context = options.taskService.getTrustedContext(String(preview.attempt_id));
    if (!context || context.ownerId !== preview.owner_id || context.runId !== preview.run_id || context.generation !== Number(preview.generation)) throw new PermissionError('STALE_TASK_ATTEMPT');
    return context;
  }
  function decideApproval(previewId: string, expectedRevision: number, choice: ApprovalChoice, callerId: number): DecisionReceipt {
    permissionId(previewId); permissionInteger(expectedRevision); permissionInteger(callerId);
    if (!['once', 'run', 'reject'].includes(choice)) throw new PermissionError('INVALID_REQUEST');
    return transaction(() => {
      const preview = row('SELECT * FROM m2_approval_previews WHERE id=?', previewId);
      if (!preview) throw new PermissionError('APPROVAL_NOT_FOUND');
      if (Number(preview.caller_id) !== callerId || preview.owner_id !== options.taskService.ownerId) throw new PermissionError('UNTRUSTED_CALLER');
      if (Number(preview.revision) !== expectedRevision) throw new PermissionError('REVISION_CONFLICT', Number(preview.revision));
      if (preview.state !== 'pending' || blocked.has(previewId)) throw new PermissionError('APPROVAL_NOT_PENDING');
      if (legacyPolicy().assistantRequestsDenied) throw new PermissionError('POLICY_BLOCKED');
      requireFresh(preview.expires_at);
      const context = contextForPreview(preview), intent = parse<{ action: PublicAction; destinationVersion: string; policyHash: string; authorizationExpiresAt: string }>(preview.intent_json);
      const scope = assertAction(context, intent.action);
      if (Number(scope.goal.revision) !== Number(preview.goal_revision) || getPolicy().revision !== Number(preview.policy_revision)
        || policyHash() !== intent.policyHash || `${scope.model.revision}:${scope.model.configHash}` !== intent.destinationVersion) throw new PermissionError('APPROVAL_CHANGED');
      requireFresh(intent.authorizationExpiresAt);
      let grantId: string | undefined;
      if (choice !== 'reject') {
        grantId = uuid();
        db.prepare('INSERT INTO m2_grants(id,preview_id,run_id,goal_id,owner_id,generation,scope,action_hash,action_json,policy_revision,revision,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,\'active\',?,?,?)')
          .run(grantId, previewId, context.runId, String(scope.goal.id), context.ownerId, context.generation, choice, String(preview.intent_hash), String(preview.intent_json), Number(preview.policy_revision), choice === 'run' ? intent.authorizationExpiresAt : new Date(Math.min(clock() + 120000, Date.parse(intent.authorizationExpiresAt))).toISOString(), at(), at());
      }
      const state = choice === 'reject' ? 'rejected' : 'approved';
      db.prepare('UPDATE m2_approval_previews SET state=?,revision=revision+1 WHERE id=? AND revision=?').run(state, previewId, expectedRevision);
      audit(`approval.${state}`, { previewId, ...(grantId ? { grantId } : {}) }, context);
      return { previewId, state, ...(grantId ? { grantId } : {}), revision: expectedRevision + 1 };
    });
  }
  const ruleProjection = (value: Row): StandingRule => {
    const scope = parse<RulePreview>(value.scope_json);
    return { id: String(value.id), revision: Number(value.revision), goalId: String(value.goal_id), goalRevision: Number(value.goal_revision), state: value.state === 'active' && Date.parse(String(value.expires_at)) <= clock() ? 'expired' : value.state as StandingRule['state'], capabilities: scope.capabilities, resourceRefs: scope.resources.map(item => item.id), destinationId: scope.destination.id, limits: scope.limits, expiresAt: String(value.expires_at), resumeAfterRestart: Boolean(value.resume_after_restart), createdAt: String(value.created_at) };
  };
  function previewRule(raw: RuleDraft, callerId: number): RulePreview {
    permissionInteger(callerId); const draft = permissionObject(raw, ['goalId', 'expectedGoalRevision', 'capabilities', 'resourceRefs', 'expiresAt', 'resumeAfterRestart']);
    const goalId = permissionId(draft.goalId), revision = permissionInteger(draft.expectedGoalRevision), caps = capabilities(draft.capabilities), expiresAt = permissionDate(draft.expiresAt);
    if (typeof draft.resumeAfterRestart !== 'boolean' || !Array.isArray(draft.resourceRefs) || !draft.resourceRefs.length || draft.resourceRefs.length > 100 || new Set(draft.resourceRefs).size !== draft.resourceRefs.length) throw new PermissionError('INVALID_REQUEST');
    requireFresh(expiresAt);
    return transaction(() => {
      const goal = row('SELECT * FROM m2_goals WHERE id=?', goalId);
      if (!goal || goal.state !== 'active') throw new PermissionError('GOAL_CHANGED');
      if (Number(goal.revision) !== revision) throw new PermissionError('REVISION_CONFLICT', Number(goal.revision));
      for (const capability of caps) assertCapability(capability);
      const resources = (draft.resourceRefs as unknown[]).map(ref => getResource(permissionId(ref)));
      if (resources.some(resource => resource.goalId !== goalId || resource.dataScopeId !== goal.data_scope_id)) throw new PermissionError('SCOPE_BLOCKED');
      const model = destination(String(goal.destination_id)), id = uuid(), previewExpiresAt = new Date(Math.min(clock() + 600000, Date.parse(expiresAt))).toISOString();
      const scope: RulePreview & { policyHash: string; destinationVersion: string } = { id, revision: 1, goalId, goalRevision: revision, capabilities: caps, resources, destination: model, limits: parse(goal.limits_json), expiresAt, previewExpiresAt, resumeAfterRestart: draft.resumeAfterRestart === true, policyHash: policyHash(), destinationVersion: `${model.revision}:${model.configHash}` };
      db.prepare('INSERT INTO m2_rule_previews(id,caller_id,goal_id,goal_revision,policy_revision,scope_json,revision,state,expires_at,created_at) VALUES(?,?,?,?,?,?,1,\'pending\',?,?)')
        .run(id, callerId, goalId, revision, getPolicy().revision, canonicalPermissionJson(scope), previewExpiresAt, at());
      audit('rule.previewed', { previewId: id, goalId });
      return { id, revision: 1, goalId, goalRevision: revision, capabilities: caps, resources, destination: { id: model.id, label: model.label, endpointOrigin: model.endpointOrigin, model: model.model, revision: model.revision, available: model.available }, limits: scope.limits, expiresAt, previewExpiresAt, resumeAfterRestart: scope.resumeAfterRestart };
    });
  }
  function assertRuleScope(rule: Row, action?: PublicAction, context?: TaskRunContext) {
    if (rule.state !== 'active' || blocked.has(String(rule.id))) throw new PermissionError('AUTHORIZATION_REVOKED');
    requireFresh(rule.expires_at);
    const scope = parse<RulePreview & { policyHash: string; destinationVersion: string }>(rule.scope_json);
    const goal = row('SELECT * FROM m2_goals WHERE id=?', scope.goalId);
    if (!goal || goal.state !== 'active' || Number(goal.revision) !== scope.goalRevision || getPolicy().revision !== Number(rule.policy_revision) || policyHash() !== scope.policyHash) throw new PermissionError('AUTHORIZATION_CHANGED');
    const data = row('SELECT * FROM m2_data_scopes WHERE id=?', String(goal.data_scope_id));
    const allowedUses = data ? parse<unknown>(data.allowed_uses_json) : undefined;
    if (!data || data.classification !== 'public' || data.goal_id !== goal.id || data.destination_id !== goal.destination_id
      || scope.destination.id !== goal.destination_id || !Array.isArray(allowedUses) || scope.capabilities.some(capability => !allowedUses.includes(capability))
      || permissionHash(scope.limits) !== permissionHash(parse(goal.limits_json))) throw new PermissionError('AUTHORIZATION_CHANGED');
    const model = destination(scope.destination.id);
    if (`${model.revision}:${model.configHash}` !== scope.destinationVersion) throw new PermissionError('DESTINATION_CHANGED');
    for (const resource of scope.resources) {
      const actual = getResource(resource.id);
      if (actual.goalId !== goal.id || actual.dataScopeId !== goal.data_scope_id || actual.kind !== resource.kind || resourceVersion(actual) !== resourceVersion(resource)) throw new PermissionError('RESOURCE_CHANGED');
    }
    if (action) {
      if (!scope.capabilities.includes(action.capability)) throw new PermissionError('AUTHORIZATION_REQUIRED');
      let resource = getResource(action.resourceRef), count = 0;
      const allowed = new Set(scope.resources.map(item => item.id));
      while (!allowed.has(resource.id) && resource.parentId && count++ < 20) resource = getResource(resource.parentId);
      if (!allowed.has(resource.id) || (context && scopeFor(context).goal.id !== scope.goalId)) throw new PermissionError('AUTHORIZATION_REQUIRED');
    }
    return scope;
  }
  function issueRule(previewId: string, expectedRevision: number, callerId: number): StandingRule {
    return transaction(() => {
      const preview = row('SELECT * FROM m2_rule_previews WHERE id=?', permissionId(previewId));
      if (!preview) throw new PermissionError('APPROVAL_NOT_FOUND');
      if (Number(preview.caller_id) !== permissionInteger(callerId)) throw new PermissionError('UNTRUSTED_CALLER');
      if (Number(preview.revision) !== permissionInteger(expectedRevision)) throw new PermissionError('REVISION_CONFLICT', Number(preview.revision));
      if (preview.state !== 'pending') throw new PermissionError('APPROVAL_NOT_PENDING');
      requireFresh(preview.expires_at);
      const scope = assertRuleScope({ ...preview, state: 'active' }); requireFresh(scope.expiresAt);
      const id = uuid();
      db.prepare('INSERT INTO m2_standing_rules(id,preview_id,goal_id,goal_revision,policy_revision,revision,scope_json,state,expires_at,resume_after_restart,created_at,updated_at) VALUES(?,?,?,?,?,1,?,\'active\',?,?,?,?)')
        .run(id, previewId, scope.goalId, scope.goalRevision, Number(preview.policy_revision), String(preview.scope_json), scope.expiresAt, scope.resumeAfterRestart ? 1 : 0, at(), at());
      db.prepare("UPDATE m2_rule_previews SET state='issued',revision=revision+1 WHERE id=?").run(previewId);
      audit('rule.issued', { ruleId: id, goalId: scope.goalId });
      return ruleProjection(row('SELECT * FROM m2_standing_rules WHERE id=?', id)!);
    });
  }
  function grantMatches(value: Row, context: TaskRunContext, action: PublicAction): boolean {
    if (value.state !== 'active' || blocked.has(String(value.id)) || value.run_id !== context.runId || value.owner_id !== context.ownerId || Number(value.generation) !== context.generation
      || Number(value.policy_revision) !== getPolicy().revision) return false;
    const intent = parse<{ action: PublicAction; destinationVersion: string; policyHash: string; derivedParent?: { id: string; version: string } }>(value.action_json), model = destination(String(scopeFor(context).binding.destination_id));
    if (value.scope === 'once') {
      const preview = row('SELECT attempt_id FROM m2_approval_previews WHERE id=?', String(value.preview_id));
      if (!preview || preview.attempt_id !== context.attemptId || value.action_hash !== actionKey(action)) return false;
    } else if (value.action_hash !== actionKey(action)) {
      const approved = intent.action;
      if (approved.capability !== action.capability || approved.destinationRef !== action.destinationRef || approved.payloadHash !== action.payloadHash
        || amountKeys.some(key => action.units[key] > approved.units[key])) return false;
      const original = getResource(approved.resourceRef);
      if (resourceVersion(original) !== approved.resourceVersion) return false;
      const parent = intent.derivedParent ? getResource(intent.derivedParent.id) : original;
      if (parent.kind !== 'public_url' || resourceVersion(parent) !== (intent.derivedParent?.version ?? approved.resourceVersion)) return false;
      const derived = getResource(action.resourceRef);
      if (derived.kind !== 'public_snapshot' || derived.parentId !== parent.id || derived.goalId !== parent.goalId || derived.dataScopeId !== parent.dataScopeId) return false;
    }
    return Date.parse(String(value.expires_at)) > clock() && intent.policyHash === policyHash() && intent.destinationVersion === `${model.revision}:${model.configHash}`;
  }
  function prepare(context: TaskRunContext, rawAction: PublicAction): PreparedOperation {
    if (!options.budget) throw new PermissionError('BUDGET_NOT_READY');
    const action = validateAction(rawAction), controller = new AbortController();
    const prepared = transaction(() => {
      const scope = assertAction(context, action);
      const grant = (db.prepare("SELECT * FROM m2_grants WHERE run_id=? AND state='active' ORDER BY scope='once' DESC,created_at").all(context.runId) as Row[]).find(value => grantMatches(value, context, action));
      let rule: Row | undefined;
      if (!grant) rule = (db.prepare("SELECT * FROM m2_standing_rules WHERE goal_id=? AND state='active' ORDER BY created_at").all(String(scope.goal.id)) as Row[]).find(value => { try { assertRuleScope(value, action, context); return true; } catch (error) { if (error instanceof PermissionError) return false; throw error; } });
      if (!grant && !rule) throw new PermissionError('AUTHORIZATION_REQUIRED');
      const operationId = uuid(), leaseId = uuid();
      const reservation = options.budget!.reserveInTransaction(operationId, action, context);
      if (typeof reservation !== 'string' || !reservation) throw new PermissionError('BUDGET_NOT_READY');
      let revision = Number((grant ?? rule)!.revision);
      if (grant?.scope === 'once') {
        const update = db.prepare("UPDATE m2_grants SET state='consumed',revision=revision+1,updated_at=? WHERE id=? AND state='active' AND revision=?").run(at(), String(grant.id), revision);
        if (update.changes !== 1) throw new PermissionError('AUTHORIZATION_CONSUMED'); revision++;
      }
      const expiresAt = new Date(Math.min(Date.parse(String((grant ?? rule)!.expires_at)), Date.parse(String(scope.binding.deadline_at)))).toISOString();
      db.prepare('INSERT INTO m2_operations(id,run_id,attempt_id,owner_id,generation,goal_id,intent_hash,intent_json,grant_id,rule_id,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,\'prepared\',?)')
        .run(operationId, context.runId, context.attemptId, context.ownerId, context.generation, String(scope.goal.id), actionKey(action), canonicalPermissionJson(action), grant ? String(grant.id) : null, rule ? String(rule.id) : null, at());
      db.prepare('INSERT INTO m2_leases(id,operation_id,run_id,attempt_id,owner_id,generation,grant_id,rule_id,auth_revision,policy_revision,state,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,\'active\',?,?)')
        .run(leaseId, operationId, context.runId, context.attemptId, context.ownerId, context.generation, grant ? String(grant.id) : null, rule ? String(rule.id) : null, revision, getPolicy().revision, expiresAt, at());
      audit('operation.prepared', { operationId, leaseId }, context);
      return { operationId, leaseId, expiresAt, signal: controller.signal, ownership: { goalId: String(scope.goal.id), runId: context.runId, leaseId, context: Object.freeze({ ...context }), ...(grant ? { grantId: String(grant.id) } : {}), ...(rule ? { ruleId: String(rule.id) } : {}) } };
    });
    controllers.set(prepared.operationId, controller);
    ownership.set(prepared.operationId, prepared.ownership);
    leaseOperations.set(prepared.leaseId, prepared.operationId);
    const timer = setTimeout(() => { controller.abort(new PermissionError('APPROVAL_EXPIRED')); }, Math.max(1, Date.parse(prepared.expiresAt) - clock()));
    timer.unref(); leaseTimers.set(prepared.operationId, timer); return { operationId: prepared.operationId, leaseId: prepared.leaseId, expiresAt: prepared.expiresAt, signal: prepared.signal };
  }
  function assertLease(leaseId: string, context: TaskRunContext): PreparedOperation {
    const lease = row('SELECT * FROM m2_leases WHERE id=?', permissionId(leaseId));
    if (!lease || lease.owner_id !== context.ownerId || lease.run_id !== context.runId || lease.attempt_id !== context.attemptId || Number(lease.generation) !== context.generation) throw new PermissionError('LEASE_INVALID');
    if (lease.state !== 'active' || blocked.has(String(lease.grant_id)) || blocked.has(String(lease.rule_id))) throw new PermissionError('AUTHORIZATION_REVOKED');
    requireFresh(lease.expires_at);
    const operation = row('SELECT * FROM m2_operations WHERE id=?', String(lease.operation_id));
    if (!operation || !['prepared', 'started'].includes(String(operation.state))) throw new PermissionError('LEASE_INVALID');
    const action = parse<PublicAction>(operation.intent_json); assertAction(context, action);
    if (getPolicy().revision !== Number(lease.policy_revision)) throw new PermissionError('AUTHORIZATION_CHANGED');
    if (lease.grant_id) {
      const grant = row('SELECT * FROM m2_grants WHERE id=?', String(lease.grant_id));
      if (!grant || !['active', 'consumed'].includes(String(grant.state)) || Number(grant.revision) !== Number(lease.auth_revision)
        || !grantMatches({ ...grant, state: 'active' }, context, action)) throw new PermissionError('AUTHORIZATION_CHANGED');
    } else {
      const rule = row('SELECT * FROM m2_standing_rules WHERE id=?', String(lease.rule_id));
      if (!rule || Number(rule.revision) !== Number(lease.auth_revision)) throw new PermissionError('AUTHORIZATION_CHANGED');
      assertRuleScope(rule, action, context);
    }
    const controller = controllers.get(String(operation.id));
    if (!controller || controller.signal.aborted) throw new PermissionError('AUTHORIZATION_REVOKED');
    return { operationId: String(operation.id), leaseId: String(lease.id), expiresAt: String(lease.expires_at), signal: controller.signal };
  }
  function markStarted(leaseId: string, context: TaskRunContext): void {
    transaction(() => {
      const lease = assertLease(leaseId, context);
      const update = db.prepare("UPDATE m2_operations SET state='started',started_at=? WHERE id=? AND state='prepared'").run(at(), lease.operationId);
      if (update.changes !== 1) throw new PermissionError('OPERATION_ALREADY_STARTED');
      audit('operation.started', { operationId: lease.operationId }, context);
    });
  }
  function settle(leaseId: string, context: TaskRunContext, outcome: OperationOutcome, usage?: OperationUsage): void {
    if (!['completed', 'failed', 'cancelled', 'unknown', 'not_started'].includes(outcome)) throw new PermissionError('INVALID_REQUEST');
    permissionId(leaseId);
    const unconfirmed = (operationId: string) => {
      const controller = controllers.get(operationId);
      releaseOperation(operationId);
      controller?.abort(new PermissionError('PERSISTENCE_FAILED'));
      try { transaction(() => {
        db.prepare("UPDATE m2_operations SET state='outcome_unknown',result_kind='settlement-unconfirmed',settled_at=? WHERE id=? AND state IN ('prepared','started')").run(at(), operationId);
        db.prepare("UPDATE m2_leases SET state='invalid' WHERE id=?").run(leaseId);
        audit('operation.outcome_unknown', { operationId }, context);
      }); } catch { /* prepared/started remains durable for startup reconciliation */ }
    };
    // Database faults can precede durable identity reads. Only the complete identity minted here may fence its own lease.
    const read = <T>(callback: () => T): T => {
      try { return callback(); }
      catch (error) { const owned = memoryOwnsLease(leaseId, context); if (owned) unconfirmed(owned); throw error; }
    };
    const lease = read(() => row('SELECT * FROM m2_leases WHERE id=?', leaseId));
    if (!lease || lease.owner_id !== context.ownerId || lease.attempt_id !== context.attemptId || lease.run_id !== context.runId || Number(lease.generation) !== context.generation || context.ownerId !== options.taskService.ownerId
      || !read(() => options.taskService.isCurrent(context, { allowStopping: true, allowTerminal: true }))) throw new PermissionError('LEASE_INVALID');
    const operation = read(() => row('SELECT * FROM m2_operations WHERE id=?', String(lease.operation_id)));
    if (!operation || !['prepared', 'started'].includes(String(operation.state))) throw new PermissionError('OPERATION_ALREADY_SETTLED');
    if (outcome === 'not_started' && operation.state === 'started') throw new PermissionError('OPERATION_ALREADY_STARTED');
    try {
      transaction(() => {
        if (!options.budget) throw new PermissionError('BUDGET_NOT_READY');
        const returned = options.budget.settleInTransaction(String(operation.id), outcome, usage) as unknown;
        if (returned && typeof (returned as { then?: unknown }).then === 'function') throw new PermissionError('BUDGET_NOT_READY');
        db.prepare('UPDATE m2_operations SET state=?,result_kind=?,settled_at=? WHERE id=?').run(outcome === 'unknown' ? 'outcome_unknown' : 'settled', outcome, at(), String(operation.id));
        db.prepare("UPDATE m2_leases SET state='settled' WHERE id=?").run(leaseId);
        audit('operation.settled', { operationId: String(operation.id), state: outcome }, context);
      });
      releaseOperation(String(operation.id));
    } catch (error) {
      unconfirmed(String(operation.id));
      throw error;
    }
  }
  function invalidateOperations(kind: 'grant' | 'rule', id: string): void {
    for (const [operationId, own] of ownership) if (kind === 'grant' ? own.grantId === id : own.ruleId === id) controllers.get(operationId)?.abort(new PermissionError('AUTHORIZATION_REVOKED'));
  }
  function cancelGoalOperations(goalId: string): void {
    permissionId(goalId);
    for (const [operationId, own] of ownership) if (own.goalId === goalId) controllers.get(operationId)?.abort(new PermissionError('GOAL_CHANGED'));
    changed();
  }
  function cancelAllPublicOperations(reason='DESTINATION_CHANGED'):void {
    for(const controller of controllers.values())controller.abort(new PermissionError(reason));
    changed();
  }
  function cancelRunOperations(runId: string): void {
    permissionId(runId);
    for (const [operationId, own] of ownership) if (own.runId === runId) controllers.get(operationId)?.abort(new PermissionError('CANCELLED'));
    changed();
  }
  function revoke(kind: 'grant' | 'rule', id: string, expectedRevision: number): void {
    permissionId(id); permissionInteger(expectedRevision);
    const table = kind === 'grant' ? 'm2_grants' : 'm2_standing_rules';
    let value: Row | undefined;
    try { value = row(`SELECT * FROM ${table} WHERE id=?`, id); }
    catch { blocked.add(id); invalidateOperations(kind, id); changed(); throw new PermissionError('PERSISTENCE_FAILED'); }
    if (!value) throw new PermissionError('AUTHORIZATION_NOT_FOUND');
    if (Number(value.revision) !== expectedRevision) throw new PermissionError('REVISION_CONFLICT', Number(value.revision));
    blocked.add(id); invalidateOperations(kind, id);
    try { transaction(() => {
      db.prepare(`UPDATE ${table} SET state='revoked',revision=revision+1,updated_at=? WHERE id=? AND revision=?`).run(at(), id, expectedRevision);
      db.prepare(`UPDATE m2_leases SET state='revoked' WHERE ${kind === 'grant' ? 'grant_id' : 'rule_id'}=? AND state='active'`).run(id);
      audit(`${kind}.revoked`, kind === 'grant' ? { grantId: id } : { ruleId: id });
    }); } catch { changed(); throw new PermissionError('PERSISTENCE_FAILED'); }
  }
  function updatePolicy(expectedRevision: number, raw: Pick<PermissionPolicy, 'deniedCapabilities' | 'deniedLegacyTools'>): PermissionPolicy {
    permissionInteger(expectedRevision); const value = permissionObject(raw, ['deniedCapabilities', 'deniedLegacyTools']);
    for (const [key, allowed] of [['deniedCapabilities', PUBLIC_CAPABILITIES], ['deniedLegacyTools', LEGACY_TOOL_GROUPS]] as const) {
      const list = value[key]; if (!Array.isArray(list) || list.length > allowed.length || new Set(list).size !== list.length || list.some(item => !(allowed as readonly unknown[]).includes(item))) throw new PermissionError('INVALID_REQUEST');
    }
    const current = getPolicy(); if (current.revision !== expectedRevision) throw new PermissionError('REVISION_CONFLICT', current.revision);
    const next = { deniedCapabilities: value.deniedCapabilities, deniedLegacyTools: value.deniedLegacyTools };
    failedPolicyClose = { ...current, deniedCapabilities: [...new Set([...current.deniedCapabilities, ...(next.deniedCapabilities as PermissionPolicy['deniedCapabilities'])])], deniedLegacyTools: [...new Set([...current.deniedLegacyTools, ...(next.deniedLegacyTools as PermissionPolicy['deniedLegacyTools'])])] };
    for (const controller of controllers.values()) controller.abort(new PermissionError('POLICY_CHANGED'));
    try { transaction(() => {
      const update = db.prepare('UPDATE m2_permission_policy SET policy_json=?,revision=revision+1,updated_at=? WHERE id=1 AND revision=?').run(canonicalPermissionJson(next), at(), expectedRevision);
      if (update.changes !== 1) throw new PermissionError('REVISION_CONFLICT');
      audit('policy.changed', { revision: expectedRevision + 1 });
    }); failedPolicyClose = undefined; return getPolicy(); }
    catch { changed(); throw new PermissionError('PERSISTENCE_FAILED'); }
  }
  function reconcileInterrupted(): { previews: number; grants: number; leases: number; operations: number } {
    for (const controller of controllers.values()) controller.abort(new PermissionError('PROCESS_INTERRUPTED'));
    return transaction(() => {
      const previews = Number(db.prepare("UPDATE m2_approval_previews SET state='expired',revision=revision+1 WHERE state='pending'").run().changes);
      db.prepare("UPDATE m2_rule_previews SET state='expired',revision=revision+1 WHERE state='pending'").run();
      const grants = Number(db.prepare("UPDATE m2_grants SET state='expired',revision=revision+1,updated_at=? WHERE state IN ('active','consumed')").run(at()).changes);
      const leases = Number(db.prepare("UPDATE m2_leases SET state='invalid' WHERE state='active'").run().changes);
      const reconciled = options.budget?.reconcileInterruptedInTransaction?.() as unknown;
      if (reconciled && typeof (reconciled as { then?: unknown }).then === 'function') throw new PermissionError('BUDGET_NOT_READY');
      const operations = Number(db.prepare("UPDATE m2_operations SET state='outcome_unknown',result_kind='process-interrupted',settled_at=? WHERE state IN ('prepared','started')").run(at()).changes);
      // A generic resume flag never silently reauthorizes an old rule. Only a
      // durable enabled scheduler created by the trusted configuration command
      // may keep its explicitly opted-in, unchanged public scope after restart.
      const hasSchedules = !!row("SELECT name FROM sqlite_master WHERE type='table' AND name='muse_background_schedules'");
      const activeRules = db.prepare("SELECT * FROM m2_standing_rules WHERE state='active'").all() as Row[];
      for (const rule of activeRules) {
        let preserve = false;
        if (hasSchedules && Number(rule.resume_after_restart) === 1) {
          const schedule = row('SELECT * FROM muse_background_schedules WHERE rule_id=? AND enabled=1 AND blocked_reason IS NULL', String(rule.id));
          if (schedule && schedule.goal_id === rule.goal_id && Number(schedule.goal_revision) === Number(rule.goal_revision)
            && schedule.expires_at === rule.expires_at && Date.parse(String(schedule.expires_at)) > clock()) {
            try {
              const scope = assertRuleScope(rule);
              const goal = row('SELECT * FROM m2_goals WHERE id=?', scope.goalId)!;
              const urls = parse<string[]>(goal.source_urls_json);
              const resources = (db.prepare("SELECT * FROM m2_resources WHERE goal_id=? AND (kind='public_url' OR (kind='artifact' AND file_path IS NULL AND parent_id IS NULL))").all(scope.goalId) as Row[])
                .filter(value => value.kind !== 'public_url' || urls.includes(String(value.url)));
              preserve = PUBLIC_CAPABILITIES.every(capability => scope.capabilities.includes(capability))
                && resources.length === scope.resources.length && resources.every(value => scope.resources.some(resource => resource.id === value.id));
            } catch { /* changed or invalid scope remains suspended */ }
          }
        }
        if (!preserve) db.prepare("UPDATE m2_standing_rules SET state='suspended',revision=revision+1,updated_at=? WHERE id=? AND state='active'").run(at(), String(rule.id));
      }
      audit('permission.reconciled', { state: 'reconciled' }); controllers.clear(); ownership.clear(); leaseOperations.clear(); previewOwnership = new WeakMap(); for (const timer of leaseTimers.values()) clearTimeout(timer); leaseTimers.clear();
      return { previews, grants, leases, operations };
    });
  }
  async function waitForDecision(previewId: string, signal?: AbortSignal, proof?: { preview: ApprovalPreview; context: TaskRunContext }): Promise<DecisionReceipt> {
    permissionId(previewId);
    const minted = proof && previewOwnership.get(proof.preview);
    const owned = minted && minted.id === previewId && proof!.context.ownerId === options.taskService.ownerId
      && identityKeys.every(key => proof!.context[key] === minted.context[key]);
    if (owned) previewOwnership.delete(proof!.preview);
    const seal = (error: unknown) => {
      const state = error instanceof PermissionError && error.code === 'APPROVAL_EXPIRED' ? 'expired' : 'revoked';
      try { transaction(() => {
        const updated = db.prepare("UPDATE m2_approval_previews SET state=?,revision=revision+1 WHERE id=? AND state='pending'").run(state, previewId);
        if (updated.changes) audit(`approval.${state}`, { previewId });
      }); } catch { blocked.add(previewId); changed(); }
    };
    let initial: Row | undefined;
    try { initial = row('SELECT * FROM m2_approval_previews WHERE id=?', previewId); }
    catch (error) { if (owned) seal(error); throw error; }
    if (!initial || initial.owner_id !== options.taskService.ownerId) throw new PermissionError('APPROVAL_NOT_FOUND');
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let finished = false;
      const finish = (error?: Error, receipt?: DecisionReceipt) => {
        if (finished) return;
        finished = true; clearTimeout(timer); listeners.delete(check); signal?.removeEventListener('abort', abort);
        if (error) {
          // Once this waiter ends, a later pipeline abort cannot reach it. Seal the card now and preserve the original error.
          seal(error);
          reject(error);
        } else resolve(receipt!);
      };
      const abort = () => finish(new PermissionError('CANCELLED'));
      const check = () => {
        try {
          if (disposed) return finish(new PermissionError('AUTHORITY_CLOSED'));
          if (signal?.aborted) return abort();
          if (blocked.has(previewId)) return finish(new PermissionError('AUTHORIZATION_REVOKED'));
          const value = row('SELECT * FROM m2_approval_previews WHERE id=?', previewId)!;
          requireFresh(value.expires_at);
          const context = contextForPreview(value);
          const intent=parse<{action:PublicAction;policyHash:string}>(value.intent_json);
          assertAction(context,intent.action);
          if(intent.policyHash!==policyHash())throw new PermissionError('APPROVAL_CHANGED');
          if (value.state === 'pending') return;
          if (value.state !== 'approved') return finish(new PermissionError(value.state === 'rejected' ? 'APPROVAL_REJECTED' : 'APPROVAL_EXPIRED'));
          const grant = row('SELECT id FROM m2_grants WHERE preview_id=?', previewId);
          finish(undefined, { previewId, state: String(value.state), ...(grant ? { grantId: String(grant.id) } : {}), revision: Number(value.revision) });
        } catch (error) { finish(error instanceof Error ? error : new PermissionError('PERSISTENCE_FAILED')); }
      };
      listeners.add(check); signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(new PermissionError('APPROVAL_EXPIRED')), Math.max(1, Math.min(2147483647, Date.parse(String(initial.expires_at)) - clock())));
      check();
    });
  }
  return {
    resourceVersion, previewAction, decideApproval, previewRule, issueRule, prepare, assertLease, markStarted, settle, waitForDecision, reconcileInterrupted, getPolicy, updatePolicy, cancelGoalOperations, cancelRunOperations, cancelAllPublicOperations,
    getApproval(id: string) { const value = row('SELECT * FROM m2_approval_previews WHERE id=?', permissionId(id)); return value ? projection(value) : null; },
    listApprovals() { return (db.prepare("SELECT * FROM m2_approval_previews ORDER BY created_at DESC LIMIT 100").all() as Row[]).map(projection); },
    listRules(goalId?: string) { return (goalId ? db.prepare('SELECT * FROM m2_standing_rules WHERE goal_id=? ORDER BY created_at DESC LIMIT 100').all(permissionId(goalId)) : db.prepare('SELECT * FROM m2_standing_rules ORDER BY created_at DESC LIMIT 100').all() as Row[]).map(value => ruleProjection(value as Row)); },
    listGrants(): GrantProjection[] { return (db.prepare('SELECT * FROM m2_grants ORDER BY created_at DESC LIMIT 100').all() as Row[]).map(value => { const action = parse<{ action: PublicAction }>(value.action_json).action; return { id: String(value.id), revision: Number(value.revision), goalId: String(value.goal_id), runId: String(value.run_id), scope: value.scope as GrantProjection['scope'], state: value.state === 'active' && Date.parse(String(value.expires_at)) <= clock() ? 'expired' : String(value.state), capability: action.capability, resourceRef: action.resourceRef, expiresAt: String(value.expires_at) }; }); },
    revokeRule(id: string, revision: number) { revoke('rule', id, revision); }, revokeGrant(id: string, revision: number) { revoke('grant', id, revision); },
    /** Main-process scheduler ports; no IPC accepts a rule scope or resume action. */
    assertStandingRule(id: string): StandingRule {
      const value = row('SELECT * FROM m2_standing_rules WHERE id=?', permissionId(id));
      if (!value) throw new PermissionError('AUTHORIZATION_NOT_FOUND');
      assertRuleScope(value); return ruleProjection(value);
    },
    suspendRule(id: string, revision: number): StandingRule {
      permissionId(id); permissionInteger(revision);
      const value = row('SELECT * FROM m2_standing_rules WHERE id=?', id);
      if (!value) throw new PermissionError('AUTHORIZATION_NOT_FOUND');
      if (Number(value.revision) !== revision) throw new PermissionError('REVISION_CONFLICT', Number(value.revision));
      if (value.state === 'suspended') return ruleProjection(value);
      if (value.state !== 'active') throw new PermissionError('AUTHORIZATION_REVOKED');
      blocked.add(id); invalidateOperations('rule', id);
      try {
        const result = transaction(() => {
          db.prepare("UPDATE m2_standing_rules SET state='suspended',revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(at(), id, revision);
          db.prepare("UPDATE m2_leases SET state='revoked' WHERE rule_id=? AND state='active'").run(id);
          audit('rule.suspended', { ruleId: id }); return ruleProjection(row('SELECT * FROM m2_standing_rules WHERE id=?', id)!);
        });
        blocked.delete(id);
        return result;
      } catch { changed(); throw new PermissionError('PERSISTENCE_FAILED'); }
    },
    resumeRule(id: string, revision: number): StandingRule {
      return transaction(() => {
        const value = row('SELECT * FROM m2_standing_rules WHERE id=?', permissionId(id));
        if (!value) throw new PermissionError('AUTHORIZATION_NOT_FOUND');
        if (Number(value.revision) !== permissionInteger(revision)) throw new PermissionError('REVISION_CONFLICT', Number(value.revision));
        if (value.state !== 'suspended' || Number(value.resume_after_restart) !== 1) throw new PermissionError('AUTHORIZATION_REVOKED');
        // This port can resume only an unchanged scheduler-linked public rule.
        const schedule = row("SELECT * FROM muse_background_schedules WHERE rule_id=? AND enabled=1 AND blocked_reason IS NULL", id);
        if (!schedule || schedule.goal_id !== value.goal_id || Number(schedule.goal_revision) !== Number(value.goal_revision)
          || schedule.expires_at !== value.expires_at) throw new PermissionError('AUTHORIZATION_CHANGED');
        assertRuleScope({ ...value, state: 'active' });
        db.prepare("UPDATE m2_standing_rules SET state='active',revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(at(), id, revision);
        audit('rule.resumed', { ruleId: id }); return ruleProjection(row('SELECT * FROM m2_standing_rules WHERE id=?', id)!);
      });
    },
    dispose() { disposed = true; for (const controller of controllers.values()) controller.abort(new PermissionError('AUTHORITY_CLOSED')); for (const timer of leaseTimers.values()) clearTimeout(timer); leaseTimers.clear(); controllers.clear(); ownership.clear(); leaseOperations.clear(); previewOwnership = new WeakMap(); changed(); listeners.clear(); },
    assertLegacyTool(group: string) { if (!(LEGACY_TOOL_GROUPS as readonly string[]).includes(group)) throw new PermissionError('MODE_BLOCKED'); if (getPolicy().deniedLegacyTools.includes(group as PermissionPolicy['deniedLegacyTools'][number])) throw new PermissionError('POLICY_BLOCKED'); },
    assertOsRequest(kind: string) { const mapped = kind === 'fullDisk' ? 'fullDiskAccess' : kind; if (!(LEGACY_OS_IDS as readonly string[]).includes(mapped)) throw new PermissionError('INVALID_REQUEST'); if (legacyPolicy().deniedOSRequests.includes(mapped as typeof LEGACY_OS_IDS[number])) throw new PermissionError('POLICY_BLOCKED'); },
  };
}
export type PermissionAuthority = ReturnType<typeof createPermissionAuthority>;
