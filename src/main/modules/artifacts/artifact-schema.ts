/** Additive M1 artifact structures; migrations own when this SQL is applied. */
export const ARTIFACT_SCHEMA_SQL = `
CREATE TABLE artifacts (
 id TEXT PRIMARY KEY, run_id TEXT, attempt_id TEXT, conversation_id TEXT,
 source_path TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL,
 content_hash TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
 save_state TEXT NOT NULL CHECK(save_state IN ('staging','saved','failed','missing','quarantined')),
 validation_state TEXT NOT NULL DEFAULT 'pending' CHECK(validation_state IN ('pending','passed','failed','not_applicable')),
 acceptance_state TEXT NOT NULL DEFAULT 'unreviewed' CHECK(acceptance_state IN ('unreviewed','accepted','rejected')),
 needs_review INTEGER NOT NULL DEFAULT 0 CHECK(needs_review IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_run_created ON artifacts(run_id,created_at DESC,id);
CREATE INDEX idx_artifacts_conversation_created ON artifacts(conversation_id,created_at DESC,id);
CREATE TABLE artifact_publish_journal (
 id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL UNIQUE,
 source_path TEXT NOT NULL, target_path TEXT NOT NULL, staging_path TEXT NOT NULL,
 expected_hash TEXT NOT NULL, size_bytes INTEGER NOT NULL,
 file_dev INTEGER, file_ino INTEGER,
 phase TEXT NOT NULL CHECK(phase IN ('intent','staged','published','registered','failed','needs_review')),
 error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_artifact_publish_phase ON artifact_publish_journal(phase,created_at);
CREATE TABLE artifact_accept_requests (
 request_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, accepted INTEGER NOT NULL,
 expected_revision INTEGER NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at TEXT NOT NULL
);
`;
