# Muse foundation regressions

Run from the development checkout with its locked dependencies:

```sh
npm run test:muse:foundation
npm run build
```

The dispatcher fixtures execute the real main agent, executor, payload parser,
record store and Chat Completions framing. Protocol discovery and model/tool
responses are controlled inputs; separate runtime fixtures cover the real
factory, probe and adapter transport lifecycle. The VM loader blocks unknown
imports and restricts fixture file operations to a newly created isolated run.
No real providers, app installation, production database or credentials are used.

Tests assert observable dispatch arguments, tool timing, ordered message pairing,
cancellation, release after actual batch settlement and safe-point inbox injection.
Cleanup tests use real synthetic files, libraries and symbolic links. They do not
prove OS isolation against an arbitrary trusted Shell/Python process or every
path replacement race during a path-based recursive deletion.

Passing these checks establishes M0 behavior and a buildable local change. It
does not establish M1 persistence, M2 permission enforcement, autonomous research,
validated skill promotion, a packaged macOS GUI or real-model task quality.
