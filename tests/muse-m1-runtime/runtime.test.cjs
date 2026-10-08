'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {fixture}=require('./fixture.cjs');

test('real SQLite admission keeps one active run per conversation until all attempts settle',async t=>{
  const {service}=await fixture(t);const root=service.beginRun('C');const child=service.beginAttempt(root,{taskId:'T',delegateCallId:'D'});
  assert.ok(Object.isFrozen(root));assert.notEqual(root.attemptId,child.attemptId);
  assert.throws(()=>service.beginRun('C'),/UNIQUE/);
  service.requestStop(root,'run');assert.equal(service.getRun(root.runId).state,'stop_requested');
  service.settleAttempt(root,'cancelled');assert.equal(service.getRun(root.runId).state,'stop_requested');
  assert.throws(()=>service.beginRun('C'),/UNIQUE/);
  service.settleAttempt(child,'cancelled');assert.equal(service.getRun(root.runId).state,'cancelled');
  const next=service.beginRun('C');assert.notEqual(root.runId,next.runId);
  assert.equal(service.settleAttempt(root,'completed'),false);assert.equal(service.getRun(next.runId).state,'running');
});
test('startup atomically interrupts attempts, fences callbacks and never replays inbox',async t=>{
  const {service,api,db}=await fixture(t);const root=service.beginRun('C');const child=service.beginAttempt(root,{taskId:'T',delegateCallId:'D'});
  service.acceptMessage(child,'queued','synthetic queued');service.acceptMessage(child,'uncertain','synthetic uncertain');
  db.prepare("UPDATE run_inbox SET state='injecting' WHERE message_id='uncertain'").run();
  const restarted=api.createTaskService(db,{ownerId:'new-owner'});
  assert.deepEqual(restarted.reconcileInterrupted(),{runs:1,attempts:2});
  assert.equal(restarted.getRun(root.runId).state,'interrupted');assert.equal(restarted.getRun(root.runId).generation,2);
  assert.deepEqual(restarted.listInbox({runId:root.runId}).map(row=>row.state),['cancelled','delivery_unknown']);
  let pushes=0;assert.equal(service.injectNext(child,()=>pushes++),null);assert.equal(pushes,0);
  assert.equal(service.recordToolStarted(child,{callId:'late',toolName:'synthetic'}),false);
  assert.equal(service.settleAttempt(root,'completed'),false);
  assert.deepEqual(restarted.reconcileInterrupted(),{runs:0,attempts:0});
});
test('lost/throwing wake leaves committed immutable cursor pages readable without offset',async t=>{
  let wakes=0;const {service,db}=await fixture(t,{wake:()=>{wakes++;throw Error('lost wake');}});
  const root=service.beginRun('C');let first=service.listActivity({runId:root.runId,limit:1});
  assert.equal(first.events.length,1);assert.equal(first.hasMore,true);const bound=first.throughEventId;
  service.recordToolStarted(root,{callId:'tool',toolName:'synthetic'});
  const second=service.listActivity({runId:root.runId,afterEventId:first.nextAfterEventId,throughEventId:bound,limit:1});
  assert.equal(second.events[0].kind,'attempt.started');assert.equal(second.hasMore,false);assert.equal(second.throughEventId,bound);
  const tail=service.listActivity({runId:root.runId,afterEventId:bound});assert.equal(tail.events[0].kind,'tool.started');
  assert.ok(wakes>=2);assert.throws(()=>db.prepare('UPDATE activity_events SET kind=? WHERE event_id=?').run('fake',1),/immutable/);
  assert.throws(()=>db.prepare('DELETE FROM activity_events').run(),/immutable/);
  assert.throws(()=>service.recordToolStarted(root,{callId:'x',toolName:'x',text:'private'}),/Unsupported activity fact/);
  assert.equal(service.listActivity({}).events.length,3);
});
test('durable messageId is idempotent, preserves original text only in inbox, and rejects payload reuse',async t=>{
  const {service,db}=await fixture(t);const root=service.beginRun('C');const child=service.beginAttempt(root,{taskId:'T',delegateCallId:'D'});
  const text='synthetic \u0001 message';
  assert.equal(service.acceptMessage(child,'M',text).accepted,true);
  assert.equal(service.acceptMessage(child,'M',text).duplicate,true);
  assert.equal(service.acceptMessage(child,'M','different').reason,'message-id-conflict');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_inbox').get().n,1);
  const model=[];service.injectNext(child,(body,id)=>{assert.equal(db.prepare('SELECT state FROM run_inbox WHERE message_id=?').get(id).state,'injecting');model.push(body);});
  assert.deepEqual(model,[text]);assert.equal(service.listInbox({runId:root.runId})[0].state,'injected');
  assert.equal(service.injectNext(child,()=>assert.fail('duplicate injection')),null);
  assert.equal(service.acceptMessage(child,'M',text).inboxState,'injected');
  assert.ok(!Object.hasOwn(service.listInbox({runId:root.runId})[0],'text'));
  const all=JSON.stringify(service.listActivity({}).events);assert.ok(!all.includes(text));assert.ok(!all.includes('contentHash'));
});
test('failed injecting transaction does not push or publish wake',async t=>{
  let wakes=0;const {service,db}=await fixture(t,{wake:()=>wakes++});const root=service.beginRun('C');service.acceptMessage(root,'M','synthetic');
  const before=wakes;
  db.exec("CREATE TRIGGER fail_injection BEFORE UPDATE ON run_inbox WHEN NEW.state='injecting' BEGIN SELECT RAISE(ABORT,'synthetic transaction failure'); END;");
  assert.throws(()=>service.injectNext(root,()=>assert.fail('must not push')),/synthetic transaction failure/);
  assert.equal(service.listInbox({runId:root.runId})[0].state,'accepted');assert.equal(wakes,before);
});
test('confirmation failure after array push leaves delivery_unknown and cannot auto inject twice',async t=>{
  const {service,db}=await fixture(t);const root=service.beginRun('C');service.acceptMessage(root,'M','synthetic');
  db.exec("CREATE TRIGGER fail_confirmation BEFORE UPDATE ON run_inbox WHEN NEW.state='injected' BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;");
  const model=[];assert.throws(()=>service.injectNext(root,body=>model.push(body)),/synthetic receipt failure/);
  assert.deepEqual(model,['synthetic']);assert.equal(service.listInbox({runId:root.runId})[0].state,'delivery_unknown');
  assert.equal(service.injectNext(root,()=>assert.fail('unknown must never replay')),null);
});
test('stop cancels accepted messages, persists rejected late message and cannot claim real terminal',async t=>{
  const {service}=await fixture(t);const root=service.beginRun('C');service.acceptMessage(root,'M','synthetic');service.requestStop(root,'run');
  assert.equal(service.getRun(root.runId).state,'stop_requested');assert.equal(service.listAttempts(root.runId)[0].state,'stop_requested');
  assert.equal(service.listInbox({runId:root.runId})[0].state,'cancelled');
  const late=service.acceptMessage(root,'late','synthetic');assert.equal(late.accepted,false);assert.equal(late.inboxState,'rejected');
  assert.equal(late.reason,'stop-requested');service.settleAttempt(root,'cancelled');assert.equal(service.getRun(root.runId).state,'cancelled');
});
test('failed admission rolls back identity and activity, later real admission is valid',async t=>{
  let wakes=0;const {service,db}=await fixture(t,{wake:()=>wakes++});
  db.exec("CREATE TRIGGER fail_attempt BEFORE INSERT ON task_attempts BEGIN SELECT RAISE(ABORT,'synthetic attempt failure'); END;");
  assert.throws(()=>service.beginRun('C'),/synthetic attempt failure/);assert.equal(service.listRuns().length,0);assert.equal(service.listActivity().events.length,0);assert.equal(wakes,0);
  db.exec('DROP TRIGGER fail_attempt');assert.equal(service.beginRun('C').conversationId,'C');
});
test('settle storage failure retains running state instead of asserting completed',async t=>{
  const {service,db}=await fixture(t);const root=service.beginRun('C');
  db.exec("CREATE TRIGGER fail_settle BEFORE UPDATE ON task_attempts WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'synthetic settle failure'); END;");
  assert.throws(()=>service.settleAttempt(root,'completed'),/synthetic settle failure/);
  assert.equal(service.getRun(root.runId).state,'running');assert.equal(service.listAttempts(root.runId)[0].state,'running');
  assert.equal(service.listActivity().events.some(event=>event.kind==='run.settled'),false);
});
