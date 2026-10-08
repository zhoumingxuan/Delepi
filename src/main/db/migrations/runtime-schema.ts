/** M1 structures are additive. Never recreate or rewrite legacy chat/settings tables. */
export const RUNTIME_SCHEMA_SQL = `
CREATE TABLE runs (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, root_attempt_id TEXT NOT NULL,
 owner_id TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
 state TEXT NOT NULL CHECK(state IN ('running','stop_requested','completed','failed','cancelled','interrupted')),
 revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, settled_at TEXT
);
CREATE UNIQUE INDEX idx_runs_active_conversation ON runs(conversation_id) WHERE state IN ('running','stop_requested');
CREATE INDEX idx_runs_created ON runs(created_at DESC,id);
CREATE TABLE task_attempts (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, parent_attempt_id TEXT,
 delegate_call_id TEXT, owner_id TEXT NOT NULL, generation INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('running','stop_requested','completed','failed','cancelled','interrupted')),
 started_at TEXT NOT NULL, settled_at TEXT, result_kind TEXT,
 UNIQUE(run_id,task_id,generation)
);
CREATE INDEX idx_attempts_run_state ON task_attempts(run_id,state);
CREATE INDEX idx_attempts_delegate ON task_attempts(run_id,delegate_call_id);
CREATE TABLE activity_events (
 event_id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, attempt_id TEXT,
 conversation_id TEXT NOT NULL, kind TEXT NOT NULL,
 details_json TEXT NOT NULL CHECK(json_valid(details_json)), occurred_at TEXT NOT NULL, committed_at TEXT NOT NULL
);
CREATE INDEX idx_activity_run_cursor ON activity_events(run_id,event_id);
CREATE INDEX idx_activity_conversation_cursor ON activity_events(conversation_id,event_id);
CREATE TRIGGER activity_events_no_update BEFORE UPDATE ON activity_events BEGIN SELECT RAISE(ABORT,'Activity events are immutable'); END;
CREATE TRIGGER activity_events_no_delete BEFORE DELETE ON activity_events BEGIN SELECT RAISE(ABORT,'Activity events are immutable'); END;
CREATE TABLE run_inbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 message_id TEXT NOT NULL, generation INTEGER NOT NULL, text TEXT NOT NULL, content_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('accepted','injecting','injected','rejected','cancelled','delivery_unknown')),
 reason_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, injected_at TEXT,
 UNIQUE(run_id,message_id)
);
CREATE INDEX idx_inbox_attempt_state ON run_inbox(attempt_id,state,id);
`;
