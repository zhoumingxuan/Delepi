'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixture.cjs');
const count = (f, table) => f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const rejectsCode = code => error => error.code === code;

test('a permission card binds caller, exact resource, destination, policy and run identity', async t => {
  const f = await fixture(t), card = f.preview();
  assert.equal(JSON.stringify(card).includes('opaque-secret-hash'), false);
  assert.throws(() => f.authority.decideApproval(card.id, 1, 'once', 2), rejectsCode('UNTRUSTED_CALLER'));
  f.db.prepare("UPDATE m2_resources SET content_hash='changed',revision=revision+1 WHERE id='resource-fixture'").run();
  assert.throws(() => f.authority.decideApproval(card.id, 1, 'once', 1), rejectsCode('RESOURCE_CHANGED'));
  assert.equal(count(f, 'm2_grants'), 0);
  assert.throws(() => f.authority.previewAction({ ...f.context, ownerId: 'foreign' }, f.action, 1), rejectsCode('STALE_TASK_ATTEMPT'));
});

test('once grant consumption, real budget reservation, journal and activity are one transaction', async t => {
  const f = await fixture(t), receipt = f.authorize();
  const outcomes = await Promise.allSettled([Promise.resolve().then(() => f.authority.prepare(f.context, f.action)), Promise.resolve().then(() => f.authority.prepare(f.context, f.action))]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(value => value.status === 'rejected')[0].reason.code, 'AUTHORIZATION_REQUIRED');
  assert.equal(count(f, 'fixture_reservations'), 1); assert.equal(count(f, 'm2_operations'), 1); assert.equal(count(f, 'm2_leases'), 1);
  assert.equal(f.db.prepare('SELECT state FROM m2_grants WHERE id=?').get(receipt.grantId).state, 'consumed');
  const operation = outcomes.find(value => value.status === 'fulfilled').value;
  f.authority.markStarted(operation.leaseId, f.context);
  f.authority.settle(operation.leaseId, f.context, 'completed', { known: f.action.units });
  assert.equal(f.db.prepare('SELECT state FROM m2_operations').get().state, 'settled');
  assert.equal(f.db.prepare('SELECT state FROM fixture_reservations').get().state, 'completed');
});

for (const target of ['budget', 'operation', 'activity']) {
  test(`a ${target} durable failure rolls back grant consumption and every prepare side record`, async t => {
    const f = await fixture(t), receipt = f.authorize(), before = count(f, 'activity_events');
    const table = target === 'budget' ? 'fixture_reservations' : target === 'operation' ? 'm2_operations' : 'activity_events';
    f.db.exec(`CREATE TRIGGER refuse_prepare BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic prepare failure'); END`);
    assert.throws(() => f.authority.prepare(f.context, f.action), /synthetic prepare failure/);
    assert.equal(f.db.prepare('SELECT state FROM m2_grants WHERE id=?').get(receipt.grantId).state, 'active');
    assert.equal(count(f, 'fixture_reservations'), 0); assert.equal(count(f, 'm2_operations'), 0); assert.equal(count(f, 'm2_leases'), 0); assert.equal(count(f, 'activity_events'), before);
  });
}

test('without a real ledger or with invalid action capabilities no executable lease is issued', async t => {
  const f = await fixture(t, { budget: undefined }); f.authorize();
  assert.throws(() => f.authority.prepare(f.context, f.action), rejectsCode('BUDGET_NOT_READY'));
  for (const capability of ['shell', 'python', 'dynamicTools', 'app.install', 'skill.promote']) assert.throws(() => f.authority.previewAction(f.context, { ...f.action, capability }, 1), rejectsCode('MODE_BLOCKED'));
  assert.equal(count(f, 'm2_operations'), 0);
});

test('run grants cannot silently authorize a new payload, resource version or destination', async t => {
  const f = await fixture(t); f.authorize('run');
  f.authority.prepare(f.context, f.action); f.authority.prepare(f.context, f.action);
  assert.equal(count(f, 'm2_operations'), 2);
  assert.throws(() => f.authority.prepare(f.context, { ...f.action, payloadHash: 'a'.repeat(64) }), rejectsCode('AUTHORIZATION_REQUIRED'));
  assert.throws(() => f.authority.prepare(f.context, { ...f.action, destinationRef: 'foreign-model' }), rejectsCode('DESTINATION_CHANGED'));
  f.db.prepare("UPDATE m2_resources SET revision=2 WHERE id='resource-fixture'").run();
  assert.throws(() => f.authority.prepare(f.context, f.action), rejectsCode('RESOURCE_CHANGED'));
});

test('independent rule preview can issue only unchanged public resources and never exposes credential hashes', async t => {
  const f = await fixture(t);
  const preview = f.authority.previewRule({ goalId: 'goal-fixture', expectedGoalRevision: 1, capabilities: ['fetch.public'], resourceRefs: ['resource-fixture'], expiresAt: new Date(f.now() + 600000).toISOString(), resumeAfterRestart: true }, 1);
  assert.equal(JSON.stringify(preview).includes('opaque-secret-hash'), false);
  assert.throws(() => f.authority.issueRule(preview.id, 1, 2), rejectsCode('UNTRUSTED_CALLER'));
  const rule = f.authority.issueRule(preview.id, 1, 1);
  assert.equal(rule.state, 'active'); assert.equal(rule.resumeAfterRestart, true);
  assert.throws(() => f.authority.issueRule(preview.id, 1, 1), rejectsCode('REVISION_CONFLICT'));
  f.authority.prepare(f.context, f.action);
  const reconciled = f.authority.reconcileInterrupted(); assert.equal(reconciled.operations, 1);
  assert.equal(f.authority.listRules()[0].state, 'suspended');
  assert.throws(() => f.authority.prepare(f.context, f.action), rejectsCode('AUTHORIZATION_REQUIRED'));
});

test('revoke aborts only its owned branch and prepared work cannot start afterwards', async t => {
  const f = await fixture(t), first = f.authorize('run');
  const own = f.authority.prepare(f.context, f.action);
  const otherAction = { ...f.action, summary: 'Another explicit action' }, card = f.authority.previewAction(f.context, otherAction, 1);
  f.authority.decideApproval(card.id, 1, 'run', 1); const other = f.authority.prepare(f.context, otherAction);
  f.authority.revokeGrant(first.grantId, 1);
  assert.equal(own.signal.aborted, true); assert.equal(other.signal.aborted, false);
  assert.throws(() => f.authority.markStarted(own.leaseId, f.context), rejectsCode('AUTHORIZATION_REVOKED'));
  f.authority.markStarted(other.leaseId, f.context);
});

test('failed revoke closes admission immediately and restart expires the persisted temporary grant', async t => {
  const f = await fixture(t), receipt = f.authorize('run'), operation = f.authority.prepare(f.context, f.action);
  f.db.exec("CREATE TRIGGER fail_revoke BEFORE UPDATE ON m2_grants BEGIN SELECT RAISE(ABORT,'synthetic revoke failure'); END");
  assert.throws(() => f.authority.revokeGrant(receipt.grantId, 1), rejectsCode('PERSISTENCE_FAILED'));
  assert.equal(operation.signal.aborted, true);
  assert.throws(() => f.authority.prepare(f.context, f.action), rejectsCode('AUTHORIZATION_REQUIRED'));
  f.db.exec('DROP TRIGGER fail_revoke'); const replacement = f.api.createPermissionAuthority(f.db, f.deps);
  replacement.reconcileInterrupted();
  assert.throws(() => replacement.prepare(f.context, f.action), rejectsCode('AUTHORIZATION_REQUIRED'));
});

test('waiting approval is one branch and cancellation releases it without awaiting other cards', async t => {
  const f = await fixture(t), first = f.preview(), second = f.authority.previewAction(f.context, { ...f.action, summary: 'Distinct branch action' }, 1), controller = new AbortController();
  const firstWait = f.authority.waitForDecision(first.id, controller.signal);
  const secondWait = f.authority.waitForDecision(second.id);
  controller.abort(); await assert.rejects(firstWait, rejectsCode('CANCELLED'));
  f.authority.decideApproval(second.id, 1, 'once', 1);
  assert.equal((await secondWait).state, 'approved');
});

test('expired approval, cancelled generation and changed policy do not produce a grant', async t => {
  const f = await fixture(t), card = f.preview(); f.advance(120001);
  assert.throws(() => f.authority.decideApproval(card.id, 1, 'once', 1), rejectsCode('APPROVAL_EXPIRED'));
  const next = f.preview(); f.authority.updatePolicy(1, { deniedCapabilities: ['fetch.public'], deniedLegacyTools: [] });
  assert.throws(() => f.authority.decideApproval(next.id, 1, 'once', 1), rejectsCode('POLICY_BLOCKED'));
  assert.equal(count(f, 'm2_grants'), 0);
  f.taskService.requestStop(f.context);
  assert.throws(() => f.preview(), rejectsCode('STALE_TASK_ATTEMPT'));
});

test('result persistence failure retains unknown outcome and blocks lease reuse without refunding once', async t => {
  const f = await fixture(t), receipt = f.authorize(), operation = f.authority.prepare(f.context, f.action);
  f.authority.markStarted(operation.leaseId, f.context);
  f.db.exec("CREATE TRIGGER fail_usage BEFORE UPDATE ON fixture_reservations BEGIN SELECT RAISE(ABORT,'synthetic usage failure'); END");
  assert.throws(() => f.authority.settle(operation.leaseId, f.context, 'completed', { known: f.action.units }), /synthetic usage failure/);
  assert.equal(f.db.prepare('SELECT state FROM m2_operations').get().state, 'outcome_unknown');
  assert.equal(f.db.prepare('SELECT state FROM fixture_reservations').get().state, 'reserved');
  assert.equal(f.db.prepare('SELECT state FROM m2_grants WHERE id=?').get(receipt.grantId).state, 'consumed');
  assert.throws(() => f.authority.markStarted(operation.leaseId, f.context), rejectsCode('AUTHORIZATION_REVOKED'));
});

test('duplicate cards reuse one pending approval and rejected actions do not prompt in a loop', async t => {
  const f = await fixture(t), first = f.preview(), duplicate = f.preview();
  assert.equal(first.id, duplicate.id); assert.equal(count(f, 'm2_approval_previews'), 1);
  f.authority.decideApproval(first.id, 1, 'reject', 1);
  assert.throws(() => f.preview(), rejectsCode('APPROVAL_REJECTED'));
});

test('once approvals belong to their original attempt while unrelated sibling branches stay eligible', async t => {
  const f = await fixture(t); f.authorize();
  const sibling = f.taskService.beginAttempt(f.context, { taskId: 'sibling-task', delegateCallId: 'sibling-call' });
  assert.throws(() => f.authority.prepare(sibling, f.action), rejectsCode('AUTHORIZATION_REQUIRED'));
  f.authority.prepare(f.context, f.action);
  const card = f.authority.previewAction(sibling, f.action, 1); f.authority.decideApproval(card.id, 1, 'once', 1);
  f.authority.prepare(sibling, f.action); assert.equal(count(f, 'm2_operations'), 2);
});

test('registered resources outside a run snapshot or allowed-use scope remain inaccessible', async t => {
  const f = await fixture(t);
  f.db.prepare("INSERT INTO m2_resources(id,goal_id,data_scope_id,kind,url,content_hash,size_bytes,revision,created_at) VALUES('outside-source','goal-fixture','scope-fixture','public_url','https://example.invalid/other','other-hash',0,1,?)").run(new Date(f.now()).toISOString());
  assert.throws(() => f.authority.previewAction(f.context, { ...f.action, resourceRef: 'outside-source', resourceVersion: '1:other-hash' }, 1), rejectsCode('SCOPE_BLOCKED'));
  f.db.prepare("UPDATE m2_data_scopes SET allowed_uses_json='[]' WHERE id='scope-fixture'").run();
  assert.throws(() => f.preview(), rejectsCode('SCOPE_BLOCKED'));
});

test('a run file-read grant permits only snapshots from its visibly approved pinned public source', async t => {
  const f = await fixture(t);
  const insert = (id, parent) => f.db.prepare("INSERT INTO m2_resources(id,goal_id,data_scope_id,kind,content_hash,size_bytes,revision,parent_id,created_at) VALUES(?,'goal-fixture','scope-fixture','public_snapshot',?,1,1,?,?)").run(id, id + '-hash', parent, new Date(f.now()).toISOString());
  insert('snapshot-a', 'resource-fixture'); insert('snapshot-b', 'resource-fixture');
  const action = { ...f.action, capability: 'file.read_public', resourceRef: 'snapshot-a', resourceVersion: '1:snapshot-a-hash' };
  const card = f.authority.previewAction(f.context, action, 1); assert.ok(card.resourceLabel.includes('https://example.invalid/doc'));
  f.authority.decideApproval(card.id, 1, 'run', 1);
  f.authority.prepare(f.context, { ...action, resourceRef: 'snapshot-b', resourceVersion: '1:snapshot-b-hash' });
  insert('snapshot-foreign', 'unregistered-parent');
  assert.throws(() => f.authority.prepare(f.context, { ...action, resourceRef: 'snapshot-foreign', resourceVersion: '1:snapshot-foreign-hash' }), rejectsCode('RESOURCE_NOT_FOUND'));
});

test('live destination revalidation closes a lease even when the configuration list was not opened', async t => {
  const f = await fixture(t); f.authorize('run'); const operation = f.authority.prepare(f.context, f.action);
  f.deps.resolveDestination = () => { f.db.prepare("UPDATE m2_model_destinations SET revision=2,config_hash='changed-config' WHERE id='model-fixture'").run(); return { revision: 2, configHash: 'changed-config' }; };
  const rebuilt = f.api.createPermissionAuthority(f.db, f.deps);
  assert.throws(() => rebuilt.previewAction(f.context, f.action, 1), rejectsCode('DESTINATION_CHANGED'));
  f.authority.cancelGoalOperations('goal-fixture'); assert.equal(operation.signal.aborted, true); rebuilt.dispose();
});

test('expired approval waits end and a prepared lease cannot pass its absolute run deadline', async t => {
  const f = await fixture(t), card = f.preview(), waiting = f.authority.waitForDecision(card.id);
  f.advance(120001); f.authority.updatePolicy(1, { deniedCapabilities: [], deniedLegacyTools: [] });
  await assert.rejects(waiting, rejectsCode('APPROVAL_EXPIRED'));
  f.authorize(); const operation = f.authority.prepare(f.context, f.action);
  f.advance(900001);
  assert.throws(() => f.authority.markStarted(operation.leaseId, f.context), rejectsCode('APPROVAL_EXPIRED'));
});

test('settlement rejects forged complete task identities but permits owned stopping and terminal outcomes', async t => {
  const f = await fixture(t); f.authorize('run'); const operation = f.authority.prepare(f.context, f.action);
  f.authority.markStarted(operation.leaseId, f.context);
  for (const patch of [{ taskId: 'forged-task' }, { conversationId: 'forged-conversation' }, { parentAttemptId: 'forged-parent' }, { delegateCallId: 'forged-delegate' }]) {
    assert.throws(() => f.authority.settle(operation.leaseId, { ...f.context, ...patch }, 'completed'), rejectsCode('LEASE_INVALID'));
  }
  assert.equal(f.db.prepare('SELECT state FROM m2_operations').get().state, 'started');
  f.taskService.requestStop(f.context); f.authority.settle(operation.leaseId, f.context, 'cancelled');
  f.taskService.settleAttempt(f.context, 'cancelled');
  const fresh = f.taskService.beginRun('second-conversation');
  // Reuse synthetic scope fixture only to isolate settlement identity semantics.
  f.db.prepare("INSERT INTO m2_run_scopes SELECT ? ,goal_id,goal_revision,data_scope_id,destination_id,mode,owner_id,generation,snapshot_json,deadline_at,created_at FROM m2_run_scopes WHERE run_id=?").run(fresh.runId, f.context.runId);
  const card = f.authority.previewAction(fresh, f.action, 1); f.authority.decideApproval(card.id, 1, 'once', 1);
  const second = f.authority.prepare(fresh, f.action); f.authority.markStarted(second.leaseId, fresh);
  f.taskService.settleAttempt(fresh, 'completed'); f.authority.settle(second.leaseId, fresh, 'completed');
});

test('restart reconciliation fences a late settlement even when all old identity IDs match', async t => {
  const f = await fixture(t); f.authorize(); const operation = f.authority.prepare(f.context, f.action);
  f.authority.markStarted(operation.leaseId, f.context); f.taskService.reconcileInterrupted();
  assert.throws(() => f.authority.settle(operation.leaseId, f.context, 'completed'), rejectsCode('LEASE_INVALID'));
  assert.equal(f.db.prepare('SELECT state FROM m2_operations').get().state, 'started');
});

test('approval waiting expires separately from a visibly bounded run authorization', async t => {
  const f = await fixture(t), card = f.preview();
  assert.equal(Date.parse(card.expiresAt) - f.now(), 120000);
  assert.equal(Date.parse(card.authorizationExpiresAt) - f.now(), 900000);
  f.authority.decideApproval(card.id, 1, 'run', 1); f.advance(120001);
  const operation = f.authority.prepare(f.context, f.action);
  assert.equal(operation.expiresAt, card.authorizationExpiresAt);
  f.authority.markStarted(operation.leaseId, f.context);
  const onceCard = f.authority.previewAction(f.context, { ...f.action, summary: 'One distinct action' }, 1);
  const once = f.authority.decideApproval(onceCard.id, 1, 'once', 1);
  assert.equal(Date.parse(f.authority.listGrants().find(item => item.id === once.grantId).expiresAt) - f.now(), 120000);
});

test('legacy assistant request and OS request denies survive without overwriting existing settings', async t => {
  const f = await fixture(t), raw = { version: 1, assistantRequestsEnabled: false, os: { camera: { useEnabled: true, requestEnabled: false }, fullDiskAccess: { useEnabled: false, requestEnabled: false } } };
  f.db.prepare('INSERT INTO settings VALUES(?,?,?)').run('permissionPolicy', JSON.stringify(raw), new Date(f.now()).toISOString());
  assert.throws(() => f.preview(), rejectsCode('POLICY_BLOCKED'));
  assert.throws(() => f.authority.assertOsRequest('camera'), rejectsCode('POLICY_BLOCKED'));
  assert.throws(() => f.authority.assertOsRequest('fullDisk'), rejectsCode('POLICY_BLOCKED'));
  assert.doesNotThrow(() => f.authority.assertOsRequest('microphone'));
  const preview = f.authority.previewRule({ goalId: 'goal-fixture', expectedGoalRevision: 1, capabilities: ['fetch.public'], resourceRefs: ['resource-fixture'], expiresAt: new Date(f.now() + 600000).toISOString(), resumeAfterRestart: false }, 1);
  assert.equal(f.authority.issueRule(preview.id, 1, 1).state, 'active');
  assert.equal(f.authority.getPolicy().warnings.some(warning => warning.includes('助手申请权限')), true);
  assert.equal(f.authority.getPolicy().warnings.some(warning => warning.includes('系统权限申请')), true);
  assert.deepEqual(JSON.parse(f.db.prepare("SELECT value_json FROM settings WHERE key='permissionPolicy'").get().value_json), raw);
});

test('restart budget reconciliation is synchronous, observes unconfirmed operations, and rolls back on failure', async t => {
  const f = await fixture(t); f.authorize(); const operation = f.authority.prepare(f.context, f.action); f.authority.markStarted(operation.leaseId, f.context);
  f.deps.budget.reconcileInterruptedInTransaction = () => {
    assert.equal(f.db.inTransaction, true); assert.equal(f.db.prepare('SELECT state FROM m2_operations').get().state, 'started');
    f.db.prepare("UPDATE fixture_reservations SET state='unknown'").run(); throw new Error('synthetic reconcile write fault');
  };
  assert.throws(() => f.authority.reconcileInterrupted(), /synthetic reconcile write fault/);
  assert.equal(f.db.prepare('SELECT state FROM fixture_reservations').get().state, 'reserved');
  assert.equal(f.db.prepare('SELECT state FROM m2_operations').get().state, 'started');
  f.deps.budget.reconcileInterruptedInTransaction = () => {
    assert.equal(f.db.inTransaction, true); f.db.prepare("UPDATE fixture_reservations SET state='unknown'").run();
  };
  f.authority.reconcileInterrupted();
  assert.equal(f.db.prepare('SELECT state FROM fixture_reservations').get().state, 'unknown');
  assert.equal(f.db.prepare('SELECT state FROM m2_operations').get().state, 'outcome_unknown');
});

test('revoke read failure aborts its memory-owned branch while a sibling and stale CAS remain intact', async t => {
  let wakes = 0; const f = await fixture(t, { wake: () => wakes++ });
  const grant = f.authorize('run'), own = f.authority.prepare(f.context, f.action);
  const otherAction = { ...f.action, summary: 'Explicit separate branch' }, card = f.authority.previewAction(f.context, otherAction, 1);
  f.authority.decideApproval(card.id, 1, 'run', 1); const other = f.authority.prepare(f.context, otherAction);
  assert.throws(() => f.authority.revokeGrant(grant.grantId, 0), rejectsCode('REVISION_CONFLICT'));
  assert.equal(own.signal.aborted, false);
  const original = f.db.prepare.bind(f.db), beforeWakes = wakes;
  f.db.prepare = sql => { if (sql === 'SELECT * FROM m2_grants WHERE id=?') throw Error('synthetic read failure'); return original(sql); };
  assert.throws(() => f.authority.revokeGrant(grant.grantId, 1), rejectsCode('PERSISTENCE_FAILED'));
  assert.equal(own.signal.aborted, true); assert.equal(other.signal.aborted, false); assert.ok(wakes > beforeWakes);
  f.db.prepare = original;
  assert.throws(() => f.authority.prepare(f.context, f.action), rejectsCode('AUTHORIZATION_REQUIRED'));
});

test('run and goal cancellation use in-memory ownership when every database read fails', async t => {
  const f = await fixture(t); f.authorize('run'); const operation = f.authority.prepare(f.context, f.action);
  const original = f.db.prepare.bind(f.db); f.db.prepare = () => { throw Error('synthetic database unavailable'); };
  assert.doesNotThrow(() => f.authority.cancelRunOperations(f.context.runId)); assert.equal(operation.signal.aborted, true);
  assert.doesNotThrow(() => f.authority.cancelGoalOperations('goal-fixture'));
  f.db.prepare = original;
});

for (const query of ['SELECT * FROM m2_leases WHERE id=?', 'SELECT * FROM m2_operations WHERE id=?']) {
  test(`settlement read failure fences only the complete memory-owned lease at ${query}`, async t => {
    const f = await fixture(t); f.authorize('run');
    const own = f.authority.prepare(f.context, f.action), sibling = f.authority.prepare(f.context, f.action);
    f.authority.markStarted(own.leaseId, f.context); f.authority.markStarted(sibling.leaseId, f.context);
    const original = f.db.prepare.bind(f.db);
    f.db.prepare = sql => { if (sql === query) throw Error('synthetic settlement read failure'); return original(sql); };
    try {
      for (const forged of [
        { ...f.context, conversationId: 'foreign-conversation' }, { ...f.context, taskId: 'foreign-task' },
        { ...f.context, parentAttemptId: 'foreign-parent' }, { ...f.context, delegateCallId: 'foreign-delegate' },
      ]) {
        assert.throws(() => f.authority.settle(own.leaseId, forged, 'completed'), /synthetic settlement read failure|LEASE_INVALID/);
        assert.equal(own.signal.aborted, false);
      }
      assert.throws(() => f.authority.settle(own.leaseId, f.context, 'completed'), /synthetic settlement read failure/);
      assert.equal(own.signal.aborted, true); assert.equal(sibling.signal.aborted, false);
    } finally { f.db.prepare = original; }
    assert.equal(f.db.prepare('SELECT state FROM m2_operations WHERE id=?').get(own.operationId).state, 'outcome_unknown');
    assert.equal(f.db.prepare('SELECT state FROM fixture_reservations WHERE id=?').get(own.operationId).state, 'reserved');
    assert.throws(() => f.authority.assertLease(own.leaseId, f.context), rejectsCode('AUTHORIZATION_REVOKED'));
    assert.doesNotThrow(() => f.authority.assertLease(sibling.leaseId, f.context));
  });
}

test('unconfirmed settlement releases its native expiration timer and fences the lease without refunding usage', async t => {
  const f = await fixture(t); f.authorize();
  const nativeSetTimeout = global.setTimeout, nativeClearTimeout = global.clearTimeout;
  const timers = new Set();
  t.mock.method(global, 'setTimeout', (...args) => { const timer = nativeSetTimeout(...args); timers.add(timer); return timer; });
  t.mock.method(global, 'clearTimeout', timer => { timers.delete(timer); return nativeClearTimeout(timer); });
  const own = f.authority.prepare(f.context, f.action);
  assert.equal(timers.size, 1); f.authority.markStarted(own.leaseId, f.context);
  f.db.exec("CREATE TRIGGER fail_timer_settlement BEFORE UPDATE ON fixture_reservations BEGIN SELECT RAISE(ABORT,'synthetic settlement write failure'); END");
  assert.throws(() => f.authority.settle(own.leaseId, f.context, 'completed'), /synthetic settlement write failure/);
  assert.equal(own.signal.aborted, true); assert.equal(timers.size, 0);
  assert.equal(f.db.prepare('SELECT state FROM fixture_reservations WHERE id=?').get(own.operationId).state, 'reserved');
  assert.equal(f.db.prepare('SELECT state FROM m2_operations WHERE id=?').get(own.operationId).state, 'outcome_unknown');
});

test('complete database loss during settlement keeps its reservation and prevents a late lease reuse after recovery', async t => {
  const f = await fixture(t); const grant = f.authorize();
  const own = f.authority.prepare(f.context, f.action); f.authority.markStarted(own.leaseId, f.context);
  const original = f.db.prepare.bind(f.db); f.db.prepare = () => { throw Error('synthetic database lost during settlement'); };
  try {
    assert.throws(() => f.authority.settle(own.leaseId, f.context, 'completed'), /synthetic database lost during settlement/);
    assert.equal(own.signal.aborted, true);
  } finally { f.db.prepare = original; }
  assert.equal(f.db.prepare('SELECT state FROM m2_operations WHERE id=?').get(own.operationId).state, 'started');
  assert.equal(f.db.prepare('SELECT state FROM fixture_reservations WHERE id=?').get(own.operationId).state, 'reserved');
  assert.equal(f.db.prepare('SELECT state FROM m2_grants WHERE id=?').get(grant.grantId).state, 'consumed');
  assert.throws(() => f.authority.assertLease(own.leaseId, f.context), rejectsCode('AUTHORIZATION_REVOKED'));
  f.authority.reconcileInterrupted();
  assert.equal(f.db.prepare('SELECT state FROM m2_operations WHERE id=?').get(own.operationId).state, 'outcome_unknown');
});

for (const change of ['policy', 'resource', 'destination', 'run-stop']) {
  test(`approval wait seals its pending card when ${change} changes before a subsequent pipeline abort`, async t => {
    const f = await fixture(t), card = f.preview(), controller = new AbortController();
    const waiting = f.authority.waitForDecision(card.id, controller.signal);
    if (change === 'policy') f.authority.updatePolicy(1, { deniedCapabilities: ['fetch.public'], deniedLegacyTools: [] });
    else {
      if (change === 'resource') f.db.prepare("UPDATE m2_resources SET revision=2,content_hash='changed' WHERE id='resource-fixture'").run();
      if (change === 'destination') f.db.prepare("UPDATE m2_model_destinations SET revision=2,config_hash='changed' WHERE id='model-fixture'").run();
      if (change === 'run-stop') f.taskService.requestStop(f.context);
      f.authority.cancelGoalOperations('goal-fixture');
    }
    await assert.rejects(waiting, error => ['POLICY_BLOCKED', 'RESOURCE_CHANGED', 'DESTINATION_CHANGED', 'STALE_TASK_ATTEMPT'].includes(error.code));
    const sealed = f.db.prepare('SELECT state,revision FROM m2_approval_previews WHERE id=?').get(card.id);
    assert.equal(sealed.state, 'revoked'); assert.equal(f.authority.getApproval(card.id).state, 'revoked');
    controller.abort();
    assert.deepEqual(f.db.prepare('SELECT state,revision FROM m2_approval_previews WHERE id=?').get(card.id), sealed);
    assert.throws(() => f.authority.decideApproval(card.id, sealed.revision, 'once', 1), rejectsCode('APPROVAL_NOT_PENDING'));
  });
}

test('failed pending-card seal stays blocked and projects revoked while preserving its original rejection reason', async t => {
  const f = await fixture(t), card = f.preview(), waiting = f.authority.waitForDecision(card.id);
  f.db.exec("CREATE TRIGGER fail_pending_seal BEFORE UPDATE ON m2_approval_previews BEGIN SELECT RAISE(ABORT,'synthetic card seal failure'); END");
  f.db.prepare("UPDATE m2_resources SET revision=2,content_hash='changed' WHERE id='resource-fixture'").run();
  f.authority.cancelGoalOperations('goal-fixture');
  await assert.rejects(waiting, rejectsCode('RESOURCE_CHANGED'));
  assert.equal(f.db.prepare('SELECT state FROM m2_approval_previews WHERE id=?').get(card.id).state, 'pending');
  assert.equal(f.authority.getApproval(card.id).state, 'revoked');
  f.db.exec('DROP TRIGGER fail_pending_seal');
  assert.throws(() => f.authority.decideApproval(card.id, 1, 'once', 1), rejectsCode('APPROVAL_NOT_PENDING'));
});
