import { BUDGET_SCHEMA_SQL } from '../../modules/budget/schema';

export const AUTONOMY_SCHEMA_SQL = `
CREATE TABLE m2_model_destinations (
 id TEXT PRIMARY KEY, source_key TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT NOT NULL,
 config_hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE m2_data_scopes (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL UNIQUE, classification TEXT NOT NULL CHECK(classification='public'),
 allowed_uses_json TEXT NOT NULL, destination_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE m2_goals (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL CHECK(state IN ('active','paused','archived')),
 title TEXT NOT NULL, topic TEXT NOT NULL, source_urls_json TEXT NOT NULL, destination_id TEXT NOT NULL,
 data_scope_id TEXT NOT NULL, expected_output TEXT NOT NULL, stop_conditions TEXT NOT NULL,
 limits_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE m2_resources (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, data_scope_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('public_url','public_snapshot','artifact')), url TEXT,
 file_path TEXT, content_hash TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
 revision INTEGER NOT NULL DEFAULT 1, parent_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX m2_resources_goal ON m2_resources(goal_id,kind);
CREATE TABLE m2_run_scopes (
 run_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, goal_revision INTEGER NOT NULL, data_scope_id TEXT NOT NULL,
 destination_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode='public'), owner_id TEXT NOT NULL,
 generation INTEGER NOT NULL, snapshot_json TEXT NOT NULL, deadline_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE m2_permission_policy (
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 1,
 policy_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO m2_permission_policy VALUES(1,1,'{"deniedCapabilities":[],"deniedLegacyTools":[]}',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE m2_approval_previews (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, owner_id TEXT NOT NULL,
 generation INTEGER NOT NULL, goal_id TEXT NOT NULL, goal_revision INTEGER NOT NULL, policy_revision INTEGER NOT NULL,
 caller_id INTEGER NOT NULL, intent_hash TEXT NOT NULL, intent_json TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'pending', expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX m2_pending_approvals ON m2_approval_previews(state,created_at);
CREATE TABLE m2_grants (
 id TEXT PRIMARY KEY, preview_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL, goal_id TEXT NOT NULL,
 owner_id TEXT NOT NULL, generation INTEGER NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('once','run')),
 action_hash TEXT NOT NULL, action_json TEXT NOT NULL, policy_revision INTEGER NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'active', expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE m2_rule_previews (
 id TEXT PRIMARY KEY, caller_id INTEGER NOT NULL, goal_id TEXT NOT NULL, goal_revision INTEGER NOT NULL,
 policy_revision INTEGER NOT NULL, scope_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 state TEXT NOT NULL DEFAULT 'pending', expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE m2_standing_rules (
 id TEXT PRIMARY KEY, preview_id TEXT NOT NULL UNIQUE, goal_id TEXT NOT NULL, goal_revision INTEGER NOT NULL,
 policy_revision INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, scope_json TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'active', expires_at TEXT NOT NULL, resume_after_restart INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE m2_operations (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, owner_id TEXT NOT NULL,
 generation INTEGER NOT NULL, goal_id TEXT NOT NULL, intent_hash TEXT NOT NULL, intent_json TEXT NOT NULL,
 grant_id TEXT, rule_id TEXT, state TEXT NOT NULL, result_kind TEXT,
 created_at TEXT NOT NULL, started_at TEXT, settled_at TEXT
);
CREATE TABLE m2_leases (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 owner_id TEXT NOT NULL, generation INTEGER NOT NULL, grant_id TEXT, rule_id TEXT,
 auth_revision INTEGER NOT NULL, policy_revision INTEGER NOT NULL, state TEXT NOT NULL,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE m2_audit_events (
 event_id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, refs_json TEXT NOT NULL,
 run_id TEXT, attempt_id TEXT, occurred_at TEXT NOT NULL
);
CREATE TRIGGER m2_audit_no_update BEFORE UPDATE ON m2_audit_events BEGIN SELECT RAISE(ABORT,'audit immutable'); END;
CREATE TRIGGER m2_audit_no_delete BEFORE DELETE ON m2_audit_events BEGIN SELECT RAISE(ABORT,'audit immutable'); END;
CREATE TABLE m2_exploration_plans (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, goal_revision INTEGER NOT NULL, caller_id INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'pending',
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE m2_exploration_sessions (
 id TEXT PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE, goal_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL, stop_reason TEXT, source_count INTEGER NOT NULL DEFAULT 0, artifact_id TEXT,
 created_at TEXT NOT NULL, settled_at TEXT
);
CREATE TABLE m2_public_inbox (
 run_id TEXT NOT NULL, message_id TEXT NOT NULL, classification TEXT NOT NULL CHECK(classification='public'),
 data_scope_id TEXT NOT NULL, goal_revision INTEGER NOT NULL, destination_id TEXT NOT NULL,
 PRIMARY KEY(run_id,message_id)
);
CREATE TABLE m2_artifact_scopes (
 artifact_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, data_scope_id TEXT NOT NULL, goal_revision INTEGER NOT NULL,
 source_refs_json TEXT NOT NULL, allowed_uses_json TEXT NOT NULL, created_at TEXT NOT NULL
);
` + BUDGET_SCHEMA_SQL;
