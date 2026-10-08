'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('../muse-m1-runtime/fixture.cjs');
const {harness,stream,call,input,final,deferred,until}=require('../muse/harness.cjs');

test('review: idempotent receipts require the complete current owner identity even for an existing message',async t=>{
  const {service,api,db}=await fixture(t);const root=service.beginRun('C');
  const child=service.beginAttempt(root,{taskId:'T',delegateCallId:'D'});
  service.acceptMessage(child,'M','synthetic');const before=service.listActivity().events.length;
  const other=api.createTaskService(db,{ownerId:'other-owner'});
  for(const [owner,context] of [[other,child],[service,{...child,ownerId:'forged'}],
    [service,{...child,conversationId:'different'}],[service,{...child,taskId:'different'}],
    [service,{...child,generation:child.generation+1}],
    [service,{...child,parentAttemptId:'different'}],[service,{...child,delegateCallId:'different'}]]) {
    const reply=owner.acceptMessage(context,'M','synthetic');
    assert.equal(reply.accepted,false);assert.equal(reply.reason,'stale-attempt');
  }
  assert.equal(service.listActivity().events.length,before);
  assert.equal(service.listInbox({runId:root.runId})[0].state,'accepted');
  assert.equal(service.acceptMessage(child,'M','synthetic').duplicate,true);
});

test('review: process restart refuses an old queued receipt without replaying its text',async t=>{
  const {service,api,db}=await fixture(t);const root=service.beginRun('C');
  service.acceptMessage(root,'M','synthetic');
  const restarted=api.createTaskService(db,{ownerId:'restart-owner'});
  restarted.reconcileInterrupted();
  assert.equal(service.acceptMessage(root,'M','synthetic').reason,'stale-attempt');
  assert.equal(restarted.acceptMessage(root,'M','synthetic').reason,'stale-attempt');
  assert.equal(restarted.listInbox({runId:root.runId})[0].state,'cancelled');
  assert.equal(restarted.injectNext(root,()=>assert.fail('restart never replays queued text')),null);
});

test('review: already injected receipts remain idempotent after real terminal settlement for their valid owner',async t=>{
  const {service}=await fixture(t);const root=service.beginRun('C');
  service.acceptMessage(root,'M','synthetic');let pushes=0;service.injectNext(root,()=>pushes++);
  service.settleAttempt(root,'completed');
  assert.equal(service.acceptMessage(root,'M','synthetic').accepted,true);
  assert.equal(service.acceptMessage(root,'M','synthetic').inboxState,'injected');
  assert.equal(service.injectNext(root,()=>pushes++),null);assert.equal(pushes,1);
  service.reconcileInterrupted();
  assert.equal(service.acceptMessage(root,'M','synthetic').inboxState,'injected');
});

test('review: native tool settlement fault waits for sibling tools, preserves real facts, and stops executor continuation',async t=>{
  const {service,db}=await fixture(t);const root=service.beginRun('fixture-conv');const slow=deferred();const reviews=[];
  db.exec("CREATE TRIGGER fail_tool_fact BEFORE INSERT ON activity_events WHEN NEW.kind='tool.settled' AND json_extract(NEW.details_json,'$.callId')='fast' BEGIN SELECT RAISE(ABORT,'synthetic tool settlement storage fault'); END;");
  const h=harness(t,{taskService:service,artifactReview:id=>reviews.push(id),integrate:true,
    mainTurns:[stream([call('D',input(),'delegate_executor')]),stream([],'synthetic failure explanation')],
    executorTurns:[stream([call('fast'),call('slow')]),stream([],final())],
    execute:({id})=>id==='slow'?slow.promise:Promise.resolve({id,result:{success:true,code:'OK',message:'actual synthetic completion'}})});
  let ended=false;const pending=h.runMain({taskContext:root});pending.then(()=>{ended=true;},()=>{ended=true;});
  await until(()=>h.executions.length===2);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ended,false);assert.equal(h.adapters[1].closed,false,'executor still owns the slow tool');
  slow.resolve({id:'slow',result:{success:true,code:'OK',message:'actual slow completion'}});
  await pending;
  assert.equal(h.executorRequests.length,1,'durable receipt failure cannot request a later executor model turn');
  assert.equal(h.parserCalls.length,0,'cannot accept a final output after missing tool persistence');
  assert.equal(h.logs[0].toolCalls.every(row=>row.status==='completed'),true,'actual successful tools stay truthful in the error log');
  assert.equal(h.adapters.every(adapter=>adapter.closed),true);
  const child=service.listAttempts(root.runId).find(row=>row.parentAttemptId);
  assert.equal(child.state,'failed');assert.deepEqual(reviews,[child.id]);
  const pair=h.rows.find(row=>row.role==='tool'&&row.payload.toolCallId==='D');
  assert.equal(JSON.parse(pair.payload.result).current_task_execution_result.success,false);
  assert.match(pair.payload.result,/synthetic tool settlement storage fault/);
  const facts=service.listActivity({runId:root.runId}).events;
  assert.equal(facts.some(row=>row.kind==='tool.settled'&&row.details.callId==='fast'),false);
  assert.equal(facts.some(row=>row.kind==='tool.settled'&&row.details.callId==='slow'),true);
});

test('review: a fenced model reply cannot dispatch a new tool after its generation has been interrupted',async t=>{
  const {service}=await fixture(t);const root=service.beginRun('fixture-conv');
  const h=harness(t,{taskService:service,integrate:true,
    mainTurns:[stream([call('D',input(),'delegate_executor')]),stream([],'synthetic interruption explanation')],
    executorTurns:[()=>{service.reconcileInterrupted();return stream([call('must-not-run')]);}]});
  await h.runMain({taskContext:root});
  assert.equal(h.executions.length,0,'durable generation fence must reject admission before tool side effects');
  assert.equal(h.executorRequests.length,1);assert.equal(h.parserCalls.length,0);
  const tool=h.rows.find(row=>row.role==='tool'&&row.payload.toolCallId==='D');
  assert.match(tool.payload.result,/STALE_TASK_ATTEMPT/);
  assert.equal(service.getRun(root.runId).state,'interrupted');
  assert.equal(service.listAttempts(root.runId).every(row=>row.state==='interrupted'),true);
  assert.equal(service.listActivity().events.some(row=>row.kind==='tool.started'&&row.details.callId==='must-not-run'),false);
});
