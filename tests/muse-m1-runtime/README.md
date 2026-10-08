# M1 runtime fixtures

Run `npm run test:muse:m1`. The runner uses the project's Electron executable in Node mode because the installed better-sqlite3 binary uses Electron's ABI. No dependency rebuild is needed.

These tests execute the real task repositories and service against real, isolated SQLite files under `isolated-runs/m1-runtime-*`. Provider responses and tool execution are synthetic. Production `getDb()` fails closed in the service fixture; the installed app, private chats/configuration and production userData are never accessed.

`hook.test.cjs` additionally launches a hidden isolated Electron window with real React, the production `useExecutorTaskRecords` hook and production preload. Its fixture IPC handlers call the production record store connected to the native SQLite task service. The fixture controls lost/held receipts and old queries; application trusted-sender IPC handlers are separately verified by the IPC suite. Seven browser scenarios verify actual row IDs/counts, shared-model-array injection count, persisted delivery uncertainty/cancellation, actual settlement projection and a fresh manual queue-full retry after capacity recovers. No new testing dependency or native rebuild is used.

Covered contracts:

- One active persisted run per conversation; root actual settle waits for every started child. A main reply DONE event cannot finalize a run.
- Trusted frozen identities; late callbacks and old controller unregister cannot affect the later owner.
- Startup interruption fences old generations, cancels accepted inbox and marks injecting delivery unknown, with no model/tool/message replay.
- Durable messageId idempotency and payload conflict rejection. Injecting commits before the shared model array changes; failed confirmation cannot imply delivery or replay.
- Stop remains a request until actual executor settlement. A SQLite stop-write failure still aborts the actual controller; failed settlement does not invent a completed database state.
- Rejected child admission/setup/settlement slots retain exactly one assistant/tool pair, wait for all started siblings and halt before another model request. Artifact review still runs if settlement persistence fails.
- The renderer keeps an unknown receipt's draft ID, shares concurrent sends, and allocates a new ID after definite acceptance/rejection or trusted task-identity replacement. The original rejected receipt remains immutable. Old task queries/signals cannot restore prior history; chat aborted triggers authoritative pull rather than invented terminal state.
- Immutable activity cursor paging, fixed throughEventId, and recovery by pull when an advisory wake is lost or throws.
- Transaction faults roll back identities/activity/injection and do not publish a successful wake. Activity and read DTOs contain no inbox body, reasoning, tool arguments or local paths.

This suite validates M1 runtime integration, not provider latency, end-user acceptance, installation or production migration.
