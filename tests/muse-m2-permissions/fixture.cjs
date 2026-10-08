'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const Database = require('better-sqlite3');
const work = path.resolve(__dirname, '../..');
let bundled;
async function exportsForFixture() {
  return bundled ??= esbuild.build({ stdin: { contents: [
    'export * from "./src/main/modules/permissions/authority";',
    'export * from "./src/main/modules/tasks/task-service";',
    'export * from "./src/main/db/migrations/runtime-schema";',
    'export * from "./src/main/db/migrations/autonomy-schema";',
  ].join('\n'), resolveDir: work }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['better-sqlite3'], plugins: [{ name: 'never-production-data', setup(build) {
    build.onResolve({ filter: /sqlite-adapter$/ }, () => ({ path: 'fixture-db', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const getDb=()=>{throw Error("Production userData access forbidden");}', loader: 'js' }));
  } }] }).then(result => {
    const filename = path.join(work, 'isolated-runs', 'm2-permissions.cjs'), loaded = new Module(filename, module);
    loaded.filename = filename; loaded.paths = module.paths; loaded._compile(result.outputFiles[0].text, filename); return loaded.exports;
  });
}
async function fixture(t, extras = {}) {
  const allowed = path.join(work, 'isolated-runs'); fs.mkdirSync(allowed, { recursive: true });
  const root = fs.mkdtempSync(path.join(allowed, 'm2-permissions-'));
  const api = await exportsForFixture(), db = new Database(path.join(root, 'synthetic.sqlite'));
  db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);");
  db.exec(api.RUNTIME_SCHEMA_SQL + api.AUTONOMY_SCHEMA_SQL);
  db.exec('CREATE TABLE fixture_reservations(id TEXT PRIMARY KEY,units_json TEXT NOT NULL,state TEXT NOT NULL)');
  let n = 0, instant = Date.parse('2030-01-01T00:00:00.000Z');
  const taskService = api.createTaskService(db, { ownerId: 'fixture-owner', uuid: () => `task-${++n}`, now: () => new Date(instant).toISOString() });
  const context = taskService.beginRun('fixture-conversation');
  const limits = { modelRequests: 6, fetchRequests: 8, downloadBytes: 5000, storageBytes: 5000, tokenUnits: 1000, activeMilliseconds: 300000, absoluteMilliseconds: 900000, maxDocumentBytes: 1000, concurrency: 2 };
  db.prepare("INSERT INTO m2_model_destinations VALUES('model-fixture','main','https://example.invalid/v1','fixture-model','opaque-secret-hash',1,?)").run(new Date(instant).toISOString());
  db.prepare("INSERT INTO m2_goals VALUES('goal-fixture',1,'active','Fixture','Public topic','[]','model-fixture','scope-fixture','Report','Bounded',?,?,?)").run(JSON.stringify(limits), new Date(instant).toISOString(), new Date(instant).toISOString());
  db.prepare("INSERT INTO m2_data_scopes VALUES('scope-fixture','goal-fixture','public',?,'model-fixture',1,?)").run(JSON.stringify(['fetch.public', 'model.invoke', 'file.read_public', 'artifact.publish']), new Date(instant).toISOString());
  db.prepare("INSERT INTO m2_resources(id,goal_id,data_scope_id,kind,url,content_hash,size_bytes,revision,created_at) VALUES('resource-fixture','goal-fixture','scope-fixture','public_url','https://example.invalid/doc','fixture-resource-hash',0,1,?)").run(new Date(instant).toISOString());
  db.prepare("INSERT INTO m2_run_scopes VALUES(?,'goal-fixture',1,'scope-fixture','model-fixture','public','fixture-owner',1,?,?,?)").run(context.runId, JSON.stringify({ goal: { id: 'goal-fixture', revision: 1 }, resources: [{ id: 'resource-fixture', kind: 'public_url', revision: 1, contentHash: 'fixture-resource-hash' }], destination: { id: 'model-fixture', revision: 1, configHash: 'opaque-secret-hash' }, limits }), new Date(instant + 900000).toISOString(), new Date(instant).toISOString());
  const budget = {
    reserveInTransaction(operationId, action) { assertTransaction(); db.prepare("INSERT INTO fixture_reservations VALUES(?,?,'reserved')").run(operationId, JSON.stringify(action.units)); return operationId; },
    settleInTransaction(operationId, outcome) { assertTransaction(); db.prepare('UPDATE fixture_reservations SET state=? WHERE id=?').run(outcome, operationId); },
  };
  function assertTransaction() { if (!db.inTransaction) throw Error('Budget escaped transaction'); }
  const deps = { taskService, now: () => instant, uuid: () => `authority-${++n}`, budget, ...extras };
  const authority = api.createPermissionAuthority(db, deps);
  const action = { capability: 'fetch.public', resourceRef: 'resource-fixture', resourceVersion: '1:fixture-resource-hash', summary: 'Read approved public document', units: { modelRequests: 0, fetchRequests: 1, downloadBytes: 1000, storageBytes: 0, tokenUnits: 0 } };
  const preview = () => authority.previewAction(context, action, 1);
  const authorize = (choice = 'once') => { const card = preview(); return authority.decideApproval(card.id, card.revision, choice, 1); };
  t.after(() => { authority.dispose(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, api, authority, context, taskService, action, preview, authorize, deps, advance: ms => { instant += ms; }, now: () => instant, limits };
}
module.exports = { fixture };
