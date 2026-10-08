'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, until } = require('../muse-m2-exploration/fixture.cjs');
const { loadSource } = require('../muse-m2-brokers/fixture.cjs');
let schedulerApi;
async function setup(t, extras = {}) {
  const f = await fixture(t, extras);
  schedulerApi ??= Promise.all(['src/main/modules/background/scheduler.ts', 'src/main/db/migrations/background-schema.ts'].map(loadSource)).then(values => Object.assign({}, ...values));
  const api = await schedulerApi; f.db.exec(api.BACKGROUND_SCHEMA_SQL);
  let instant = Date.now(), busy = false, n = 0;
  const captures = [];
  const deps = { goals: f.goals, authority: f.authority, exploration: f.exploration, taskService: f.tasks,
    now: () => instant, uuid: () => `background-fixture-${++n}`, foregroundBusy: () => busy,
    learning: { captureCompletedRun(runId, options) { captures.push({ runId, ...options }); } } };
  const scheduler = api.createBackgroundScheduler(f.db, deps);
  scheduler.reconcileInterrupted();
  t.after(() => scheduler.dispose());
  const options = { intervalMinutes: 30, dailyRoundLimit: 3, expiresAt: new Date(instant + 7 * 86400000).toISOString(),
    protocol: 'chat-completions', learningEnabled: true, autoPromote: true };
  return { ...f, api, scheduler, deps, options, captures,
    configure: () => scheduler.configure(f.goal.id, f.goal.revision, options, 1),
    advance: ms => { instant += ms; }, busy: value => { busy = value; }, now: () => instant,
    terminal: () => until(() => { const schedule = scheduler.list()[0]; return schedule && schedule.lastOutcome && schedule.lastOutcome !== 'running' && schedule; }, 5000) };
}

test('one persistent trigger binds real TaskService/Run, performs TLS pass without cards, and captures once', async t => {
  const f = await setup(t); const schedule = f.configure();
  await Promise.all([f.scheduler.tick(), f.scheduler.tick(), f.scheduler.tick()]);
  const result = await f.terminal();
  assert.equal(result.lastOutcome, 'completed'); assert.equal(result.roundsToday, 1);
  assert.equal(f.authority.listApprovals().length, 0);
  assert.equal(f.captures.length, 1); assert.equal(f.captures[0].autoPromote, true);
  assert.equal(f.server.requests.length, 2);
  const trigger = f.db.prepare('SELECT * FROM muse_background_triggers').get();
  const run = f.db.prepare('SELECT * FROM runs WHERE id=?').get(result.lastRunId);
  assert.equal(trigger.run_id, run.id); assert.equal(trigger.owner_id, f.tasks.ownerId);
  assert.equal(run.state, 'completed');
  await f.scheduler.runNow(result.id, result.revision);
  assert.equal(f.server.requests.length, 2); assert.equal(f.scheduler.list()[0].roundsToday, 1);
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT allowed_uses_json FROM m2_data_scopes').get().allowed_uses_json).filter(value => value.startsWith('learning.') || value.startsWith('skill.')), ['learning.capture', 'skill.context']);
  assert.equal(schedule.ruleId, f.authority.listRules()[0].id);
});

test('foreground wins, no backlog catchup, daily admission limit survives scheduler restart', async t => {
  const f = await setup(t); f.configure(); f.busy(true);
  await f.scheduler.tick(); assert.equal(f.server.requests.length, 0);
  f.advance(4 * 3600000); f.busy(false);
  await f.scheduler.tick(); let result = await f.terminal();
  assert.equal(result.roundsToday, 1); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM muse_background_triggers').get().n, 1);
  for (let i = 0; i < 2; i++) { f.advance(31 * 60000); await f.scheduler.tick(); result = await f.terminal(); }
  assert.equal(result.roundsToday, 3); assert.equal(f.server.requests.length, 6);
  await f.scheduler.dispose();
  f.authority.reconcileInterrupted();
  const resumed = f.api.createBackgroundScheduler(f.db, f.deps); t.after(() => resumed.dispose());
  resumed.reconcileInterrupted(); f.advance(31 * 60000); await resumed.tick();
  assert.equal(resumed.list()[0].roundsToday, 3); assert.equal(f.server.requests.length, 6);
  assert.equal(f.authority.listRules()[0].state, 'active');
});

test('generic resumeAfterRestart rule suspends; only unchanged schedule-linked exact rule survives', async t => {
  const f = await setup(t); const schedule = f.configure();
  const resource = f.goals.get(f.goal.id).resources.find(value => value.kind === 'public_url');
  const preview = f.authority.previewRule({ goalId: f.goal.id, expectedGoalRevision: f.goal.revision,
    capabilities: ['fetch.public'], resourceRefs: [resource.id], expiresAt: f.options.expiresAt, resumeAfterRestart: true }, 1);
  const unrelated = f.authority.issueRule(preview.id, preview.revision, 1);
  f.authority.reconcileInterrupted();
  const rules = f.authority.listRules();
  assert.equal(rules.find(rule => rule.id === schedule.ruleId).state, 'active');
  assert.equal(rules.find(rule => rule.id === unrelated.id).state, 'suspended');
  f.db.prepare('UPDATE m2_resources SET revision=revision+1 WHERE id=?').run(resource.id);
  f.authority.reconcileInterrupted(); assert.equal(f.authority.listRules().find(rule => rule.id === schedule.ruleId).state, 'suspended');
  f.scheduler.reconcileInterrupted(); assert.equal(f.scheduler.list()[0].state, 'blocked');
});

test('pause cancels a real pending socket, removes learning consent, and unchanged explicit resume works', async t => {
  const f = await setup(t, { routes: { '/public': (_req, res) => { res.writeHead(200, {'content-type':'text/plain'}); res.write('pending'); } } });
  f.configure(); await f.scheduler.tick();
  await until(() => f.server.requests.length === 1);
  let schedule = f.scheduler.list()[0];
  schedule = await f.scheduler.setEnabled(schedule.id, schedule.revision, false);
  assert.equal(schedule.state, 'paused');
  assert.equal(schedule.lastOutcome, 'stopped');
  await until(() => f.server.connections.every(connection => connection.closed));
  assert.equal(f.authority.listRules()[0].state, 'suspended');
  assert.equal(JSON.parse(f.db.prepare('SELECT allowed_uses_json FROM m2_data_scopes').get().allowed_uses_json).includes('skill.context'), false);
  schedule = await f.scheduler.setEnabled(schedule.id, schedule.revision, true);
  assert.equal(schedule.state, 'enabled'); assert.equal(f.authority.listRules()[0].state, 'active');
  await f.scheduler.tick(); assert.equal(f.server.requests.length, 1);
});

test('expiry, Goal and policy change block future triggers; no silent reauthorization', async t => {
  for (const mode of ['expiry', 'goal', 'policy']) await t.test(mode, async t => {
    const f = await setup(t); const initial = f.configure();
    if (mode === 'expiry') f.advance(8 * 86400000);
    else if (mode === 'goal') f.goals.update(f.goal.id, f.goal.revision, { ...f.draft, topic: 'changed' });
    else { const policy = f.authority.getPolicy(); f.authority.updatePolicy(policy.revision, { deniedCapabilities: ['fetch.public'], deniedLegacyTools: [] }); }
    await f.scheduler.tick(); const current = f.scheduler.list()[0];
    assert.equal(f.server.requests.length, 0); assert.ok(['expired', 'blocked'].includes(current.state));
    assert.ok(current.reasonCode); assert.notEqual(current.revision, initial.revision);
    await assert.rejects(() => f.scheduler.setEnabled(current.id, current.revision, true), /BACKGROUND_RECONFIGURE_REQUIRED/);
  });
});

test('unknown interrupted trigger is sealed and never replayed or refunded', async t => {
  const f = await setup(t); const schedule = f.configure();
  f.db.prepare("INSERT INTO muse_background_triggers VALUES('crash-trigger',?,'crash-slot','2030-01-01','old-owner','lost-run','running',NULL,?,NULL)").run(schedule.id, new Date(f.now()).toISOString());
  f.db.prepare('INSERT INTO muse_background_daily VALUES(?,?,1)').run(schedule.id, new Date(f.now()).toISOString().slice(0,10));
  f.db.prepare('UPDATE muse_background_schedules SET last_run_id=? WHERE id=?').run('lost-run', schedule.id);
  f.scheduler.reconcileInterrupted(); await f.scheduler.tick();
  assert.equal(f.scheduler.list()[0].state, 'blocked'); assert.equal(f.scheduler.list()[0].lastOutcome, 'outcome_unknown');
  assert.equal(f.scheduler.list()[0].roundsToday, 1); assert.equal(f.server.requests.length, 0);
  assert.equal(f.db.prepare('SELECT state FROM muse_background_triggers').get().state, 'outcome_unknown');
});

test('claim transaction write fault cancels already registered memory Run before TLS escape', async t => {
  const f = await setup(t); f.configure();
  f.db.exec("CREATE TRIGGER synthetic_claim_fault BEFORE INSERT ON muse_background_triggers BEGIN SELECT RAISE(ABORT,'synthetic claim receipt failure'); END;");
  await f.scheduler.tick();
  assert.equal(f.server.requests.length, 0); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM runs').get().n, 0);
  assert.equal(f.scheduler.list()[0].reasonCode, 'OUTCOME_UNKNOWN');
  assert.equal(f.scheduler.list()[0].state, 'blocked');
});

test('pause persistence failure still closes real TLS and memory-fences future admission', async t => {
  const f = await setup(t, { routes: { '/public': (_req, res) => { res.writeHead(200, {'content-type':'text/plain'}); res.write('pending'); } } });
  f.configure(); await f.scheduler.tick(); await until(() => f.server.requests.length === 1);
  const schedule = f.scheduler.list()[0];
  f.db.exec("CREATE TRIGGER synthetic_pause_fault BEFORE UPDATE ON muse_background_schedules BEGIN SELECT RAISE(ABORT,'synthetic pause persistence failure'); END;");
  await assert.rejects(() => f.scheduler.setEnabled(schedule.id, schedule.revision, false), /synthetic pause persistence failure/);
  await until(() => f.server.connections.every(connection => connection.closed));
  assert.equal(f.scheduler.list()[0].state, 'blocked');
  f.advance(31 * 60000); f.db.exec('DROP TRIGGER synthetic_pause_fault'); await f.scheduler.tick();
  assert.equal(f.server.requests.length, 1); assert.equal(f.scheduler.list()[0].reasonCode, 'PERSISTENCE_FAILED');
});

test('scheduler cannot admit before startup reconciliation and scoped ownership fencing', async t => {
  const f = await setup(t); f.configure(); await f.scheduler.dispose();
  const unready = f.api.createBackgroundScheduler(f.db, f.deps); t.after(() => unready.dispose());
  unready.start(); await unready.tick(); assert.equal(f.server.requests.length, 0);
  const schedule = unready.list()[0]; await assert.rejects(() => unready.runNow(schedule.id, schedule.revision), /STAGE_NOT_READY/);
  f.tasks.reconcileInterrupted(); f.authority.reconcileInterrupted(); f.exploration.reconcileInterrupted(); unready.reconcileInterrupted();
  await unready.tick(); await until(() => unready.list()[0].lastOutcome === 'completed');
  assert.equal(f.server.requests.length, 2);
});

test('foreground preempts a live socket and its claimed slot is not retried', async t => {
  const f = await setup(t, { routes: { '/public': (_req, res) => { res.writeHead(200, {'content-type':'text/plain'}); res.write('pending'); } } });
  f.configure(); await f.scheduler.tick(); await until(() => f.server.requests.length === 1);
  f.busy(true); await f.scheduler.tick(); await until(() => f.server.connections.every(connection => connection.closed));
  assert.equal(f.scheduler.list()[0].lastOutcome, 'stopped'); assert.equal(f.scheduler.list()[0].state, 'enabled');
  f.busy(false); await f.scheduler.tick(); assert.equal(f.server.requests.length, 1);
});

test('expiry of an owned run stops I/O and suspends its linked authorization and learning scope', async t => {
  const f = await setup(t, { routes: { '/public': (_req, res) => { res.writeHead(200, {'content-type':'text/plain'}); res.write('pending'); } } });
  f.configure(); await f.scheduler.tick(); await until(() => f.server.requests.length === 1);
  f.advance(8*86400000); await f.scheduler.tick(); await until(() => f.server.connections.every(connection => connection.closed));
  assert.equal(f.scheduler.list()[0].state, 'expired'); assert.equal(f.authority.listRules()[0].state, 'suspended');
  assert.equal(f.captures.length, 0);
  assert.equal(JSON.parse(f.db.prepare('SELECT allowed_uses_json FROM m2_data_scopes').get().allowed_uses_json).includes('learning.capture'), false);
});

test('UTC date counter changes by UTC boundary and reconfiguration retains prior daily usage', async t => {
  const f = await setup(t); const original = f.configure(); await f.scheduler.tick(); await f.terminal();
  const oldDay = new Date(f.now()).toISOString().slice(0,10);
  f.advance(Date.parse(`${oldDay}T00:00:00.000Z`) + 86400000 - f.now() + 1000);
  await f.scheduler.tick(); const result = await f.terminal();
  assert.equal(result.roundsToday, 1); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM muse_background_daily').get().n, 2);
  f.scheduler.configure(f.goal.id, f.goal.revision, { ...f.options, expiresAt: new Date(f.now()+7*86400000).toISOString() }, 1);
  assert.equal(f.scheduler.list()[0].roundsToday, 1); assert.equal(f.scheduler.list()[0].id, original.id);
});
