'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { loadSource, databaseFixture } = require('../muse-m2-brokers/fixture.cjs');
async function fixture(t) {
  const source = await Promise.all([
    'src/main/db/migrations/runtime-schema.ts', 'src/main/db/migrations/autonomy-schema.ts',
    'src/main/db/migrations/public-inbox-schema.ts', 'src/main/modules/tasks/task-service.ts',
    'src/main/modules/goals/goal-service.ts', 'src/main/modules/exploration/public-inbox.ts',
  ].map(entry => loadSource(entry)));
  const { db, root } = databaseFixture(t, source[0].RUNTIME_SCHEMA_SQL + source[1].AUTONOMY_SCHEMA_SQL + source[2].PUBLIC_INBOX_SCHEMA_SQL);
  let id = 0, allowed = true, safe = true; const uuid = () => `inbox-${++id}`;
  const tasks = source[3].createTaskService(db, { ownerId: 'public-inbox-owner', uuid });
  const settings = { mainModelBaseUrl: 'https://model.example.com/v1', mainModelName: 'synthetic-model', mainModelApiKey: 'synthetic-key-never-sent' };
  const goals = source[4].createGoalService(db, { taskService: tasks, uuid, config: { getSettings: () => settings } });
  const destination = goals.listDestinations()[0];
  const draft = { title: 'Public topic', topic: 'Public scope only', sourceUrls: ['https://example.com/doc'], destinationId: destination.id,
    expectedOutput: 'Summary', stopConditions: 'One pass', limits: source[4].DEFAULT_EXPLORATION_LIMITS };
  const goal = goals.create(draft), context = tasks.beginRun('public-synthetic-conversation'); goals.bindRun(context, goal.id, goal.revision);
  const inbox = source[5].createPublicInbox(db, { taskService: tasks, goalService: goals, canAppend: () => allowed, isAtSafePoint: () => safe });
  return { db, root, tasks, goals, goal, context, inbox, settings, draft, destination,
    append: (messageId, text = 'public text', explicitlyPublic = true) => inbox.append(context, { messageId, text, explicitlyPublic }, goal.revision),
    claim: () => inbox.claim(context, goal.revision, destination.id),
    setAllowed: value => { allowed = value; }, setSafe: value => { safe = value; } };
}
const code = expected => error => error.code === expected;

test('public inbox classifies append atomically and claims frozen public additions in M1 FIFO order once', async t => {
  const f = await fixture(t);
  assert.equal(f.append('m:2', 'second identifier arrives first').accepted, true); assert.equal(f.append('m:1', 'first identifier arrives second').accepted, true);
  const rows = f.db.prepare('SELECT * FROM m2_public_inbox ORDER BY message_id').all();
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.classification === 'public' && row.goal_revision === f.goal.revision && row.destination_revision === f.destination.revision));
  assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.destination_config_hash) && /^[a-f0-9]{64}$/.test(row.content_hash)));
  const additions = f.claim(); assert.deepEqual(additions.map(a => a.id), ['m:2', 'm:1']); assert.deepEqual(f.claim(), []);
  assert.equal(additions.every(Object.isFrozen), true); assert.equal(f.inbox.verifyAddition(additions[0], f.context, f.destination.id), true);
  assert.equal(f.inbox.verifyAddition({ ...additions[0], text: 'private replacement' }, f.context, f.destination.id), false);
  assert.equal(JSON.stringify(rows).includes(f.settings.mainModelApiKey), false);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM run_inbox WHERE state='injected'").get().n, 2);
});

test('public inbox requires explicit public confirmation, UTF-8 limits and model-start gate', async t => {
  const f = await fixture(t);
  assert.equal(f.append('private', 'private text', false).reason, 'public-confirmation-required');
  assert.equal(f.append('large', '汉'.repeat(1366)).reason, 'too-long'); assert.equal(f.append('ascii', 'x'.repeat(4001)).reason, 'too-long');
  assert.equal(f.append('empty', '').reason, 'empty-or-invalid'); assert.equal(f.append('nul', 'x\0y').reason, 'empty-or-invalid');
  f.setAllowed(false); assert.equal(f.append('late').reason, 'summary-already-started');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM run_inbox').get().n, 0); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_public_inbox').get().n, 0);
});

test('public inbox duplicate receipt does not enqueue twice or elevate an unclassified M1 message', async t => {
  const f = await fixture(t); f.append('same', 'public duplicate'); f.claim(); f.setAllowed(false);
  const receipt = f.append('same', 'public duplicate'); assert.equal(receipt.accepted, true); assert.equal(receipt.duplicate, true);
  assert.equal(f.append('same', 'other text').reason, 'message-id-conflict');
  f.tasks.acceptMessage(f.context, 'unclassified', 'private historical data');
  assert.equal(f.append('unclassified', 'private historical data').reason, 'message-id-conflict');
  assert.deepEqual(f.claim(), []); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_public_inbox').get().n, 1);
});

test('public inbox never claims unlabeled messages or reads another conversation private history', async t => {
  const f = await fixture(t); f.tasks.acceptMessage(f.context, 'unclassified', 'SECRET unlabeled old message');
  const privateContext = f.tasks.beginRun('private-synthetic-conversation'); f.tasks.acceptMessage(privateContext, 'legacy', 'SECRET private history');
  f.append('confirmed', 'Public confirmed'); const additions = f.claim(); assert.deepEqual(additions.map(a => a.text), ['Public confirmed']);
  assert.equal(JSON.stringify(additions).includes('SECRET'), false);
  assert.equal(f.db.prepare("SELECT state FROM run_inbox WHERE message_id='unclassified'").get().state, 'accepted');
  assert.throws(() => f.inbox.append(privateContext, { messageId: 'attempt', text: 'not a public run', explicitlyPublic: true }, f.goal.revision), /PUBLIC_SCOPE_MISMATCH/);
});

test('public classification failure rolls back M1 queue, audit and classification together', async t => {
  const f = await fixture(t), before = f.db.prepare('SELECT COUNT(*) n FROM activity_events').get().n;
  f.db.exec("CREATE TRIGGER refuse_public BEFORE INSERT ON m2_public_inbox BEGIN SELECT RAISE(ABORT,'synthetic scope write failure'); END");
  assert.throws(() => f.append('rollback'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM run_inbox').get().n, 0); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_public_inbox').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM activity_events').get().n, before);
});

test('public claim write failure returns no text, keeps pending FIFO and permits a clean retry', async t => {
  const f = await fixture(t); f.append('a', 'one'); f.append('b', 'two');
  f.db.exec("CREATE TRIGGER refuse_claim BEFORE UPDATE ON run_inbox WHEN NEW.state='injected' AND NEW.message_id='b' BEGIN SELECT RAISE(ABORT,'synthetic claim failure'); END");
  assert.throws(() => f.claim()); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM run_inbox WHERE state='accepted'").get().n, 2);
  f.db.exec('DROP TRIGGER refuse_claim'); assert.deepEqual(f.claim().map(a => a.text), ['one', 'two']);
});

test('public inbox live Goal, scope, destination and owner changes invalidate admission and minted additions', async t => {
  const f = await fixture(t); f.append('one'); const [addition] = f.claim();
  assert.equal(f.inbox.verifyAddition(addition, { ...f.context, conversationId: 'forged' }, f.destination.id), false);
  assert.throws(() => f.inbox.claim({ ...f.context, taskId: 'forged' }, f.goal.revision, f.destination.id), code('STALE_TASK_ATTEMPT'));
  assert.throws(() => f.inbox.claim(f.context, f.goal.revision, 'other-destination'), code('PUBLIC_INBOX_SCOPE_MISMATCH'));
  f.settings.mainModelApiKey = 'changed-synthetic-key';
  assert.equal(f.inbox.verifyAddition(addition, f.context, f.destination.id), false); assert.throws(() => f.append('next'), code('DESTINATION_CHANGED'));
});

test('public inbox rejects missing migrated metadata and hash tampering without injecting text', async t => {
  const f = await fixture(t); f.append('a');
  f.db.prepare("UPDATE m2_public_inbox SET destination_revision=NULL WHERE message_id='a'").run();
  assert.throws(() => f.claim(), code('PUBLIC_INBOX_CLASSIFICATION_CHANGED')); assert.equal(f.db.prepare('SELECT state FROM run_inbox').get().state, 'accepted');
  f.db.prepare("UPDATE m2_public_inbox SET destination_revision=? WHERE message_id='a'").run(f.destination.revision);
  f.db.prepare("UPDATE run_inbox SET text='tampered data' WHERE message_id='a'").run();
  assert.throws(() => f.claim(), code('PUBLIC_INBOX_CLASSIFICATION_CHANGED'));
});

test('public inbox requires safe point and invalidates all additions after cancellation or process restart', async t => {
  const f = await fixture(t); f.append('a'); f.setSafe(false); assert.throws(() => f.claim(), code('PUBLIC_INBOX_NOT_AT_SAFE_POINT'));
  f.setSafe(true); const [addition] = f.claim(); f.tasks.requestStop(f.context, 'run');
  assert.equal(f.inbox.verifyAddition(addition, f.context, f.destination.id), false); assert.throws(() => f.append('late'), code('STALE_TASK_ATTEMPT'));
  f.tasks.reconcileInterrupted(); assert.equal(f.inbox.verifyAddition(addition, f.context, f.destination.id), false);
  assert.equal(f.db.prepare('SELECT state FROM run_inbox').get().state, 'injected');
});

test('public inbox M1 queue limit remains ten and child attempts cannot append to root model scope', async t => {
  const f = await fixture(t); for (let n = 0; n < 10; n++) assert.equal(f.append(`m-${n}`).accepted, true);
  assert.equal(f.append('overflow').reason, 'queue-full');
  const child = f.tasks.beginAttempt(f.context, { taskId: 'child-read', delegateCallId: 'synthetic-delegate' });
  assert.throws(() => f.inbox.append(child, { messageId: 'child', text: 'child input', explicitlyPublic: true }, f.goal.revision), code('PUBLIC_INBOX_ROOT_REQUIRED'));
  assert.equal(f.claim().length, 10);
});

test('public inbox never renews the run absolute deadline at append or safe-point claim', async t => {
  const f = await fixture(t); f.append('on-time');
  f.db.prepare('UPDATE m2_run_scopes SET deadline_at=? WHERE run_id=?').run(new Date(Date.now() - 1).toISOString(), f.context.runId);
  assert.throws(() => f.append('expired'), code('PUBLIC_INBOX_DEADLINE_EXPIRED')); assert.throws(() => f.claim(), code('PUBLIC_INBOX_DEADLINE_EXPIRED'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM run_inbox').get().n, 1); assert.equal(f.db.prepare('SELECT state FROM run_inbox').get().state, 'accepted');
});
