# Personal Muse: M0–M2 and bounded background learning

This branch preserves the customized Delepi 0.7.0 implementation built from upstream commit `31e22e61b0bfecfe114c4a4c8315860684a7c37b`. It includes the M0 runtime fixes, M1 task and artifact foundation, M2 scoped public exploration and approvals, and bounded background learning. Subsequent upstream changes are not included in this installed-version snapshot.

## Implemented behavior

- Runtime cancellation, adapter initialization, queued additions and tool completion preserve their actual execution state. Task cleanup retains persistent workspaces and deliverables.
- Configuration import/export uses explicit confirmation, atomic writes and revision checks. Mac settings menu, operating-system permission status and application version are exposed in the UI.
- Task Runs, attempts, activity, inbox and independent artifacts persist in SQLite. Artifacts have separate save, validation and user acceptance states.
- Public goals bind a model destination, finite source URLs, allowed uses, budgets and revision. Approval cards and standing rules grant specific scopes. Foreground denial and scope changes also apply to the brokers.
- Public fetches enforce HTTPS, public DNS addresses, one pinned address, TLS verification, byte limits and actual connected-peer comparison. Redirects, cookie jars, implicit proxies and protocol probes are not used. Node lookup callbacks honor both single-address and `all:true` contracts.
- The background scheduler admits at most one background Run, prioritizes foreground work, keeps persistent UTC daily counters, deduplicates time slots, and drains owned work on pause, expiry or revocation. Sleep pauses it; wake processes the latest due slot. Closing a Mac window keeps the app running; quitting the app stops scheduling.
- Public report candidates can become immutable, scoped text-method versions. Capture verifies source/report integrity and the original artifact's learning grant. A fixed gate validates format, provenance, size and advisory text restrictions. Active versions, deduplication, CAS updates and rollback are separate from the existing custom, builtin and executable skills.
- Subsequent model requests for the same goal and revision use authorized active methods. Changed scope, rejected source artifacts and revoked permission stop their adoption. Semantic correctness and measured business improvement are not evaluated by the structural gate.

## Modules and interfaces

| Area | Main-process entry | Renderer API |
| --- | --- | --- |
| Configuration | `modules/config/config-ipc.ts` | confirmed configuration import/export |
| Tasks and activity | `modules/tasks/task-service.ts`, `modules/muse-ipc.ts` | `electronAPI.muse` |
| Artifacts | `modules/artifacts/service.ts` | Muse artifact inspection, validation and acceptance |
| Goals and permissions | `modules/goals/goal-service.ts`, `modules/permissions/authority.ts` | `electronAPI.autonomy` |
| Public research | `modules/exploration/exploration-service.ts`, `modules/brokers/` | plan, start, stop and public additions |
| Background scheduling | `modules/background/scheduler.ts`, `background-ipc.ts` | `electronAPI.background` |
| Learning | `modules/learning/learning-service.ts` | scoped skill metadata and revision-bound rollback |

`background.configure(goalId, goalRevision, configuration, consent)` requires explicit consent and the trusted main window. Configuration contains `intervalMinutes`, `dailyRoundLimit`, `expiresAt`, an explicit `chat-completions` or `responses` protocol, `learningEnabled` and `autoPromote`. Supported bounds are 30–1440 minutes, 1–3 rounds per UTC day and no more than 30 days. Read and mutation endpoints do not accept arbitrary file paths, credentials or execution-owner identities.

The installed Excel preset uses pandas missing-data/import-export and openpyxl optimized-mode official documents, a 30-minute interval, 3 rounds per UTC day and a seven-day grant. `installation-bootstrap.ts` consumes only a finite, fixed-preset, user-authorized request from the private userData Muse directory. It validates ownership, permissions and file identity, then atomically creates the goal, rule, schedule and receipt. Replaying a completed request cannot undo a later user pause. A normal fresh install has no automatic background authorization.

## Data preservation

SQLite migrations V1–V5 are additive and take a consistent backup before changing schema. Existing conversations, messages, settings, compression history and user files stay in the same application data directory. Existing migration checksums are preserved. Only exact, enabled, unexpired scheduler-linked rules with unchanged scope can resume after restart; standalone rules remain suspended.

Production profiles, credentials, chats, skills collected from private work, database copies and packaged runtimes are not part of this branch. The TLS certificate and key under `tests/muse-m2-brokers/fixtures/` are public, synthetic test material used exclusively by isolated test servers.

## Build and validation

Use the Node version supported by Vite and the Electron version resolved in `package-lock.json`:

```sh
npm ci
npm run build
npm run test:muse:foundation
npm run test:muse:m1
npm run test:muse:m2
npm run test:muse:background
```

`npm ci` invokes Electron's native-dependency setup. M1/M2/background runners launch the native SQLite tests under the application's Electron ABI. Browser scenarios use isolated fixture directories and synthetic providers.

The installed source passed 54 M0, 95 M1, 198 M2 and 70 background tests (417 total). Separate source and packaged GUI checks each passed 17 scenarios. Mac package validation covered 320 packaged dist files, 372 arm64-capable Mach-O files, SQLite, Sharp, Python/ODBC, strict signatures and DMG integrity. The package used ad-hoc signing and was not Apple-notarized.

To produce a Mac package, follow the existing Python-resource builder before running electron-builder:

```sh
npm run build:preset-python-mac
npx electron-builder --config electron-builder-mac.yml
```

Local archive replay scripts depend on historical installation evidence and are retained outside this source branch. Historical product discussions and private installation receipts are also kept locally; this document describes the current implementation.
