'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSource, deferred, sha } = require('./fixture.cjs');
const { runtimeFixture } = require('./runtime-fixture.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const context = { taskId: 'task-fixture', runId: 'run-fixture', attemptId: 'attempt-fixture', ownerId: 'owner-fixture', generation: 1 };
function action(resourceRef) { return { capability: 'fetch.public', resourceRef, resourceVersion: '1:fixture', summary: 'Synthetic source', units: { modelRequests: 0, fetchRequests: 1, downloadBytes: 1, storageBytes: 1, tokenUnits: 0 } }; }
async function fixture(t, limit = 2) {
  const [sessions, clocks, semaphores] = await Promise.all(['src/main/modules/brokers/session.ts', 'src/main/modules/budget/run-clock.ts', 'src/main/modules/brokers/concurrency.ts'].map(loadSource));
  const clock = clocks.createRunClock({ activeMilliseconds: 1000, deadlineAt: new Date(Date.now() + 5000).toISOString() });
  const concurrency = semaphores.createBrokerConcurrency(limit), controller = new AbortController(), pending = new Map(), authorized = new Set(['already-approved']);
  const authority = {
    prepare(_context, value) { if (!authorized.has(value.resourceRef)) throw Object.assign(Error('AUTHORIZATION_REQUIRED'), { code: 'AUTHORIZATION_REQUIRED' }); return { operationId: value.resourceRef, leaseId: value.resourceRef, signal: controller.signal }; },
    previewAction(_context, value) { return { id: value.resourceRef }; },
    waitForDecision(id, signal) {
      const wait = deferred(); pending.set(id, wait);
      if (signal.aborted) wait.reject(Error('CANCELLED')); else signal.addEventListener('abort', () => wait.reject(Error('CANCELLED')), { once: true });
      return wait.promise.then(() => { authorized.add(id); return { state: 'approved' }; });
    },
    assertLease: id => ({ operationId: id, leaseId: id, signal: controller.signal }), markStarted() {}, settle() {},
  };
  const created = [];
  const session = branchId => { const result = sessions.createBrokerSession({ context, authority, clock, concurrency, signal: controller.signal, callerId: 1, branchId }); created.push(result); return result; };
  t.after(() => { controller.abort(); for (const session of created) session.close(); clock.dispose(); });
  return { clock, concurrency, controller, pending, session };
}
test('pending user approvals relinquish slots so a separately authorized branch can execute', async t => {
  const f = await fixture(t), first = f.session('waiting-1'), second = f.session('waiting-2'), third = f.session('approved-3');
  const runs = [(async () => { await first.prepare(action('waiting-source-1')); return first.withSlot(async () => {}); })(), (async () => { await second.prepare(action('waiting-source-2')); return second.withSlot(async () => {}); })()];
  await tick(); await tick(); assert.equal(f.pending.size, 2);
  let executed = false; runs.push((async () => { await third.prepare(action('already-approved')); return third.withSlot(async () => { executed = true; }); })());
  await tick(); await tick();
  const facts = { executed, activeSlots: f.concurrency.active, waitingSlots: f.concurrency.waiting, branches: f.clock.snapshot().branches };
  f.controller.abort(); await Promise.allSettled(runs);
  assert.equal(facts.executed, true, JSON.stringify(facts));
});
test('only all user-waiting branches pause the real shared clock, and resumption cannot revive an aborted run', async t => {
  const f = await fixture(t), first = f.session('waiting-1'), second = f.session('waiting-2');
  const runs = [first.prepare(action('waiting-source-1')), second.prepare(action('waiting-source-2'))];
  await tick(); await tick(); const before = f.clock.snapshot().activeUsedMilliseconds;
  await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(f.clock.snapshot().activeUsedMilliseconds, before);
  assert.deepEqual(f.clock.snapshot().branches, { active: 0, waitingUser: 2, settled: 0 });
  f.controller.abort(); f.pending.get('waiting-source-1').resolve(); f.pending.get('waiting-source-2').resolve();
  await Promise.allSettled(runs); assert.equal(f.concurrency.active, 0); assert.equal(f.concurrency.waiting, 0); assert.equal(f.clock.snapshot().branches.active, 0);
});
test('session close aborts its pending approval and settles the branch without requiring run-wide cancellation', async t => {
  const f = await fixture(t), session = f.session('closing-branch');
  const run = session.prepare(action('closing-source')); run.catch(() => {});
  await tick(); await tick(); session.close(); await tick();
  const aborted = session.signal.aborted;
  f.controller.abort(); await Promise.allSettled([run]);
  assert.equal(aborted, true, 'A closed session must stop its own pending wait/I/O'); assert.equal(f.clock.snapshot().branches.settled, 1);
});
test('cancellation during a semaphore handoff releases the acquired slot and cannot dispatch a late operation', async t => {
  const f = await fixture(t, 1), session = f.session('handoff');
  const release = await f.concurrency.acquire(new AbortController().signal); let executed = false;
  const run = session.withSlot(async () => { executed = true; }); await tick(); assert.equal(f.concurrency.waiting, 1);
  release(); f.controller.abort(); await assert.rejects(run, /CANCELLED/);
  assert.equal(executed, false); assert.equal(f.concurrency.active, 0); assert.equal(f.concurrency.waiting, 0);
});
test('prepare inside an I/O slot is rejected before creating a user approval or consuming a grant', async t => {
  const f = await fixture(t), session = f.session('invalid-slot-prepare');
  await assert.rejects(session.withSlot(async () => session.prepare(action('waiting-source'))), /BROKER_PREPARE_IN_SLOT/);
  assert.equal(f.pending.size, 0); assert.equal(f.concurrency.active, 0); assert.equal(f.concurrency.waiting, 0);
});
test('real Fetch/Authority/Ledger/filesystem composition lets an approved source finish while two other branches await approval', async t => {
  const f = await runtimeFixture(t), deadline = new Date(f.now() + 900000).toISOString();
  for (let index = 1; index <= 2; index++) {
    const id = `waiting-source-${index}`, url = `https://source.fixture.test/waiting-${index}`, contentHash = sha(url);
    f.db.prepare("INSERT INTO m2_resources(id,goal_id,data_scope_id,kind,url,content_hash,size_bytes,revision,created_at) VALUES(?,'goal-fixture','scope-fixture','public_url',?,?,0,1,?)").run(id, url, contentHash, new Date(f.now()).toISOString());
    f.snapshot.resources.push({ id, goalId: 'goal-fixture', dataScopeId: 'scope-fixture', kind: 'public_url', url, contentHash, sizeBytes: 0, revision: 1 });
  }
  f.db.prepare('UPDATE m2_run_scopes SET snapshot_json=? WHERE run_id=?').run(JSON.stringify(f.snapshot), f.context.runId);
  const ruleCard = f.authority.previewRule({ goalId: 'goal-fixture', expectedGoalRevision: 1, capabilities: ['fetch.public'], resourceRefs: ['resource-fixture'], expiresAt: deadline, resumeAfterRestart: false }, 1);
  f.authority.issueRule(ruleCard.id, 1, 1);
  const waitingSessions = [1, 2].map(index => f.api.createBrokerSession({ context: f.context, authority: f.authority, clock: f.clock, concurrency: f.concurrency, signal: f.controller.signal, callerId: 1, branchId: `waiting-branch-${index}` }));
  t.after(() => waitingSessions.forEach(session => session.close()));
  let ioCount = 0;
  const fetch = f.api.createFetchBroker(f.db, { transport: { async request(options) { ioCount++; options.beforeStart(); options.beforeConnect(); return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Synthetic public bytes'), receivedBytes: 22 }; } }, registerSnapshot: (...args) => f.file.registerSnapshot(...args) });
  const waiting = waitingSessions.map((session, index) => fetch.fetch(session, `waiting-source-${index + 1}`)); waiting.forEach(promise => promise.catch(() => {}));
  await tick(); await tick(); assert.equal(f.authority.listApprovals().filter(card => card.state === 'pending').length, 2); assert.equal(ioCount, 0); assert.equal(f.concurrency.active, 0);
  const result = await fetch.fetch(f.session, 'resource-fixture'); assert.equal(result.resource.kind, 'public_snapshot'); assert.equal(ioCount, 1);
  assert.equal(f.authority.listApprovals().filter(card => card.state === 'pending').length, 2);
  assert.equal(f.ledger.listAccounts(f.context).find(account => account.scope === 'run').used.fetchRequests, 1);
  f.controller.abort(); await Promise.allSettled(waiting); assert.equal(f.concurrency.active, 0); assert.equal(f.concurrency.waiting, 0);
});
