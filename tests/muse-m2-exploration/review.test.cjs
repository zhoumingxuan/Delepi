'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { fixture, until } = require('./fixture.cjs');
const { loadSource, deferred } = require('../muse-m2-brokers/fixture.cjs');
const code = expected => error => error.code === expected;
async function completeFixture(t, extras = {}) {
  const f = await fixture(t, extras);
  if (!f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts'").get()) {
    f.db.exec((await loadSource('src/main/modules/artifacts/artifact-schema.ts')).ARTIFACT_SCHEMA_SQL);
  }
  return f;
}

test('independent D review: SQL rollback after clock creation disposes its actual timer/controller and performs no I/O', async t => {
  const { createRunClock } = await loadSource('src/main/modules/budget/run-clock.ts');
  let created = 0, disposed = 0, clock;
  const f = await fixture(t, { service: { createClock(options) {
    created++; clock = createRunClock(options); const original = clock.dispose.bind(clock);
    clock.dispose = () => { disposed++; original(); }; return clock;
  } } });
  const plan = f.plan();
  f.db.exec("CREATE TRIGGER refuse_start BEFORE INSERT ON m2_exploration_sessions BEGIN SELECT RAISE(ABORT,'independent start fault'); END");
  assert.throws(() => f.start(plan), /independent start fault/);
  assert.equal(created, 1); assert.equal(disposed, 1); assert.equal(clock.snapshot().state, 'disposed'); assert.equal(clock.signal.aborted, true);
  assert.equal(f.server.requests.length, 0); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM runs').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_run_scopes').get().n, 0); assert.equal(f.exploration.listExplorations().length, 0);
});

test('independent D review: final exploration receipt failure preserves actual artifact bytes and provenance with outcome_unknown', async t => {
  const f = await completeFixture(t), plan = f.plan();
  f.db.exec("CREATE TRIGGER refuse_final_receipt BEFORE UPDATE ON m2_exploration_sessions WHEN NEW.settled_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'independent final receipt fault'); END");
  const started = f.start(plan), stopApprove = f.approveAll(); t.after(stopApprove);
  await f.exploration.waitForRun(started.runId); stopApprove();
  const result = f.exploration.listExplorations()[0];
  assert.equal(result.state, 'outcome_unknown'); assert.equal(result.stopReason, 'PERSISTENCE_FAILED'); assert.equal(result.settledAt, undefined);
  assert.equal(f.server.requests.length, 2);
  const artifact = f.db.prepare('SELECT * FROM artifacts').get();
  assert.ok(artifact); assert.equal(artifact.save_state, 'saved'); assert.equal(artifact.validation_state, 'pending'); assert.equal(artifact.acceptance_state, 'unreviewed');
  assert.equal(fs.existsSync(artifact.path), true); assert.equal(fs.readFileSync(artifact.path, 'utf8').includes('Synthetic CC research report.'), true);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_artifact_scopes WHERE artifact_id=?').get(artifact.id).n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_public_write_journal WHERE state='registered'").get().n, 2);
  assert.equal(f.tasks.getRun(started.runId).state, 'running');
  await assert.rejects(f.exploration.stopExploration(started.runId), code('PERSISTENCE_FAILED'));
});

test('independent D review: actual model body receives public FIFO once and rejects late or unclassified additions', async t => {
  const entered = deferred(), finish = deferred(); let sentBody;
  const f = await completeFixture(t, { routes: {
    '/public': (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Public source'); },
    '/v1/chat/completions': async (_req, res, receipt) => {
      sentBody = receipt.body; entered.resolve(); await finish.promise;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'Independent report' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    },
  } });
  const started = f.start(f.plan());
  await until(() => f.authority.listApprovals().some(card => card.state === 'pending'));
  assert.equal(f.exploration.appendPublicMessage(started.runId, 'public-b', 'PUBLIC_FIRST', true, 1).accepted, true);
  assert.equal(f.exploration.appendPublicMessage(started.runId, 'public-a', 'PUBLIC_SECOND', true, 1).accepted, true);
  const context = f.tasks.getTrustedContext(f.tasks.getRun(started.runId).rootAttemptId);
  f.tasks.acceptMessage(context, 'unclassified-private', 'PRIVATE_NOT_CONFIRMED');
  const stopApprove = f.approveAll(); t.after(stopApprove);
  await entered.promise;
  assert.equal(sentBody.includes('PUBLIC_FIRST'), true); assert.equal(sentBody.includes('PUBLIC_SECOND'), true);
  assert.ok(sentBody.indexOf('PUBLIC_FIRST') < sentBody.indexOf('PUBLIC_SECOND')); assert.equal(sentBody.includes('PRIVATE_NOT_CONFIRMED'), false);
  const late = f.exploration.appendPublicMessage(started.runId, 'late', 'LATE_NOT_IN_CURRENT_REQUEST', true, 1);
  assert.equal(late.accepted, false); assert.equal(late.reason, 'summarization_started');
  const duplicate = f.exploration.appendPublicMessage(started.runId, 'public-b', 'PUBLIC_FIRST', true, 1);
  assert.equal(duplicate.accepted, true); assert.equal(duplicate.duplicate, true);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM run_inbox WHERE state='injected'").get().n, 2);
  assert.equal(f.db.prepare("SELECT state FROM run_inbox WHERE message_id='unclassified-private'").get().state, 'accepted');
  finish.resolve(); await f.exploration.waitForRun(started.runId); stopApprove();
  assert.equal(f.exploration.listExplorations()[0].state, 'completed');
});

test('independent D review: a real absolute timer aborts an approval wait and settles without any request', async t => {
  const { createRunClock } = await loadSource('src/main/modules/budget/run-clock.ts');
  let clock;
  const f = await fixture(t, { service: { createClock(options) {
    clock = createRunClock({ ...options, deadlineAt: new Date(Date.now() + 120).toISOString() }); return clock;
  } } });
  const started = f.start(f.plan());
  await until(() => f.authority.listApprovals().some(card => card.state === 'pending'));
  const before = clock.snapshot(); assert.equal(before.branches.active, 0); assert.equal(before.branches.waitingUser, 1);
  await new Promise(resolve => setTimeout(resolve, 25));
  const after = clock.snapshot(); assert.equal(after.activeUsedMilliseconds, before.activeUsedMilliseconds);
  assert.ok(after.absoluteRemainingMilliseconds < before.absoluteRemainingMilliseconds);
  await f.exploration.waitForRun(started.runId);
  const result = f.exploration.listExplorations()[0];
  assert.equal(result.state, 'stopped'); assert.equal(result.stopReason, 'ABSOLUTE_DEADLINE_EXCEEDED');
  assert.equal(f.server.requests.length, 0); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_operations').get().n, 0);
});

test('independent D review: stopping one public Goal leaves a sibling Goal able to complete its report', async t => {
  const f = await completeFixture(t);
  const trusted = f.tasks.beginRun('private-trusted-professional-run'); f.tasks.acceptMessage(trusted, 'private-pending', 'Keep trusted private inbox');
  const trustedRunBefore = f.tasks.getRun(trusted.runId), trustedInboxBefore = f.tasks.listInbox({ runId: trusted.runId });
  const first = f.start(f.plan());
  const secondGoal = f.goals.create({ ...f.draft, title: 'Independent sibling topic' });
  const secondPlan = f.exploration.planExploration(secondGoal.id, secondGoal.revision, 'chat-completions', 1);
  const second = f.exploration.startExploration(secondPlan.id, secondPlan.revision, 1);
  await until(() => f.authority.listApprovals().filter(card => card.state === 'pending').length === 2);
  await f.exploration.stopExploration(first.runId);
  assert.equal(f.authority.listApprovals().some(card => card.runId === first.runId && card.state === 'pending'), false);
  assert.deepEqual(f.tasks.getRun(trusted.runId), trustedRunBefore); assert.deepEqual(f.tasks.listInbox({ runId: trusted.runId }), trustedInboxBefore);
  const timer = setInterval(() => {
    for (const card of f.authority.listApprovals()) if (card.runId === second.runId && card.state === 'pending') {
      f.authority.decideApproval(card.id, card.revision, 'run', 1);
    }
  }, 2);
  t.after(() => clearInterval(timer));
  await f.exploration.waitForRun(second.runId); clearInterval(timer);
  const results = f.exploration.listExplorations();
  assert.equal(results.find(row => row.runId === first.runId).state, 'stopped');
  assert.equal(results.find(row => row.runId === second.runId).state, 'completed');
  assert.equal(f.server.requests.length, 2); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM artifacts').get().n, 1);
  assert.deepEqual(f.tasks.getRun(trusted.runId), trustedRunBefore); assert.deepEqual(f.tasks.listInbox({ runId: trusted.runId }), trustedInboxBefore);
});
