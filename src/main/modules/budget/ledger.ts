import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { BudgetAmounts, PublicAction } from '@shared/types/autonomy';
import type { TaskRunContext } from '../tasks/types';
import type { OperationOutcome, OperationUsage } from '../permissions/authority';
import { canonicalPermissionJson, permissionHash, permissionId } from '../permissions/permission-validation';
import type { BudgetAccountProjection, BudgetLedgerOptions } from './contracts';

export class BudgetError extends Error { constructor(readonly code: string) { super(code); } }
export const BUDGET_AMOUNT_KEYS = ['modelRequests','fetchRequests','downloadBytes','storageBytes','tokenUnits'] as const;
export const zeroAmounts = (): BudgetAmounts => ({ modelRequests: 0, fetchRequests: 0, downloadBytes: 0, storageBytes: 0, tokenUnits: 0 });
export function validateAmounts(value: unknown, partial = false): BudgetAmounts {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !(BUDGET_AMOUNT_KEYS as readonly string[]).includes(key))) throw new BudgetError('INVALID_BUDGET_AMOUNTS');
  const input = value as Record<string, unknown>, result = zeroAmounts();
  for (const key of BUDGET_AMOUNT_KEYS) {
    const amount = input[key];
    if (partial && amount === undefined) continue;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) throw new BudgetError('INVALID_BUDGET_AMOUNTS');
    result[key] = amount;
  }
  return result;
}
const add = (a: BudgetAmounts, b: BudgetAmounts): BudgetAmounts => {
  const result = zeroAmounts();
  for (const key of BUDGET_AMOUNT_KEYS) { const value = a[key] + b[key]; if (!Number.isSafeInteger(value)) throw new BudgetError('BUDGET_OVERFLOW'); result[key] = value; }
  return result;
};
const subtract = (a: BudgetAmounts, b: BudgetAmounts): BudgetAmounts => {
  const result = zeroAmounts();
  for (const key of BUDGET_AMOUNT_KEYS) { if (b[key] > a[key]) throw new BudgetError('BUDGET_CORRUPT'); result[key] = a[key] - b[key]; }
  return result;
};
type Row = Record<string, unknown>;
const amounts = (value: unknown) => validateAmounts(JSON.parse(String(value)));

/** No I/O and no independent transaction in the hooks: Authority owns the commit boundary. */
export function createBudgetLedger(db: Database.Database, options: BudgetLedgerOptions) {
  const caps = { global: validateAmounts(options.caps.global), goal: validateAmounts(options.caps.goal), day: validateAmounts(options.caps.day) };
  const now = options.now ?? Date.now, uuid = options.uuid ?? randomUUID;
  let lastClock = 0;
  const clock = () => { const value = now(); if (!Number.isFinite(value)) throw new BudgetError('INVALID_CLOCK'); return lastClock = Math.max(lastClock, value); };
  const instant = () => new Date(clock()).toISOString();
  const requireTransaction = () => { if (!db.inTransaction) throw new BudgetError('BUDGET_TRANSACTION_REQUIRED'); };
  const bindingStatement = db.prepare('SELECT * FROM m2_run_scopes WHERE run_id=?');
  const accountStatement = db.prepare('SELECT * FROM m2_budget_accounts WHERE scope=? AND scope_ref=? AND window_key=?');
  const reservationsStatement = db.prepare('SELECT * FROM m2_budget_reservations WHERE operation_id=? ORDER BY account_id');
  function binding(context: TaskRunContext) {
    const value = bindingStatement.get(permissionId(context.runId)) as Row | undefined;
    if (!value || value.mode !== 'public' || value.owner_id !== context.ownerId || Number(value.generation) !== context.generation) throw new BudgetError('BUDGET_SCOPE_MISMATCH');
    return value;
  }
  function accountsFor(context: TaskRunContext, create: boolean): Row[] {
    const scope = binding(context);
    const snapshot = JSON.parse(String(scope.snapshot_json)) as { limits?: unknown };
    const rawLimits = snapshot.limits as Record<string, unknown> | undefined;
    if (!rawLimits) throw new BudgetError('BUDGET_SCOPE_MISMATCH');
    const runLimits = validateAmounts(Object.fromEntries(BUDGET_AMOUNT_KEYS.map(key => [key, rawLimits[key]])));
    const day = new Date(clock()), dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    const windowKey = new Date(dayStart).toISOString().slice(0, 10);
    const specs = [
      { scope: 'global', ref: 'autonomous-reading', key: 'cumulative', cap: caps.global },
      { scope: 'goal', ref: String(scope.goal_id), key: 'cumulative', cap: caps.goal },
      { scope: 'run', ref: context.runId, key: 'run', cap: runLimits },
      { scope: 'day', ref: 'autonomous-reading', key: windowKey, cap: caps.day },
    ];
    const selected: Row[] = [];
    for (const spec of specs) {
      let saved = accountStatement.get(spec.scope, spec.ref, spec.key) as Row | undefined;
      if (!saved && create) {
        db.prepare('INSERT INTO m2_budget_accounts(id,scope,scope_ref,window_key,window_start,window_end,timezone,limits_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(uuid(), spec.scope, spec.ref, spec.key, spec.scope === 'day' ? new Date(dayStart).toISOString() : null,
            spec.scope === 'day' ? new Date(dayStart + 86400000).toISOString() : null, spec.scope === 'day' ? 'UTC' : null,
            canonicalPermissionJson(spec.cap), instant(), instant());
        saved = accountStatement.get(spec.scope, spec.ref, spec.key) as Row;
      }
      if (saved) {
        // Existing limits are not rewritten by a new process or Run. A changed cap needs a separate trusted CAS policy.
        if (canonicalPermissionJson(amounts(saved.limits_json)) !== canonicalPermissionJson(spec.cap)) throw new BudgetError('BUDGET_LIMIT_CHANGED');
        selected.push(saved);
      }
    }
    // Defensive support for any still-live historical day account, without letting timezone changes mint a second allowance.
    const overlapping = db.prepare("SELECT * FROM m2_budget_accounts WHERE scope='day' AND scope_ref='autonomous-reading' AND window_start<=? AND window_end>? AND window_key<>?")
      .all(instant(), instant(), windowKey) as Row[];
    return [...selected, ...overlapping];
  }
  function reserveInTransaction(operationId: string, action: PublicAction, context: TaskRunContext): string {
    requireTransaction(); permissionId(operationId);
    const amount = validateAmounts(action.units), existing = reservationsStatement.all(operationId) as Row[];
    const accounts = accountsFor(context, true);
    if (existing.length) {
      const accountIds = new Set(accounts.map(value => String(value.id)));
      if (existing.length !== accounts.length || existing.some(value => !accountIds.has(String(value.account_id)) || value.owner_id !== context.ownerId
        || value.run_id !== context.runId || value.attempt_id !== context.attemptId || Number(value.generation) !== context.generation
        || canonicalPermissionJson(amounts(value.amount_json)) !== canonicalPermissionJson(amount))) throw new BudgetError('BUDGET_RECEIPT_CONFLICT');
      return operationId;
    }
    // Check every account before updating any. Rollback is still mandatory if an INSERT/UPDATE later fails.
    for (const account of accounts) {
      const occupied = add(amounts(account.used_json), add(amounts(account.reserved_json), amount));
      const limits = amounts(account.limits_json);
      if (BUDGET_AMOUNT_KEYS.some(key => occupied[key] > limits[key])) throw new BudgetError('BUDGET_EXHAUSTED');
    }
    for (const account of accounts) {
      db.prepare('UPDATE m2_budget_accounts SET reserved_json=?,revision=revision+1,updated_at=? WHERE id=?')
        .run(canonicalPermissionJson(add(amounts(account.reserved_json), amount)), instant(), String(account.id));
      db.prepare("INSERT INTO m2_budget_reservations(operation_id,account_id,owner_id,run_id,attempt_id,generation,amount_json,state,created_at) VALUES(?,?,?,?,?,?,?,'reserved',?)")
        .run(operationId, String(account.id), context.ownerId, context.runId, context.attemptId, context.generation, canonicalPermissionJson(amount), instant());
    }
    return operationId;
  }
  function settleInTransaction(operationId: string, outcome: OperationOutcome, usage?: OperationUsage): void {
    requireTransaction(); permissionId(operationId);
    if (!['completed','failed','cancelled','unknown','not_started'].includes(outcome)) throw new BudgetError('INVALID_BUDGET_RECEIPT');
    if (usage && (typeof usage !== 'object' || Object.keys(usage).some(key => key !== 'known' && key !== 'unknown'))) throw new BudgetError('INVALID_BUDGET_RECEIPT');
    const rawKnown = usage?.known ?? {}, rawUnknown = usage?.unknown;
    const known = validateAmounts(rawKnown, true), requestedUnknown = rawUnknown === undefined ? undefined : validateAmounts(rawUnknown, true);
    const reservationRows = reservationsStatement.all(operationId) as Row[];
    if (!reservationRows.length) throw new BudgetError('BUDGET_RESERVATION_NOT_FOUND');
    const fingerprint = permissionHash({ outcome, usage: usage ?? null });
    if (reservationRows.some(value => value.state !== 'reserved')) {
      if (reservationRows.some(value => value.state === 'reserved' || value.settle_fingerprint !== fingerprint)) throw new BudgetError('BUDGET_RECEIPT_CONFLICT');
      return;
    }
    const reserved = amounts(reservationRows[0].amount_json);
    const operation = db.prepare('SELECT state FROM m2_operations WHERE id=?').get(operationId) as Row | undefined;
    const started = operation?.state === 'started' || operation?.state === 'outcome_unknown';
    if (outcome === 'not_started') {
      if (started || BUDGET_AMOUNT_KEYS.some(key => known[key] || requestedUnknown?.[key])) throw new BudgetError('BUDGET_STARTED');
    } else if (started) {
      known.modelRequests = Math.max(known.modelRequests, reserved.modelRequests);
      known.fetchRequests = Math.max(known.fetchRequests, reserved.fetchRequests);
    }
    const unknown = zeroAmounts();
    if (outcome !== 'not_started') for (const key of BUDGET_AMOUNT_KEYS) {
      const remaining = Math.max(0, reserved[key] - known[key]);
      unknown[key] = requestedUnknown ? requestedUnknown[key] : Object.prototype.hasOwnProperty.call(rawKnown, key) ? 0 : remaining;
      if (unknown[key] > remaining) throw new BudgetError('INVALID_BUDGET_RECEIPT');
    }
    for (const saved of reservationRows) {
      if (canonicalPermissionJson(amounts(saved.amount_json)) !== canonicalPermissionJson(reserved)) throw new BudgetError('BUDGET_CORRUPT');
      const account = db.prepare('SELECT * FROM m2_budget_accounts WHERE id=?').get(String(saved.account_id)) as Row | undefined;
      if (!account) throw new BudgetError('BUDGET_CORRUPT');
      const oldReserved = subtract(amounts(account.reserved_json), reserved);
      const newReserved = add(oldReserved, unknown), newUsed = add(amounts(account.used_json), known);
      const released = zeroAmounts();
      for (const key of BUDGET_AMOUNT_KEYS) released[key] = Math.max(0, reserved[key] - known[key] - unknown[key]);
      db.prepare('UPDATE m2_budget_accounts SET used_json=?,reserved_json=?,revision=revision+1,updated_at=? WHERE id=?')
        .run(canonicalPermissionJson(newUsed), canonicalPermissionJson(newReserved), instant(), String(saved.account_id));
      const state = BUDGET_AMOUNT_KEYS.some(key => unknown[key] > 0) ? 'unknown' : outcome === 'not_started' ? 'released' : 'settled';
      db.prepare('UPDATE m2_budget_reservations SET committed_json=?,unknown_held_json=?,state=?,settle_fingerprint=?,settled_at=? WHERE operation_id=? AND account_id=?')
        .run(canonicalPermissionJson(known), canonicalPermissionJson(unknown), state, fingerprint, instant(), operationId, String(saved.account_id));
      for (const [kind, amount] of [['spent', known], ['unknown_hold', unknown], ['released', released]] as const) {
        if (BUDGET_AMOUNT_KEYS.some(key => amount[key] > 0)) db.prepare('INSERT INTO m2_budget_usage_entries(operation_id,account_id,kind,amount_json,recorded_at) VALUES(?,?,?,?,?)')
          .run(operationId, String(saved.account_id), kind, canonicalPermissionJson(amount), instant());
      }
    }
  }
  function reconcileInterruptedInTransaction(): void {
    requireTransaction();
    const pending = db.prepare("SELECT DISTINCT r.operation_id FROM m2_budget_reservations r LEFT JOIN m2_operations o ON o.id=r.operation_id WHERE r.state='reserved' AND (o.id IS NULL OR o.state IN ('prepared','started','outcome_unknown')) ORDER BY r.operation_id").all() as Array<{ operation_id: string }>;
    for (const item of pending) settleInTransaction(item.operation_id, 'unknown');
  }
  function project(value: Row): BudgetAccountProjection {
    const limits = amounts(value.limits_json), used = amounts(value.used_json), reserved = amounts(value.reserved_json), remaining = zeroAmounts();
    for (const key of BUDGET_AMOUNT_KEYS) remaining[key] = Math.max(0, limits[key] - used[key] - reserved[key]);
    return { id: String(value.id), scope: value.scope as BudgetAccountProjection['scope'], scopeRef: String(value.scope_ref), windowKey: String(value.window_key),
      ...(value.window_start ? { windowStart: String(value.window_start), windowEnd: String(value.window_end), timezone: 'UTC' as const } : {}), limits, used, reserved, remaining, revision: Number(value.revision) };
  }
  return {
    reserveInTransaction, settleInTransaction, reconcileInterruptedInTransaction,
    listAccounts(context?: TaskRunContext): BudgetAccountProjection[] {
      if (!context) return (db.prepare('SELECT * FROM m2_budget_accounts ORDER BY scope,scope_ref,window_key').all() as Row[]).map(project);
      return accountsFor(context, false).map(project);
    },
  };
}
export type BudgetLedgerService = ReturnType<typeof createBudgetLedger>;
