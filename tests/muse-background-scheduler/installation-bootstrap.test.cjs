'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('../muse-m2-exploration/fixture.cjs');
const { loadSource } = require('../muse-m2-brokers/fixture.cjs');
let bundled;
async function setup(t) {
  const f = await fixture(t);
  bundled ??= Promise.all(['src/main/modules/background/scheduler.ts','src/main/modules/background/installation-bootstrap.ts','src/main/db/migrations/background-schema.ts'].map(loadSource)).then(parts => Object.assign({}, ...parts));
  const api = await bundled; f.db.exec(api.BACKGROUND_SCHEMA_SQL);
  const scheduler = api.createBackgroundScheduler(f.db, { goals: f.goals, authority: f.authority, exploration: f.exploration, taskService: f.tasks, foregroundBusy: () => false });
  scheduler.reconcileInterrupted(); t.after(() => scheduler.dispose());
  const directory = path.join(f.root, 'muse'); fs.mkdirSync(directory);
  const requestPath = path.join(directory,'background-enablement-request.json'), now = Date.now();
  const request = { schemaVersion: 1, requestId: 'trusted-install-fixture', preset: 'excel-data-quality-v1', createdAt: new Date(now).toISOString(), expiresAt: new Date(now+7*86400000).toISOString(), protocol: 'chat-completions' };
  const runtime = { goals: f.goals, scheduler, now: () => now };
  const write = (value = request) => fs.writeFileSync(requestPath, JSON.stringify(value), {mode:0o600});
  const consume = (port = runtime) => api.consumeBackgroundEnablementRequest(f.db, port, f.root);
  return { ...f, api, scheduler, directory, requestPath, request, runtime, write, consume };
}

test('installation request atomically creates bounded Excel public goal+rule+learning without changing chats/config/attachments', async t => {
  const f = await setup(t);
  f.db.exec("CREATE TABLE fixture_chats(id TEXT PRIMARY KEY,body TEXT NOT NULL); INSERT INTO fixture_chats VALUES('old-chat','private old chat'); INSERT INTO settings VALUES('custom-config','{\"retain\":true}','old-date');");
  const attachment = path.join(f.root,'old-attachment.txt'); fs.writeFileSync(attachment,'retain synthetic attachment');
  const oldConfig = JSON.stringify(f.settings), beforeChats = f.db.prepare('SELECT * FROM fixture_chats').all(), beforeSettings = f.db.prepare('SELECT * FROM settings').all();
  f.write(); const receipt = await f.consume();
  assert.equal(receipt.replayed, false); assert.equal(receipt.cleanupPending, undefined); assert.equal(fs.existsSync(f.requestPath), false);
  const {goal} = f.goals.get(receipt.goalId), schedule = f.scheduler.list()[0];
  assert.deepEqual(goal.sourceUrls, f.api.BACKGROUND_EXCEL_SOURCES); assert.equal(goal.limits.maxDocumentBytes,1048576);
  assert.equal(goal.limits.modelRequests,1); assert.equal(goal.limits.fetchRequests,3); assert.match(goal.expectedOutput,/900/);
  assert.equal(schedule.intervalMinutes,30); assert.equal(schedule.dailyRoundLimit,3); assert.equal(schedule.learningEnabled,true); assert.equal(schedule.autoPromote,true);
  const uses = JSON.parse(f.db.prepare('SELECT allowed_uses_json FROM m2_data_scopes WHERE goal_id=?').get(receipt.goalId).allowed_uses_json);
  assert.ok(uses.includes('learning.capture') && uses.includes('skill.context'));
  const rule = f.authority.listRules(receipt.goalId)[0]; assert.equal(rule.resumeAfterRestart,true); assert.equal(rule.capabilities.length,4);
  const receiptPath = path.join(f.directory,`background-enablement-receipt-${f.request.requestId}.json`), report = fs.readFileSync(receiptPath,'utf8');
  assert.equal(fs.statSync(receiptPath).mode & 0o777,0o600); assert.equal(report.includes('synthetic-key'),false);
  assert.deepEqual(f.db.prepare('SELECT * FROM fixture_chats').all(),beforeChats); assert.deepEqual(f.db.prepare('SELECT * FROM settings').all(),beforeSettings);
  assert.equal(JSON.stringify(f.settings),oldConfig); assert.equal(fs.readFileSync(attachment,'utf8'),'retain synthetic attachment'); assert.equal(f.server.requests.length,0);
});

test('same request after user pause replays receipt without creating goal or reenabling schedule', async t => {
  const f = await setup(t); f.write(); const first = await f.consume(); let schedule = f.scheduler.list()[0];
  schedule = await f.scheduler.setEnabled(schedule.id,schedule.revision,false); const revision = schedule.revision;
  f.write(); const second = await f.consume();
  assert.equal(second.replayed,true); assert.equal(second.goalId,first.goalId); assert.equal(second.scheduleId,first.scheduleId);
  assert.equal(f.scheduler.list()[0].state,'paused'); assert.equal(f.scheduler.list()[0].revision,revision);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_goals').get().n,2); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM muse_background_enablement_receipts').get().n,1);
});

test('schedule initialization or receipt failure rolls back every created goal/scope/rule while retaining request', async t => {
  for (const mode of ['configure','receipt']) await t.test(mode,async t => {
    const f = await setup(t); f.write();
    const counts = () => Object.fromEntries(['m2_goals','m2_data_scopes','m2_resources','m2_rule_previews','m2_standing_rules','muse_background_schedules','muse_background_enablement_receipts'].map(table=>[table,f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
    const before = counts();
    if (mode==='receipt') f.db.exec("CREATE TRIGGER fail_bootstrap_receipt BEFORE INSERT ON muse_background_enablement_receipts BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;");
    const port = mode==='configure' ? {...f.runtime,scheduler:{configure(...args){f.scheduler.configure(...args);throw Error('synthetic configuration failure');}}} : f.runtime;
    await assert.rejects(()=>f.consume(port),/synthetic (configuration|receipt) failure/);
    assert.deepEqual(counts(),before); assert.equal(fs.existsSync(f.requestPath),true);
  });
});

test('missing model refuses request and preserves it for later setup without changing configuration', async t => {
  const f = await setup(t); f.write(); f.settings.mainModelApiKey=''; const config = JSON.stringify(f.settings);
  await assert.rejects(()=>f.consume(),/DESTINATION_UNAVAILABLE/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_goals').get().n,1); assert.equal(f.scheduler.list().length,0); assert.equal(fs.existsSync(f.requestPath),true);
  assert.equal(JSON.stringify(f.settings),config);
});

test('strict input rejects symlinks, oversized JSON, expanded URL scope, wrong preset, invalid date and protocols', async t => {
  for (const mode of ['symlink','oversized','extra-url','preset','future','expiry','protocol']) await t.test(mode,async t => {
    const f = await setup(t); let input = {...f.request};
    if (mode==='symlink') { const other=path.join(f.root,'other.json'); fs.writeFileSync(other,JSON.stringify(input)); fs.symlinkSync(other,f.requestPath); }
    else if (mode==='oversized') fs.writeFileSync(f.requestPath,' '.repeat(5000));
    else { if(mode==='extra-url')input.sourceUrls=['https://expanded.example.com/']; if(mode==='preset')input.preset='learn-everything'; if(mode==='future')input.createdAt=new Date(Date.parse(input.createdAt)+3600000).toISOString(); if(mode==='expiry')input.expiresAt=new Date(Date.parse(input.createdAt)+8*86400000).toISOString(); if(mode==='protocol')input.protocol='automatic'; f.write(input); }
    await assert.rejects(()=>f.consume(),/BACKGROUND_REQUEST_(INVALID|EXPIRED)/); assert.equal(f.scheduler.list().length,0); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_goals').get().n,1);
  });
});

test('receipt filesystem failure keeps atomic applied state and retries cleanup without overriding subsequent pause', async t => {
  const f = await setup(t); f.write(); const reportPath=path.join(f.directory,`background-enablement-receipt-${f.request.requestId}.json`); fs.mkdirSync(reportPath);
  const first = await f.consume(); assert.equal(first.cleanupPending,true); assert.equal(fs.existsSync(f.requestPath),true);
  let schedule=f.scheduler.list()[0]; await f.scheduler.setEnabled(schedule.id,schedule.revision,false);
  fs.rmdirSync(reportPath); const retry=await f.consume();
  assert.equal(retry.replayed,true); assert.equal(retry.cleanupPending,undefined); assert.equal(f.scheduler.list()[0].state,'paused'); assert.equal(fs.existsSync(f.requestPath),false);
});

test('changed contents under an already consumed requestId conflict and preserve user pause', async t => {
  const f=await setup(t); f.write(); await f.consume(); const schedule=f.scheduler.list()[0]; await f.scheduler.setEnabled(schedule.id,schedule.revision,false);
  f.write({...f.request,protocol:'responses'}); await assert.rejects(()=>f.consume(),/BACKGROUND_REQUEST_CONFLICT/);
  assert.equal(f.scheduler.list()[0].state,'paused'); assert.equal(fs.existsSync(f.requestPath),true);
});

test('no request is a no-op and valid Responses choice is recorded without making provider calls', async t => {
  const f=await setup(t); assert.equal(await f.consume(),null); f.write({...f.request,protocol:'responses'});
  const receipt=await f.consume(); assert.equal(receipt.protocol,'responses'); assert.equal(f.scheduler.list()[0].protocol,'responses'); assert.equal(f.server.requests.length,0);
});
