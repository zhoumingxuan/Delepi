/** Public learning lives beside, and never rewrites, existing user skills. */
export const LEARNING_SCHEMA_SQL = `
CREATE TABLE muse_learning_captures (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, goal_id TEXT NOT NULL, goal_revision INTEGER NOT NULL,
 artifact_id TEXT NOT NULL, artifact_hash TEXT NOT NULL, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 candidate_id TEXT, status TEXT NOT NULL, reason_code TEXT, receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 created_at TEXT NOT NULL
);
CREATE INDEX muse_learning_captures_goal ON muse_learning_captures(goal_id,goal_revision,created_at);
CREATE TABLE muse_learning_candidates (
 id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, goal_id TEXT NOT NULL, goal_revision INTEGER NOT NULL,
 capture_id TEXT NOT NULL, content_json TEXT NOT NULL CHECK(json_valid(content_json)), content_hash TEXT NOT NULL, method_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('eligible','quarantined')), validation_id TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(skill_id,method_hash)
);
CREATE TABLE muse_learning_validations (
 id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE, candidate_hash TEXT NOT NULL,
 validator_version TEXT NOT NULL, report_json TEXT NOT NULL CHECK(json_valid(report_json)), report_hash TEXT NOT NULL,
 passed INTEGER NOT NULL CHECK(passed IN (0,1)), created_at TEXT NOT NULL
);
CREATE INDEX muse_learning_candidates_skill_created ON muse_learning_candidates(skill_id,created_at DESC,id DESC);
CREATE TABLE muse_learned_skills (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, goal_revision INTEGER NOT NULL, title_key TEXT NOT NULL, title TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, active_version_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(goal_id,goal_revision,title_key)
);
CREATE INDEX muse_learned_skills_goal_version ON muse_learned_skills(goal_id,goal_revision,updated_at DESC);
CREATE TABLE muse_learned_skill_versions (
 id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, ordinal INTEGER NOT NULL, candidate_id TEXT NOT NULL UNIQUE,
 content_hash TEXT NOT NULL, prior_version_id TEXT, created_at TEXT NOT NULL, UNIQUE(skill_id,ordinal)
);
CREATE TABLE muse_learning_pointer_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, skill_id TEXT NOT NULL, revision INTEGER NOT NULL,
 from_version_id TEXT, to_version_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('promote','rollback')),
 created_at TEXT NOT NULL, UNIQUE(skill_id,revision)
);
CREATE TRIGGER muse_learning_capture_no_update BEFORE UPDATE ON muse_learning_captures BEGIN SELECT RAISE(ABORT,'Learning capture immutable'); END;
CREATE TRIGGER muse_learning_capture_no_delete BEFORE DELETE ON muse_learning_captures BEGIN SELECT RAISE(ABORT,'Learning capture immutable'); END;
CREATE TRIGGER muse_learning_candidate_no_update BEFORE UPDATE ON muse_learning_candidates BEGIN SELECT RAISE(ABORT,'Learning candidate immutable'); END;
CREATE TRIGGER muse_learning_candidate_no_delete BEFORE DELETE ON muse_learning_candidates BEGIN SELECT RAISE(ABORT,'Learning candidate immutable'); END;
CREATE TRIGGER muse_learning_validation_no_update BEFORE UPDATE ON muse_learning_validations BEGIN SELECT RAISE(ABORT,'Learning validation immutable'); END;
CREATE TRIGGER muse_learning_validation_no_delete BEFORE DELETE ON muse_learning_validations BEGIN SELECT RAISE(ABORT,'Learning validation immutable'); END;
CREATE TRIGGER muse_learning_version_no_update BEFORE UPDATE ON muse_learned_skill_versions BEGIN SELECT RAISE(ABORT,'Learned version immutable'); END;
CREATE TRIGGER muse_learning_version_no_delete BEFORE DELETE ON muse_learned_skill_versions BEGIN SELECT RAISE(ABORT,'Learned version immutable'); END;
CREATE TRIGGER muse_learning_pointer_no_update BEFORE UPDATE ON muse_learning_pointer_events BEGIN SELECT RAISE(ABORT,'Learning event immutable'); END;
CREATE TRIGGER muse_learning_pointer_no_delete BEFORE DELETE ON muse_learning_pointer_events BEGIN SELECT RAISE(ABORT,'Learning event immutable'); END;
`;
