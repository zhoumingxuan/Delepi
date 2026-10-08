/** M2 additive budget schema. All amount objects use the five integer counters below.
 * This SQL is frozen as part of migration v2 before any budget execution is enabled. */
const ZERO_AMOUNTS = '{"modelRequests":0,"fetchRequests":0,"downloadBytes":0,"storageBytes":0,"tokenUnits":0}';
const amountCheck = (column: string) => ['modelRequests','fetchRequests','downloadBytes','storageBytes','tokenUnits']
  .map(key => `json_type(${column},'$.${key}') IS 'integer' AND json_extract(${column},'$.${key}') BETWEEN 0 AND 9007199254740991`).join(' AND ');

export const BUDGET_SCHEMA_SQL = `
CREATE TABLE m2_budget_accounts (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL CHECK(scope IN ('global','goal','run','day')),
 scope_ref TEXT NOT NULL,
 window_key TEXT NOT NULL,
 window_start TEXT, window_end TEXT, timezone TEXT,
 limits_json TEXT NOT NULL CHECK(json_valid(limits_json) AND json_type(limits_json)='object' AND ${amountCheck('limits_json')}),
 used_json TEXT NOT NULL DEFAULT '${ZERO_AMOUNTS}' CHECK(json_valid(used_json) AND json_type(used_json)='object' AND ${amountCheck('used_json')}),
 reserved_json TEXT NOT NULL DEFAULT '${ZERO_AMOUNTS}' CHECK(json_valid(reserved_json) AND json_type(reserved_json)='object' AND ${amountCheck('reserved_json')}),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(scope,scope_ref,window_key),
 CHECK(scope<>'day' OR (window_start IS NOT NULL AND window_end IS NOT NULL AND timezone IS NOT NULL))
);
CREATE INDEX idx_m2_budget_accounts_scope ON m2_budget_accounts(scope,scope_ref,window_end);
CREATE TABLE m2_budget_reservations (
 operation_id TEXT NOT NULL, account_id TEXT NOT NULL,
 owner_id TEXT NOT NULL, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=1),
 amount_json TEXT NOT NULL CHECK(json_valid(amount_json) AND json_type(amount_json)='object' AND ${amountCheck('amount_json')}),
 committed_json TEXT NOT NULL DEFAULT '${ZERO_AMOUNTS}' CHECK(json_valid(committed_json) AND json_type(committed_json)='object' AND ${amountCheck('committed_json')}),
 unknown_held_json TEXT NOT NULL DEFAULT '${ZERO_AMOUNTS}' CHECK(json_valid(unknown_held_json) AND json_type(unknown_held_json)='object' AND ${amountCheck('unknown_held_json')}),
 state TEXT NOT NULL CHECK(state IN ('reserved','settled','released','unknown')),
 settle_fingerprint TEXT,
 created_at TEXT NOT NULL, settled_at TEXT,
 PRIMARY KEY(operation_id,account_id),
 FOREIGN KEY(account_id) REFERENCES m2_budget_accounts(id)
);
CREATE INDEX idx_m2_budget_reservations_run ON m2_budget_reservations(run_id,state);
CREATE INDEX idx_m2_budget_reservations_account ON m2_budget_reservations(account_id,state);
CREATE TABLE m2_budget_usage_entries (
 entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
 operation_id TEXT NOT NULL, account_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('spent','unknown_hold','released')),
 amount_json TEXT NOT NULL CHECK(json_valid(amount_json) AND json_type(amount_json)='object' AND ${amountCheck('amount_json')}),
 recorded_at TEXT NOT NULL,
 UNIQUE(operation_id,account_id,kind),
 FOREIGN KEY(operation_id,account_id) REFERENCES m2_budget_reservations(operation_id,account_id)
);
CREATE INDEX idx_m2_budget_usage_account ON m2_budget_usage_entries(account_id,entry_id);
CREATE TRIGGER m2_budget_usage_no_update BEFORE UPDATE ON m2_budget_usage_entries BEGIN SELECT RAISE(ABORT,'Budget usage entries are immutable'); END;
CREATE TRIGGER m2_budget_usage_no_delete BEFORE DELETE ON m2_budget_usage_entries BEGIN SELECT RAISE(ABORT,'Budget usage entries are immutable'); END;
`;
