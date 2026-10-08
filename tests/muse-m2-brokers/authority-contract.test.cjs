'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../muse-m2-permissions/fixture.cjs');

const code = expected => error => error.code === expected;
function pinCompleteSource(f) {
  const binding = f.db.prepare('SELECT snapshot_json FROM m2_run_scopes WHERE run_id=?').get(f.context.runId);
  const snapshot = JSON.parse(binding.snapshot_json);
  snapshot.resources = [{ id: 'resource-fixture', goalId: 'goal-fixture', dataScopeId: 'scope-fixture',
    kind: 'public_url', url: 'https://example.invalid/doc', contentHash: 'fixture-resource-hash', sizeBytes: 0, revision: 1 }];
  f.db.prepare('UPDATE m2_run_scopes SET snapshot_json=? WHERE run_id=?').run(JSON.stringify(snapshot), f.context.runId);
}
function addSnapshot(f) {
  f.db.prepare("INSERT INTO m2_resources(id,goal_id,data_scope_id,kind,content_hash,size_bytes,revision,parent_id,created_at) VALUES('derived-copy','goal-fixture','scope-fixture','public_snapshot','copy-hash',1,1,'resource-fixture',?)")
    .run(new Date(f.now()).toISOString());
  return { ...f.action, capability: 'file.read_public', resourceRef: 'derived-copy', resourceVersion: '1:copy-hash' };
}
function addAnchor(f) {
  f.db.prepare("INSERT INTO m2_resources(id,goal_id,data_scope_id,kind,content_hash,size_bytes,revision,created_at) VALUES('output-anchor','goal-fixture','scope-fixture','artifact','anchor-hash',0,1,?)")
    .run(new Date(f.now()).toISOString());
  const snapshot = JSON.parse(f.db.prepare('SELECT snapshot_json FROM m2_run_scopes WHERE run_id=?').get(f.context.runId).snapshot_json);
  snapshot.resources.push({ id: 'output-anchor', goalId: 'goal-fixture', dataScopeId: 'scope-fixture', kind: 'artifact', contentHash: 'anchor-hash', sizeBytes: 0, revision: 1 });
  f.db.prepare('UPDATE m2_run_scopes SET snapshot_json=? WHERE run_id=?').run(JSON.stringify(snapshot), f.context.runId);
  return { ...f.action, capability: 'artifact.publish', resourceRef: 'output-anchor', resourceVersion: '1:anchor-hash' };
}

test('independent authority contract: new cards cannot widen a frozen run source version', async t => {
  const f = await fixture(t); pinCompleteSource(f);
  f.db.prepare("UPDATE m2_resources SET content_hash='replacement-hash',revision=2 WHERE id='resource-fixture'").run();
  assert.throws(() => f.authority.previewAction(f.context, { ...f.action, resourceVersion: '2:replacement-hash' }, 1), code('RESOURCE_CHANGED'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_approval_previews').get().n, 0);
});

test('independent authority contract: a derived read is fenced by its pinned public parent version', async t => {
  const f = await fixture(t); pinCompleteSource(f); const action = addSnapshot(f);
  f.db.prepare("UPDATE m2_resources SET content_hash='replacement-hash',revision=2 WHERE id='resource-fixture'").run();
  assert.throws(() => f.authority.previewAction(f.context, action, 1), code('RESOURCE_CHANGED'));
});

test('independent authority contract: publication requires the exact payload hash on its virtual anchor', async t => {
  const f = await fixture(t); pinCompleteSource(f); const action = addAnchor(f);
  assert.throws(() => f.authority.previewAction(f.context, action, 1), code('INVALID_REQUEST'));
  const preview = f.authority.previewAction(f.context, { ...action, payloadHash: 'a'.repeat(64) }, 1);
  assert.equal(preview.action.payloadHash, 'a'.repeat(64));
});

test('independent authority contract: policy persistence failure aborts work and retains deny admission', async t => {
  const f = await fixture(t); pinCompleteSource(f); f.authorize('run');
  const prepared = f.authority.prepare(f.context, f.action);
  f.db.exec("CREATE TRIGGER refuse_policy BEFORE UPDATE ON m2_permission_policy BEGIN SELECT RAISE(ABORT,'synthetic policy failure'); END");
  assert.throws(() => f.authority.updatePolicy(1, { deniedCapabilities: ['fetch.public'], deniedLegacyTools: [] }), code('PERSISTENCE_FAILED'));
  assert.equal(prepared.signal.aborted, true);
  assert.throws(() => f.authority.markStarted(prepared.leaseId, f.context), code('POLICY_BLOCKED'));
  assert.throws(() => f.authority.previewAction(f.context, f.action, 1), code('POLICY_BLOCKED'));
  assert.equal(f.db.prepare('SELECT state FROM fixture_reservations').get().state, 'reserved');
});

test('independent authority contract: run approval has its disclosed deadline beyond pending-card TTL', async t => {
  const f = await fixture(t); pinCompleteSource(f);
  const card = f.preview();
  assert.equal(Date.parse(card.expiresAt) - f.now(), 120000);
  assert.equal(Date.parse(card.authorizationExpiresAt) - f.now(), 900000);
  const receipt = f.authority.decideApproval(card.id, 1, 'run', 1);
  assert.equal(f.db.prepare('SELECT expires_at FROM m2_grants WHERE id=?').get(receipt.grantId).expires_at, card.authorizationExpiresAt);
  f.advance(120001);
  const prepared = f.authority.prepare(f.context, f.action);
  assert.equal(prepared.expiresAt, card.authorizationExpiresAt);
  f.advance(780000);
  assert.throws(() => f.authority.markStarted(prepared.leaseId, f.context), code('APPROVAL_EXPIRED'));
});

test('independent authority contract: a lease deadline aborts its signal without another database admission call', async t => {
  const f = await fixture(t); pinCompleteSource(f);
  f.db.prepare('UPDATE m2_run_scopes SET deadline_at=? WHERE run_id=?').run(new Date(f.now() + 20).toISOString(), f.context.runId);
  f.authorize('run');
  const prepared = f.authority.prepare(f.context, f.action);
  assert.equal(prepared.signal.aborted, false);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(prepared.signal.aborted, true);
  assert.equal(prepared.signal.reason.code, 'APPROVAL_EXPIRED');
  assert.equal(f.db.prepare('SELECT state FROM fixture_reservations').get().state, 'reserved');
});
