/** Additive migration: the reviewed M2 schema and its checksum stay unchanged. */
export const BACKGROUND_SCHEMA_SQL = `
CREATE TABLE muse_background_schedules (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL UNIQUE, goal_revision INTEGER NOT NULL,
 rule_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL DEFAULT 1,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), interval_minutes INTEGER NOT NULL CHECK(interval_minutes>=30),
 daily_round_limit INTEGER NOT NULL CHECK(daily_round_limit BETWEEN 1 AND 3), expires_at TEXT NOT NULL,
 protocol TEXT NOT NULL CHECK(protocol IN ('chat-completions','responses')),
 learning_enabled INTEGER NOT NULL CHECK(learning_enabled IN (0,1)), auto_promote INTEGER NOT NULL CHECK(auto_promote IN (0,1)),
 anchor_at TEXT NOT NULL, next_run_at TEXT NOT NULL, last_run_id TEXT, last_state TEXT, blocked_reason TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX muse_background_due ON muse_background_schedules(enabled,next_run_at);
CREATE TABLE muse_background_triggers (
 id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, slot_key TEXT NOT NULL, day_key TEXT NOT NULL,
 owner_id TEXT NOT NULL, run_id TEXT UNIQUE, state TEXT NOT NULL, reason_code TEXT,
 created_at TEXT NOT NULL, settled_at TEXT, UNIQUE(schedule_id,slot_key)
);
CREATE INDEX muse_background_trigger_state ON muse_background_triggers(state);
CREATE TABLE muse_background_daily (
 schedule_id TEXT NOT NULL, day_key TEXT NOT NULL, round_count INTEGER NOT NULL CHECK(round_count>=0),
 PRIMARY KEY(schedule_id,day_key)
);
CREATE TABLE muse_background_enablement_receipts (
 request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, preset TEXT NOT NULL,
 goal_id TEXT NOT NULL, schedule_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 protocol TEXT NOT NULL, consumed_at TEXT NOT NULL
);
`;
