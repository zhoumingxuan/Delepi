# M2-C broker fixtures

These fixtures prepare C implementation tests while A/B are being reviewed. They do not activate brokers or contact a provider. Run native SQLite tests with the checkout's Electron Node mode; never rebuild the application's native modules for host Node.

`fixture.cjs` bundles real source with production DB/app singletons forbidden. Databases and files live in a canonical disposable `isolated-runs/m2-brokers-*` directory. `tlsFixture` starts a real TLS/HTTP server only on loopback; its request injection requires a production pinned DNS callback, verifies the public address provided to it, and maps that fixture target to loopback. The synthetic certificate and key are public test data, never imported by production code. Production keeps normal CA verification and does not contain this mapping.

`ip-boundaries.json` is the initial SSRF boundary matrix. A policy should be conservative for special-purpose addresses, reject mixed public/private answers and userinfo, revalidate redirects and never perform a second unpinned DNS resolution. Fixture transport records SNI/host/path and actual request count. Tests will additionally use real delayed bodies, chunked bodies, gzip bombs, redirect chains, cancellation and operation/ledger SQLite faults.

Target regression groups: all-account atomic reserve/idempotency, once/operation shared transaction, known vs unknown accounting, day-window persistence, every network attempt, pinned DNS/redirect, byte/decompression/absolute deadline, no cookies/proxy/key leakage, FileBroker identity/scope/publication and private-context model refusal.
