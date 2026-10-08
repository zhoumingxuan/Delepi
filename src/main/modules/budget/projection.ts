import type Database from 'better-sqlite3';
import type { BudgetProjection } from '@shared/types/autonomy';
import { permissionId } from '../permissions/permission-validation';
import { BUDGET_AMOUNT_KEYS, validateAmounts, zeroAmounts } from './ledger';

/** Read-only UI projection. Listing budgets never creates or resets accounts. */
export function readBudgetProjection(db: Database.Database, goalId?: string, runId?: string): BudgetProjection {
  if (goalId !== undefined) permissionId(goalId);
  if (runId !== undefined) permissionId(runId);
  if (runId !== undefined && goalId === undefined) {
    const binding = db.prepare('SELECT goal_id FROM m2_run_scopes WHERE run_id=?').get(runId) as { goal_id: string } | undefined;
    goalId = binding?.goal_id;
  }
  const rows = db.prepare('SELECT * FROM m2_budget_accounts ORDER BY scope,scope_ref,window_key').all() as Array<Record<string, unknown>>;
  const at = Date.now();
  return { accounts: rows.filter(value => {
    if (value.scope === 'global') return true;
    if (value.scope === 'day') return !value.window_end || Date.parse(String(value.window_end)) > at || Object.values(validateAmounts(JSON.parse(String(value.reserved_json)))).some(amount => amount > 0);
    if (value.scope === 'goal') return goalId === undefined || value.scope_ref === goalId;
    if (value.scope === 'run') return runId !== undefined && value.scope_ref === runId;
    return false;
  }).map(value => {
    const limits = validateAmounts(JSON.parse(String(value.limits_json))), used = validateAmounts(JSON.parse(String(value.used_json))), reserved = validateAmounts(JSON.parse(String(value.reserved_json))), remaining = zeroAmounts();
    for (const key of BUDGET_AMOUNT_KEYS) remaining[key] = Math.max(0, limits[key] - used[key] - reserved[key]);
    return { id: String(value.id), kind: value.scope === 'day' ? `UTC day ${value.window_key}` : String(value.scope),
      scope: value.scope as 'global' | 'goal' | 'run' | 'day', scopeRef: String(value.scope_ref), windowKey: String(value.window_key),
      ...(value.window_start ? { windowStart: String(value.window_start), windowEnd: String(value.window_end), timezone: 'UTC' as const } : {}),
      limits, used, reserved, remaining, revision: Number(value.revision) };
  }) };
}
