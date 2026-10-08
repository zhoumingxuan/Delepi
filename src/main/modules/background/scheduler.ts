import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { PUBLIC_CAPABILITIES } from '@shared/types/autonomy';
import type { BackgroundConfiguration, BackgroundSchedule } from '@shared/types/background';
import type { GoalService } from '../goals/goal-service';
import { appendAutonomyAudit, AutonomyError } from '../goals/autonomy-store';
import type { PermissionAuthority } from '../permissions/authority';
import { permissionDate, permissionId, permissionInteger, permissionObject } from '../permissions/permission-validation';
import type { ExplorationService } from '../exploration/exploration-service';
import type { TaskService } from '../tasks/task-service';

interface ScheduleRow {
  id: string; goal_id: string; goal_revision: number; rule_id: string; revision: number; enabled: number;
  interval_minutes: number; daily_round_limit: number; expires_at: string; protocol: BackgroundConfiguration['protocol'];
  learning_enabled: number; auto_promote: number; anchor_at: string; next_run_at: string;
  last_run_id: string | null; last_state: string | null; blocked_reason: string | null; created_at: string; updated_at: string;
}
interface OwnedRun { scheduleId: string; triggerId: string; runId: string; promise: Promise<void> }
export interface BackgroundSchedulerDependencies {
  goals: GoalService; authority: PermissionAuthority; exploration: ExplorationService; taskService: TaskService;
  learning?: { captureCompletedRun(runId: string, options: { autoPromote: boolean }): unknown | Promise<unknown> };
  foregroundBusy: () => boolean; now?: () => number; uuid?: () => string; wake?: () => void; callerId?: number;
}
const day = (instant: number) => new Date(instant).toISOString().slice(0, 10);
const errorCode = (error: unknown) => {
  const value = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : '';
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value) ? value : 'OPERATION_FAILED';
};

/** A bounded in-app scheduler. It cannot launch shell tools or operate while the app is closed. */
export function createBackgroundScheduler(db: Database.Database, deps: BackgroundSchedulerDependencies) {
  const now = deps.now ?? Date.now, uuid = deps.uuid ?? randomUUID, callerId = permissionInteger(deps.callerId ?? 1);
  let owned: OwnedRun | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let suspended = false, disposed = false, reconciled = false, ticking: Promise<void> | undefined, lastClock = 0;
  const memoryBlocks = new Map<string, string>();
  const clock = () => (lastClock = Math.max(lastClock, now()));
  const at = () => new Date(clock()).toISOString();
  const wake = () => { try { deps.wake?.(); } catch { /* persistence is authoritative */ } };
  const read = (id: string) => {
    const value = db.prepare('SELECT * FROM muse_background_schedules WHERE id=?').get(permissionId(id)) as ScheduleRow | undefined;
    if (!value) throw new AutonomyError('BACKGROUND_NOT_FOUND'); return value;
  };
  const count = (id: string) => Number((db.prepare('SELECT round_count FROM muse_background_daily WHERE schedule_id=? AND day_key=?').get(id, day(clock())) as { round_count: number } | undefined)?.round_count ?? 0);
  const project = (value: ScheduleRow): BackgroundSchedule => ({
    id: value.id, revision: value.revision, goalId: value.goal_id, goalRevision: value.goal_revision,
    state: Date.parse(value.expires_at) <= clock() ? 'expired' : value.blocked_reason || memoryBlocks.has(value.id) ? 'blocked' : value.enabled ? 'enabled' : 'paused',
    intervalMinutes: value.interval_minutes, dailyRoundLimit: value.daily_round_limit, expiresAt: value.expires_at,
    protocol: value.protocol, learningEnabled: !!value.learning_enabled, autoPromote: !!value.auto_promote,
    nextDueAt: value.next_run_at, ruleId: value.rule_id,
    ...(value.last_run_id ? { lastRunId: value.last_run_id } : {}), ...(value.last_state ? { lastOutcome: value.last_state } : {}),
    ...(value.blocked_reason || memoryBlocks.has(value.id) ? { reasonCode: value.blocked_reason ?? memoryBlocks.get(value.id)! } : {}), roundsToday: count(value.id), createdAt: value.created_at,
  });
  function checkRevision(value: ScheduleRow, revision: number) {
    if (value.revision !== permissionInteger(revision)) throw new AutonomyError('REVISION_CONFLICT', value.revision);
  }
  function learningScope(goalId: string, revision: number, enabled: boolean) {
    const { goal } = deps.goals.get(goalId);
    if (goal.revision !== revision) throw new AutonomyError('GOAL_CHANGED');
    const scope = db.prepare('SELECT allowed_uses_json FROM m2_data_scopes WHERE id=? AND goal_id=?').get(goal.dataScopeId, goalId) as { allowed_uses_json: string } | undefined;
    if (!scope) throw new AutonomyError('SCOPE_BLOCKED');
    const uses = JSON.parse(scope.allowed_uses_json) as unknown;
    if (!Array.isArray(uses) || uses.some(value => typeof value !== 'string')) throw new AutonomyError('SCOPE_BLOCKED');
    const next = uses.filter(value => value !== 'learning.capture' && value !== 'skill.context');
    if (enabled) next.push('learning.capture', 'skill.context');
    db.prepare('UPDATE m2_data_scopes SET allowed_uses_json=?,revision=revision+1 WHERE id=? AND goal_id=?').run(JSON.stringify(next), goal.dataScopeId, goalId);
  }
  function validate(value: ScheduleRow) {
    if (memoryBlocks.has(value.id)) throw new AutonomyError(memoryBlocks.get(value.id)!);
    if (!value.enabled) throw new AutonomyError('BACKGROUND_PAUSED');
    if (value.blocked_reason) throw new AutonomyError(value.blocked_reason);
    if (Date.parse(value.expires_at) <= clock()) throw new AutonomyError('BACKGROUND_EXPIRED');
    const { goal } = deps.goals.get(value.goal_id);
    if (goal.state !== 'active' || goal.revision !== value.goal_revision) throw new AutonomyError('GOAL_CHANGED');
    const rule = deps.authority.assertStandingRule(value.rule_id);
    if (!rule.resumeAfterRestart || rule.goalId !== value.goal_id || rule.goalRevision !== value.goal_revision
      || rule.expiresAt !== value.expires_at || !PUBLIC_CAPABILITIES.every(capability => rule.capabilities.includes(capability))) throw new AutonomyError('AUTHORIZATION_CHANGED');
  }
  function block(id: string, reason: string) {
    memoryBlocks.set(id, reason);
    db.transaction(() => {
      db.prepare('UPDATE muse_background_schedules SET blocked_reason=?,last_state=?,revision=revision+1,updated_at=? WHERE id=? AND blocked_reason IS NULL').run(reason, 'blocked', at(), id);
      const value = read(id), rule = deps.authority.listRules(value.goal_id).find(rule => rule.id === value.rule_id);
      if (rule?.state === 'active') deps.authority.suspendRule(rule.id, rule.revision);
      // Goal revision changes already invalidate the entire old scope. Avoid
      // touching its replacement scope when sealing the old schedule.
      if (deps.goals.get(value.goal_id).goal.revision === value.goal_revision) learningScope(value.goal_id, value.goal_revision, false);
      appendAutonomyAudit(db, 'background.blocked', { goalId: value.goal_id, state: 'blocked', reasonCode: reason }, undefined, at());
    })(); wake();
  }
  async function finish(run: OwnedRun) {
    let failure: string | undefined;
    try {
      await deps.exploration.waitForRun(run.runId);
      const session = db.prepare('SELECT state,stop_reason,artifact_id,settled_at FROM m2_exploration_sessions WHERE run_id=?').get(run.runId) as { state: string; stop_reason: string | null; artifact_id: string | null; settled_at: string | null } | undefined;
      const state = session?.settled_at ? session.state : 'outcome_unknown';
      if (state === 'completed') {
        const value = read(run.scheduleId);
        if (value.enabled && value.learning_enabled && !value.blocked_reason && Date.parse(value.expires_at) > clock()) {
          validate(value);
          await deps.learning?.captureCompletedRun(run.runId, { autoPromote: !!value.auto_promote });
        }
      } else if (state !== 'stopped') failure = state === 'outcome_unknown' ? 'OUTCOME_UNKNOWN' : session?.stop_reason ?? 'OPERATION_FAILED';
      db.transaction(() => {
        db.prepare('UPDATE muse_background_triggers SET state=?,reason_code=?,settled_at=? WHERE id=? AND owner_id=? AND state=\'running\'').run(state, failure ?? session?.stop_reason ?? null, at(), run.triggerId, deps.taskService.ownerId);
        db.prepare('UPDATE muse_background_schedules SET last_state=?,revision=revision+1,updated_at=? WHERE id=? AND last_run_id=?').run(state, at(), run.scheduleId, run.runId);
        appendAutonomyAudit(db, 'background.settled', { goalId: read(run.scheduleId).goal_id, state, ...(failure ? { reasonCode: failure } : {}) }, undefined, at());
      })();
      if (failure) block(run.scheduleId, failure);
    } catch (error) {
      // Completed network work is never replayed because learning or receipt
      // persistence failed. Leave an explicit unknown outcome for reconciliation.
      failure = errorCode(error);
      try {
        db.transaction(() => {
          db.prepare("UPDATE muse_background_triggers SET state='outcome_unknown',reason_code=?,settled_at=? WHERE id=? AND owner_id=?").run(failure, at(), run.triggerId, deps.taskService.ownerId);
          db.prepare("UPDATE muse_background_schedules SET last_state='outcome_unknown',blocked_reason=?,revision=revision+1,updated_at=? WHERE id=? AND last_run_id=?").run(failure, at(), run.scheduleId, run.runId);
        })();
      } catch { /* durable running trigger stays available for startup reconciliation */ }
      deps.authority.cancelRunOperations(run.runId);
    } finally { if (owned === run) owned = undefined; wake(); }
  }
  async function claim(value: ScheduleRow): Promise<void> {
    if (disposed || suspended || owned || deps.foregroundBusy()) return;
    let registeredRun: string | undefined, run: OwnedRun | undefined;
    try {
      db.transaction(() => {
        const current = read(value.id); validate(current);
        const instant = clock(), interval = current.interval_minutes * 60000;
        const slot = Math.max(0, Math.floor((instant - Date.parse(current.anchor_at)) / interval)), slotKey = `${current.anchor_at}:${slot}`;
        if (db.prepare('SELECT 1 FROM muse_background_triggers WHERE schedule_id=? AND slot_key=?').get(current.id, slotKey)) return;
        if (db.prepare("SELECT 1 FROM muse_background_triggers WHERE state='running' LIMIT 1").get()) return;
        if (count(current.id) >= current.daily_round_limit) {
          const tomorrow = new Date(Date.parse(`${day(instant)}T00:00:00.000Z`) + 86400000).toISOString();
          db.prepare('UPDATE muse_background_schedules SET next_run_at=?,updated_at=? WHERE id=?').run(tomorrow, at(), current.id); return;
        }
        const plan = deps.exploration.planExploration(current.goal_id, current.goal_revision, current.protocol, callerId);
        const session = deps.exploration.startExploration(plan.id, plan.revision, callerId);
        registeredRun = session.runId;
        const triggerId = uuid(), startedAt = at();
        db.prepare("INSERT INTO muse_background_triggers(id,schedule_id,slot_key,day_key,owner_id,run_id,state,created_at) VALUES(?,?,?,?,?,?,'running',?)")
          .run(triggerId, current.id, slotKey, day(instant), deps.taskService.ownerId, session.runId, startedAt);
        db.prepare('INSERT INTO muse_background_daily(schedule_id,day_key,round_count) VALUES(?,?,1) ON CONFLICT(schedule_id,day_key) DO UPDATE SET round_count=round_count+1').run(current.id, day(instant));
        const nextAt = new Date(Date.parse(current.anchor_at) + (slot + 1) * interval).toISOString();
        db.prepare("UPDATE muse_background_schedules SET last_run_id=?,last_state='running',next_run_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?")
          .run(session.runId, nextAt, startedAt, current.id, current.revision);
        appendAutonomyAudit(db, 'background.started', { goalId: current.goal_id, state: 'running' }, undefined, startedAt);
        run = { scheduleId: current.id, triggerId, runId: session.runId, promise: Promise.resolve() };
      })();
    } catch (error) {
      // startExploration registers memory ownership before the surrounding
      // claim transaction commits. A later SQL failure must cancel that exact
      // Run before its execution microtask can escape the rolled-back claim.
      if (registeredRun) {
        try { await deps.exploration.stopExploration(registeredRun); } catch { /* abort and drain happen before its persistence error is reported */ }
      }
      block(value.id, registeredRun ? 'OUTCOME_UNKNOWN' : errorCode(error)); return;
    }
    if (run) { owned = run; run.promise = finish(run); wake(); }
  }
  const service = {
    list(): BackgroundSchedule[] {
      return (db.prepare('SELECT * FROM muse_background_schedules ORDER BY created_at,id LIMIT 200').all() as ScheduleRow[]).map(project);
    },
    configure(goalId: string, expectedGoalRevision: number, raw: BackgroundConfiguration, trustedCallerId = callerId): BackgroundSchedule {
      if (disposed) throw new AutonomyError('STAGE_NOT_READY');
      permissionId(goalId); permissionInteger(expectedGoalRevision); permissionInteger(trustedCallerId);
      const options = permissionObject(raw, ['intervalMinutes', 'dailyRoundLimit', 'expiresAt', 'protocol', 'learningEnabled', 'autoPromote']);
      const interval = permissionInteger(options.intervalMinutes, 1440), limit = permissionInteger(options.dailyRoundLimit, 3), expiresAt = permissionDate(options.expiresAt);
      if (interval < 30 || limit < 1 || Date.parse(expiresAt) <= clock() || Date.parse(expiresAt) > clock() + 30 * 86400000
        || !['chat-completions', 'responses'].includes(String(options.protocol)) || typeof options.learningEnabled !== 'boolean' || typeof options.autoPromote !== 'boolean'
        || (options.autoPromote && !options.learningEnabled)) throw new AutonomyError('INVALID_REQUEST');
      const result = db.transaction(() => {
        const { goal, resources } = deps.goals.get(goalId);
        if (goal.revision !== expectedGoalRevision) throw new AutonomyError('REVISION_CONFLICT', goal.revision);
        if (goal.state !== 'active') throw new AutonomyError('GOAL_INACTIVE');
        const old = db.prepare('SELECT * FROM muse_background_schedules WHERE goal_id=?').get(goalId) as ScheduleRow | undefined;
        if (old && (owned?.scheduleId === old.id || db.prepare("SELECT 1 FROM muse_background_triggers WHERE schedule_id=? AND state='running'").get(old.id))) throw new AutonomyError('BACKGROUND_RUNNING');
        if (old) {
          const rule = deps.authority.listRules(goalId).find(rule => rule.id === old.rule_id);
          if (rule?.state === 'active') deps.authority.suspendRule(rule.id, rule.revision);
        }
        const preview = deps.authority.previewRule({ goalId, expectedGoalRevision, capabilities: [...PUBLIC_CAPABILITIES],
          resourceRefs: resources.filter(resource => resource.kind === 'public_url' || resource.kind === 'artifact').map(resource => resource.id), expiresAt, resumeAfterRestart: true }, trustedCallerId);
        const rule = deps.authority.issueRule(preview.id, preview.revision, trustedCallerId), id = old?.id ?? uuid(), timestamp = at();
        learningScope(goalId, goal.revision, options.learningEnabled === true);
        if (old) db.prepare("UPDATE muse_background_schedules SET goal_revision=?,rule_id=?,revision=revision+1,enabled=1,interval_minutes=?,daily_round_limit=?,expires_at=?,protocol=?,learning_enabled=?,auto_promote=?,anchor_at=?,next_run_at=?,last_state=NULL,blocked_reason=NULL,updated_at=? WHERE id=?")
          .run(goal.revision, rule.id, interval, limit, expiresAt, options.protocol, options.learningEnabled ? 1 : 0, options.autoPromote ? 1 : 0, timestamp, timestamp, timestamp, id);
        else db.prepare('INSERT INTO muse_background_schedules(id,goal_id,goal_revision,rule_id,enabled,interval_minutes,daily_round_limit,expires_at,protocol,learning_enabled,auto_promote,anchor_at,next_run_at,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?,?,?,?,?,?,?)')
          .run(id, goalId, goal.revision, rule.id, interval, limit, expiresAt, options.protocol, options.learningEnabled ? 1 : 0, options.autoPromote ? 1 : 0, timestamp, timestamp, timestamp, timestamp);
        appendAutonomyAudit(db, 'background.configured', { goalId, ruleId: rule.id, state: 'enabled', revision: goal.revision }, undefined, timestamp);
        return project(read(id));
      })(); memoryBlocks.delete(result.id); wake(); return project(read(result.id));
    },
    async setEnabled(id: string, expectedRevision: number, enabled: boolean): Promise<BackgroundSchedule> {
      if (disposed) throw new AutonomyError('STAGE_NOT_READY');
      if (typeof enabled !== 'boolean') throw new AutonomyError('INVALID_REQUEST');
      const value = read(id); checkRevision(value, expectedRevision);
      if (!!value.enabled === enabled && !value.blocked_reason) return project(value);
      const run = owned?.scheduleId === id ? owned : undefined;
      // Cancellation must precede the first fallible persistence write. The
      // trusted pause request already passed its identity/revision checks.
      const drain = !enabled && run ? deps.exploration.stopExploration(run.runId) : undefined;
      if (drain) void drain.catch(() => {});
      // Disable the durable trigger first; revoke its lease before awaiting the
      // actual Run drain. Its memory owner remains held throughout cancellation.
      try { db.transaction(() => {
        if (enabled && (value.blocked_reason || memoryBlocks.has(id))) throw new AutonomyError('BACKGROUND_RECONFIGURE_REQUIRED');
        if (enabled && Date.parse(value.expires_at) <= clock()) throw new AutonomyError('BACKGROUND_EXPIRED');
        db.prepare('UPDATE muse_background_schedules SET enabled=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(enabled ? 1 : 0, at(), id, expectedRevision);
        const rule = deps.authority.listRules(value.goal_id).find(rule => rule.id === value.rule_id);
        if (!rule) throw new AutonomyError('AUTHORIZATION_NOT_FOUND');
        if (enabled) { deps.authority.resumeRule(rule.id, rule.revision); learningScope(value.goal_id, value.goal_revision, !!value.learning_enabled); validate(read(id)); }
        else { if (rule.state === 'active') deps.authority.suspendRule(rule.id, rule.revision); if (deps.goals.get(value.goal_id).goal.revision === value.goal_revision) learningScope(value.goal_id, value.goal_revision, false); }
        appendAutonomyAudit(db, 'background.enabled_changed', { goalId: value.goal_id, state: enabled ? 'enabled' : 'paused' }, undefined, at());
      })(); } catch (error) {
        if (!enabled) {
          if (drain) { try { await drain; } catch { /* still drain owned I/O below */ } }
          if (run) await run.promise;
          try { block(id, 'PERSISTENCE_FAILED'); } catch { /* unchanged durable rule is never used while its owner is closed */ }
        }
        throw error;
      }
      wake();
      if (!enabled && run) { try { await drain; } finally { await run.promise; } }
      return project(read(id));
    },
    async runNow(id: string, expectedRevision: number): Promise<BackgroundSchedule> {
      const value = read(id); checkRevision(value, expectedRevision); validate(value);
      if (disposed || suspended || !reconciled) throw new AutonomyError('STAGE_NOT_READY');
      if (deps.foregroundBusy()) throw new AutonomyError('FOREGROUND_BUSY');
      if (owned) throw new AutonomyError('BACKGROUND_RUNNING');
      await claim(value); return project(read(id));
    },
    async tick(): Promise<void> {
      if (disposed || suspended || !reconciled) return;
      if (ticking) return ticking;
      ticking = (async () => {
        if (owned) {
          const run = owned;
          let changed: string | undefined;
          try { validate(read(run.scheduleId)); } catch (error) { changed = errorCode(error); try { block(run.scheduleId, changed); } catch { /* memory block already closes admission; stop below remains unconditional */ } }
          if (changed || deps.foregroundBusy()) { try { await deps.exploration.stopExploration(run.runId); } finally { await run.promise; } }
          return;
        }
        if (deps.foregroundBusy()) return;
        const candidates = db.prepare('SELECT * FROM muse_background_schedules WHERE enabled=1 AND blocked_reason IS NULL AND next_run_at<=? ORDER BY next_run_at,id LIMIT 200').all(at()) as ScheduleRow[];
        for (const value of candidates) {
          if (owned || suspended || disposed) break;
          try { validate(value); await claim(value); } catch (error) { block(value.id, errorCode(error)); }
        }
      })();
      try { await ticking; } finally { ticking = undefined; }
    },
    start(): void {
      if (disposed || suspended || timer || !reconciled) return;
      timer = setInterval(() => { void service.tick().catch(() => { /* durable admission is retried by pull, never by replaying a claimed slot */ }); }, 15000);
      timer.unref(); void service.tick().catch(() => {});
    },
    async suspend(): Promise<void> {
      suspended = true; if (timer) clearInterval(timer); timer = undefined;
      const run = owned; if (run) { try { await deps.exploration.stopExploration(run.runId); } finally { await run.promise; } }
      await ticking;
    },
    resume(): void { if (!disposed) { suspended = false; service.start(); } },
    async dispose(): Promise<void> { await service.suspend(); disposed = true; },
    reconcileInterrupted(): void {
      if (owned) throw new AutonomyError('BACKGROUND_RUNNING');
      db.transaction(() => {
        const triggers = db.prepare("SELECT * FROM muse_background_triggers WHERE state='running'").all() as Array<{ id: string; schedule_id: string; run_id: string }>;
        for (const trigger of triggers) {
          const session = db.prepare('SELECT state,stop_reason,settled_at FROM m2_exploration_sessions WHERE run_id=?').get(trigger.run_id) as { state: string; stop_reason: string | null; settled_at: string | null } | undefined;
          const known = session?.settled_at && ['completed', 'stopped', 'failed'].includes(session.state);
          const state = known ? session!.state : 'outcome_unknown', reason = known ? session!.stop_reason : 'PROCESS_INTERRUPTED';
          db.prepare('UPDATE muse_background_triggers SET state=?,reason_code=?,settled_at=? WHERE id=?').run(state, reason ?? null, at(), trigger.id);
          // The slot and day counters are retained even when work was interrupted.
          db.prepare('UPDATE muse_background_schedules SET last_state=?,blocked_reason=?,revision=revision+1,updated_at=? WHERE id=?').run(state, state === 'completed' || state === 'stopped' ? null : reason ?? 'OPERATION_FAILED', at(), trigger.schedule_id);
        }
        const schedules = db.prepare('SELECT * FROM muse_background_schedules WHERE enabled=1').all() as ScheduleRow[];
        for (const value of schedules) { try { validate(value); } catch (error) { block(value.id, errorCode(error)); } }
      })(); reconciled = true; wake();
    },
  };
  return service;
}
export type BackgroundScheduler = ReturnType<typeof createBackgroundScheduler>;
