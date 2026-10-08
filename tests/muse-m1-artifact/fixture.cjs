'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { WORK, newRun, checked, inside } = require('../muse/paths.cjs');
const Database = require(checked(path.join(WORK, 'node_modules/better-sqlite3')));
const ts = require(checked(path.join(WORK, 'node_modules/typescript/lib/typescript.js')));

const REAL = [
  'src/main/db/repositories/artifact.repo.ts', 'src/main/db/migrations/runtime-schema.ts',
  ...['artifact-schema', 'files', 'preview', 'service', 'legacy-index'].map((p) => 'src/main/modules/artifacts/' + p + '.ts'),
  'src/main/utils/storage-output.ts', 'src/main/utils/storage-paths.ts',
  'src/main/modules/executor-agent/executor-structured-payload.ts',
  ...['index', 'agent', 'paths', 'errors', 'events', 'tools'].map((p) => 'src/main/constants/' + p + '.ts'),
];

function fixture(t, hooks = {}) {
  const root = newRun();
  const dbPath = path.join(root, 'artifact-fixture.sqlite');
  let db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const windows = [], opened = [], writes = [];
  class Window {
    constructor(options) {
      this.options = options; this.events = {}; this.destroyed = false;
      const session = this.session = { setPermissionRequestHandler: (f) => { session.permissionRequest = f; },
        setPermissionCheckHandler: (f) => { session.permissionCheck = f; },
        webRequest: { onBeforeRequest: (f) => { session.request = f; } },
        on: (name, f) => { session[name] = f; } };
      this.webContents = { session, setWindowOpenHandler: (f) => { this.popup = f; },
        on: (name, f) => { this.events[name] = f; } };
      windows.push(this);
    }
    once(name, f) { this.events[name] = f; }
    async loadURL(url) { this.url = url; }
    isDestroyed() { return this.destroyed; }
    show() { this.shown = true; }
    destroy() { this.destroyed = true; this.events.closed?.(); }
  }
  function safe(target, ancestors = false) {
    const absolute = path.resolve(target);
    if (ancestors && inside(absolute, root)) return absolute; // metadata-only ancestor lstat
    return checked(absolute, root, { missing: true });
  }
  const guarded = {};
  for (const method of ['lstat', 'open', 'realpath', 'copyFile', 'link', 'mkdir', 'unlink', 'opendir', 'readFile']) {
    guarded[method] = async (target, ...args) => {
      safe(target, method === 'lstat');
      if (method === 'copyFile' || method === 'link') safe(args[0]);
      await hooks.before?.({ method, target, args, root });
      if (['copyFile', 'link', 'mkdir', 'unlink'].includes(method)) writes.push({ method, target, args });
      const result = await fsp[method](target, ...args);
      await hooks.after?.({ method, target, args, result, root });
      return result;
    };
  }
  const mocks = {
    'node:fs/promises': guarded,
    'node:fs': { constants: fs.constants },
    electron: { BrowserWindow: Window, shell: { openPath: async (p) => { safe(p); opened.push(p); return ''; } },
      app: { isPackaged: true, getPath: (name) => path.join(root, name) } },
    [path.join(WORK, 'src/main/db/sqlite-adapter.ts')]: { getDb: () => db },
    [path.join(WORK, 'src/main/utils/uploads.ts')]: { appendConversationOutputFileManifest: async (id, paths) => {
      for (const p of paths) safe(p);
      fs.writeFileSync(path.join(root, 'manifest-' + id + '.json'), JSON.stringify(paths));
    } },
    [path.join(WORK, 'src/main/utils/index.ts')]: { isRecord: (x) => !!x && typeof x === 'object' && !Array.isArray(x) },
  };
  const context = vm.createContext({ Buffer, Date, Error, TypeError, JSON, Promise, URL, AbortController, AbortSignal,
    console, process: Object.freeze({ platform: 'darwin', cwd: () => root, resourcesPath: root, env: Object.freeze({}) }) });
  let cache = new Map();
  function load(relative) {
    const filename = checked(path.resolve(WORK, relative));
    if (cache.has(filename)) return cache.get(filename).exports;
    if (!REAL.includes(path.relative(WORK, filename))) throw Error('Artifact fixture blocked module before load: ' + relative);
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename, reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    if (output.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error)) throw Error('Fixture transpile failed');
    const module = { exports: {} }; cache.set(filename, module);
    const requireLocal = (spec) => {
      let key = spec;
      if (spec.startsWith('.')) {
        const absolute = path.resolve(path.dirname(filename), spec);
        key = ['.ts', '/index.ts'].map((suffix) => absolute + suffix).find((p) => Object.hasOwn(mocks, p) || REAL.includes(path.relative(WORK, p))) || absolute;
      }
      if (Object.hasOwn(mocks, key)) return mocks[key];
      if (['node:path', 'node:crypto'].includes(spec)) return require(spec);
      if (REAL.includes(path.relative(WORK, key))) return load(path.relative(WORK, key));
      throw Error('Unmocked dependency blocked before load: ' + spec);
    };
    new vm.Script('(function(require,module,exports){\n' + output.outputText + '\n})', { filename }).runInContext(context)(requireLocal, module, module.exports);
    return module.exports;
  }
  db.exec(load('src/main/db/migrations/runtime-schema.ts').RUNTIME_SCHEMA_SQL);
  db.exec(load('src/main/modules/artifacts/artifact-schema.ts').ARTIFACT_SCHEMA_SQL);
  const origin = { runId: 'R', attemptId: 'A', conversationId: 'C', generation: 1, ownerId: 'fixture-owner' };
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO runs(id,conversation_id,root_attempt_id,owner_id,generation,state,created_at,updated_at)
    VALUES(?,?,?,?,?,'running',?,?)`).run(origin.runId, origin.conversationId, origin.attemptId, origin.ownerId, 1, now, now);
  db.prepare(`INSERT INTO task_attempts(id,run_id,task_id,owner_id,generation,state,started_at)
    VALUES(?,?,?,?,?,'running',?)`).run(origin.attemptId, origin.runId, 'fixture-task', origin.ownerId, 1, now);
  function write(relative, body = 'synthetic fixture only') {
    const target = safe(path.join(root, relative));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body); return target;
  }
  function restart() { db.close(); db = new Database(dbPath); cache = new Map(); return load('src/main/modules/artifacts/service.ts'); }
  const service = load('src/main/modules/artifacts/service.ts');
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, origin, windows, opened, writes, load, write, service, restart, get db() { return db; } };
}
module.exports = { fixture, plain: (x) => JSON.parse(JSON.stringify(x)) };
