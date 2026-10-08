'use strict';
const path = require('node:path');
const { fixture: authorityFixture } = require('../muse-m2-permissions/fixture.cjs');
const { loadSource, sha } = require('./fixture.cjs');
let apiPromise;
function sourceApi() {
  return apiPromise ??= Promise.all([
    loadSource('src/main/modules/brokers/index.ts'), loadSource('src/main/modules/budget/ledger.ts'),
    loadSource('src/main/modules/budget/contracts.ts'), loadSource('src/main/modules/budget/run-clock.ts'),
    loadSource('src/main/db/migrations/broker-storage-schema.ts'),
  ]).then(([brokers, ledger, contracts, clock, storage]) => ({ ...brokers, ...ledger, ...contracts, ...clock, ...storage }));
}
async function runtimeFixture(t, extras = {}) {
  const f = await authorityFixture(t), api = await sourceApi();
  if (api.BROKER_STORAGE_SCHEMA_SQL) f.db.exec(api.BROKER_STORAGE_SCHEMA_SQL);
  const sourceUrl = 'https://source.fixture.test/public', contentHash = sha(sourceUrl);
  f.db.prepare("UPDATE m2_resources SET url=?,content_hash=? WHERE id='resource-fixture'").run(sourceUrl, contentHash);
  f.action = { ...f.action, resourceVersion: `1:${contentHash}` };
  f.db.prepare("INSERT INTO m2_resources(id,goal_id,data_scope_id,kind,content_hash,size_bytes,revision,created_at) VALUES('output-anchor','goal-fixture','scope-fixture','artifact','anchor-hash',0,1,?)").run(new Date(f.now()).toISOString());
  const root = path.dirname(f.db.name), publicRoot = path.join(root, 'public');
  const resources = [{ id: 'resource-fixture', goalId: 'goal-fixture', dataScopeId: 'scope-fixture', kind: 'public_url', url: sourceUrl, contentHash, revision: 1, sizeBytes: 0 },
    { id: 'output-anchor', goalId: 'goal-fixture', dataScopeId: 'scope-fixture', kind: 'artifact', contentHash: 'anchor-hash', revision: 1, sizeBytes: 0 }];
  const limits = { ...f.limits, ...extras.limits };
  const goal = { id: 'goal-fixture', revision: 1, state: 'active', title: 'Synthetic public study', topic: 'A public synthetic topic', sourceUrls: [sourceUrl], destinationId: 'model-fixture', dataScopeId: 'scope-fixture', expectedOutput: 'A report', stopConditions: 'Bounded', limits };
  const snapshot = { goal, resources, destination: { id: 'model-fixture', revision: 1, configHash: 'opaque-secret-hash' }, limits };
  f.db.prepare('UPDATE m2_run_scopes SET snapshot_json=? WHERE run_id=?').run(JSON.stringify(snapshot), f.context.runId);
  const caps = extras.caps ?? api.DEFAULT_PUBLIC_BUDGET_CAPS;
  const ledger = api.createBudgetLedger(f.db, { caps, now: f.now });
  f.authority.dispose();
  const authority = f.api.createPermissionAuthority(f.db, { ...f.deps, budget: ledger });
  const clock = api.createRunClock({ activeMilliseconds: limits.activeMilliseconds, deadlineAt: new Date(f.now() + 900000).toISOString(), wallNow: f.now });
  const controller = new AbortController(), concurrency = api.createBrokerConcurrency(limits.concurrency);
  const session = api.createBrokerSession({ context: f.context, authority, clock, concurrency, signal: controller.signal, callerId: 1 });
  const file = api.createFileBroker(f.db, { publicRoot });
  const authorizeRule = (capabilities = ['fetch.public','file.read_public','model.invoke','artifact.publish']) => {
    const card = authority.previewRule({ goalId: 'goal-fixture', expectedGoalRevision: 1, capabilities,
      resourceRefs: snapshot.resources.map(value => value.id), expiresAt: new Date(f.now() + 900000).toISOString(), resumeAfterRestart: false }, 1);
    return authority.issueRule(card.id, 1, 1);
  };
  t.after(() => { session.close(); clock.dispose(); authority.dispose(); });
  return { ...f, api, authority, ledger, clock, controller, concurrency, session, file, caps, snapshot, publicRoot, authorizeRule };
}
module.exports = { sourceApi, runtimeFixture };
