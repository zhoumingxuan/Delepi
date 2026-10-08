# Public text learning

`createLearningService(db, { now?, uuid?, wake? })` uses only the supplied database. It never opens the production database, reads private chat/legacy skills, scans executable directories, runs a generated tool, or makes a new model request.

`captureCompletedRun(runId, { autoPromote })` accepts a fully settled public exploration with its own successful artifact and fetch/read/write receipts. Both the current same-revision goal scope and the original artifact must explicitly permit `learning.capture`. It checks real report and source file hash, byte count, inode and parent identity. It stores only the candidate, a small source manifest and a fixed validation report; it does not copy the full source or report into learning storage.

The report must contain one `<!-- delepi-skill-candidate:v1 -->` followed by a JSON fenced block with `title`, `summary`, `applicability`, `steps`, `checks`, `limitations`, and `sourceRefs`. A normal report without that block records `no_candidate`, not a fabricated skill. Malformed blocks record a quarantined note. Invalid structured/executable candidates remain in the isolated SQLite candidate table.

The fixed gate checks shape, source membership, byte size and conservative plain text rules. Its report explicitly records `semanticCorrectness: not_evaluated` and `execution: not_allowed`. These are advisory methods, not model training or proof of effectiveness. The public model broker still enforces its own permissions and budgets.

Promoted candidates and revisions are immutable. The separate active pointer changes with CAS. A concurrent stale capture preserves its candidate and returns `promotion_conflict` instead of overwriting the winner. Deduplication uses normalized method and source URL/content hashes, so a repeated fetch that creates new resource IDs does not create another identical version. Changed method/source bytes receive a new fixed validation report.

`promptForGoal(goalId, goalRevision)` returns an authorized prompt with the generation instruction and valid active methods, bounded to 8192 UTF-8 bytes. It returns an empty string after current scope revocation or goal version changes. It rechecks candidate/validation hashes and stops using methods derived from rejected, missing, quarantined, review-required, or no-longer-authorized artifacts. The broker must take this snapshot when it creates the next model body; existing Run bodies are not rewritten.

`list(goalId?)` returns a safe metadata projection including exact active version/hash and captured source Run/artifact refs. `rollback(id, expectedRevision)` moves only the future active pointer to its validated prior version, or disables the first version. It keeps every candidate, revision, validation and pointer receipt, and never undoes external effects or changes a running Run.

The database has finite capture (1000), candidate (500), and candidate/evidence byte (8 MiB) limits. Exhaustion returns `LEARNING_STORAGE_LIMIT` without deleting old evidence, resetting budgets or overwriting user files. Parent scheduling must expose this result and avoid retry loops.

Migration ownership belongs to the main startup migration runner: apply `LEARNING_SCHEMA_SQL` once as a new version, preserving old accepted migration checksums. Services do not create or modify schema on demand.
