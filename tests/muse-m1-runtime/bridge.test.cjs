'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {fixture}=require('./fixture.cjs');const {harness,stream,call,deferred,until}=require('../muse/harness.cjs');

test('real main delegate bridge persists child actual settle while root remains running after reply DONE',async t=>{
  const {service}=await fixture(t);const root=service.beginRun('fixture-conv');const done=deferred();
  const h=harness(t,{taskService:service,mainTurns:[stream([call('D','{}','delegate_executor')]),stream([],'synthetic final')],delegate:async opts=>{
    assert.ok(opts.taskContext);assert.equal(opts.taskContext.parentAttemptId,root.attemptId);await done.promise;
    return {success:true,message:'synthetic',data:{}};
  }});
  const running=h.runMain({taskContext:root});await until(()=>h.delegations.length===1);
  assert.equal(service.listAttempts(root.runId).filter(row=>row.parentAttemptId)[0].state,'running');
  done.resolve();await running;
  assert.equal(service.listAttempts(root.runId).filter(row=>row.parentAttemptId)[0].state,'completed');
  assert.equal(service.getRun(root.runId).state,'running'); // Only chat SEND's awaited finally settles root.
  assert.ok(h.events.some(event=>event.name==='main-agent:done'));
  service.settleAttempt(root,'completed','main-agent-settled');assert.equal(service.getRun(root.runId).state,'completed');
});
test('real store accepts durable idempotent inbox, injects shared array once and keeps private text out of activity',async t=>{
  const {service}=await fixture(t);const root=service.beginRun('fixture-conv');const child=service.beginAttempt(root,{taskId:'T',delegateCallId:'D'});
  const h=harness(t,{taskService:service});const session=h.store.beginExecutorTaskRecord({taskContext:child,conversationId:'fixture-conv',delegateCallId:'D',taskId:'T',messageId:'A',taskName:'synthetic'});
  const model=session.adoptMessages([{role:'system',content:'synthetic'}]);
  assert.equal(h.store.sendTaskUserMessage('fixture-conv','D','synthetic private','M').accepted,true);
  assert.equal(h.store.sendTaskUserMessage('fixture-conv','D','synthetic private','M').accepted,true);
  assert.equal(session.records.filter(row=>row.kind==='user-message').length,1);
  assert.equal(h.store.sendTaskUserMessage('fixture-conv','D','different','M').reason,'message-id-conflict');
  assert.equal(session.consumePendingUserMessages(),1);assert.equal(model.length,2);assert.equal(session.consumePendingUserMessages(),0);
  assert.equal(session.records.find(row=>row.kind==='user-message').state,'delivered');assert.equal(service.listInbox({runId:root.runId})[0].state,'injected');
  assert.ok(!JSON.stringify(service.listActivity().events).includes('synthetic private'));
});
test('real isolated stop persists stop_requested before abort and waits for executor promise settlement',async t=>{
  const {service}=await fixture(t);const root=service.beginRun('fixture-conv');const release=deferred();
  const h=harness(t,{taskService:service,mainTurns:[stream([call('D','{}','delegate_executor')]),stream([],'synthetic final')],delegate:async opts=>{
    await release.promise;if(opts.signal.aborted)throw opts.signal.reason;return {success:true,message:'synthetic'};
  }});
  const running=h.runMain({taskContext:root});await until(()=>h.delegations.length===1);
  const result=h.store.stopExecutorTask('fixture-conv','D');assert.equal(result.stopped,true);
  const child=service.listAttempts(root.runId).find(row=>row.parentAttemptId);
  assert.equal(child.state,'stop_requested');assert.equal(h.sessions[0].status,'running');
  assert.match(h.sessions[0].records.find(row=>row.kind==='notice').text,/停止请求中/);
  release.resolve();await assert.rejects(running,/ABORTED/);assert.equal(service.listAttempts(root.runId).find(row=>row.parentAttemptId).state,'cancelled');
  assert.equal(h.sessions[0].status,'aborted');assert.match(h.sessions[0].records.filter(row=>row.kind==='notice').at(-1).text,/真实已停止/);
});
test('restart fences old store callback and queued inbox so no late context mutation occurs',async t=>{
  const {service}=await fixture(t);const root=service.beginRun('fixture-conv');const child=service.beginAttempt(root,{taskId:'T',delegateCallId:'D'});
  const h=harness(t,{taskService:service});const session=h.store.beginExecutorTaskRecord({taskContext:child,conversationId:'fixture-conv',delegateCallId:'D',taskId:'T',messageId:'A',taskName:'synthetic'});
  h.store.sendTaskUserMessage('fixture-conv','D','synthetic private','M');const before=session.records.length;service.reconcileInterrupted();
  session.appendThinkingDelta('late reasoning');session.beginToolCall({callId:'late',name:'run_shell',args:'private args'});session.sealAssistantReply('late reply');
  assert.equal(session.consumePendingUserMessages(),0);assert.equal(session.modelMessages.length,0);assert.equal(session.records.length,before);
  assert.equal(service.listInbox({runId:root.runId})[0].state,'cancelled');
});
test('native DB stop fault still aborts the actual task and cannot falsely settle its persistent state',async t=>{
  const {service,db}=await fixture(t);const root=service.beginRun('fixture-conv');const child=service.beginAttempt(root,{taskId:'T',delegateCallId:'D'});
  const h=harness(t,{taskService:service});const session=h.store.beginExecutorTaskRecord({taskContext:child,conversationId:'fixture-conv',delegateCallId:'D',taskId:'T',messageId:'A',taskName:'synthetic'});
  const controller=new AbortController();h.store.registerTaskStopController('fixture-conv','D',controller);
  db.exec("CREATE TRIGGER fail_stop BEFORE UPDATE ON task_attempts BEGIN SELECT RAISE(ABORT,'synthetic state write failure'); END;");
  assert.equal(h.store.stopExecutorTask('fixture-conv','D').stopped,true);assert.equal(controller.signal.aborted,true);
  assert.equal(session.status,'running');assert.equal(service.listAttempts(root.runId).find(row=>row.id===child.attemptId).state,'running');
  assert.throws(()=>service.settleAttempt(child,'cancelled'),/synthetic state write failure/);
  assert.equal(service.getRun(root.runId).state,'running');assert.equal(session.enqueueUserMessage('late','late').reason,'stop-requested');
  assert.equal(service.listInbox({runId:root.runId}).find(row=>row.messageId==='late').state,'rejected');
  db.exec('DROP TRIGGER fail_stop');service.settleAttempt(child,'cancelled');service.settleAttempt(root,'cancelled');
  assert.equal(service.getRun(root.runId).state,'cancelled');
});
test('old child controller unregister cannot remove a later controller sharing a legacy delegate key',async t=>{
  const {service}=await fixture(t);const root=service.beginRun('fixture-conv');const child=service.beginAttempt(root,{taskId:'T',delegateCallId:'D'});
  const h=harness(t,{taskService:service});h.store.beginExecutorTaskRecord({taskContext:child,conversationId:'fixture-conv',delegateCallId:'D',taskId:'T',messageId:'A',taskName:'synthetic'});
  const old=new AbortController();const current=new AbortController();
  h.store.registerTaskStopController('fixture-conv','D',old);h.store.registerTaskStopController('fixture-conv','D',current);
  h.store.unregisterTaskStopController('fixture-conv','D',old);
  assert.equal(h.store.stopExecutorTask('fixture-conv','D').stopped,true);assert.equal(current.signal.aborted,true);assert.equal(old.signal.aborted,false);
});
test('native child admission fault persists a failure pair and halts before an unpaired second model request',async t=>{
  const {service,db}=await fixture(t);const root=service.beginRun('fixture-conv');
  db.exec("CREATE TRIGGER fail_child BEFORE INSERT ON task_attempts WHEN NEW.parent_attempt_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic child admission failure'); END;");
  const h=harness(t,{taskService:service,mainTurns:[stream([call('D','{}','delegate_executor')]),stream([],'must not request')]});
  await assert.rejects(h.runMain({taskContext:root}),/synthetic child admission failure/);
  assert.equal(h.requests.length,1);assert.equal(h.delegations.length,0);assert.equal(h.rows.filter(row=>row.role==='tool'&&row.payload.toolCallId==='D').length,1);
  assert.match(h.rows.find(row=>row.role==='tool').payload.result,/未能确认|需核实/);
  assert.equal(h.events.some(event=>event.name==='main-agent:done'),false);assert.equal(service.listAttempts(root.runId).length,1);
  service.settleAttempt(root,'failed');assert.equal(service.getRun(root.runId).state,'failed');
});
test('native child settle fault preserves exactly one real tool pair, marks artifacts for review and waits for siblings',async t=>{
  const {service,db}=await fixture(t);const root=service.beginRun('fixture-conv');const release=deferred();const reviews=[];
  db.exec("CREATE TRIGGER fail_child_settle BEFORE UPDATE ON task_attempts WHEN OLD.delegate_call_id='D1' BEGIN SELECT RAISE(ABORT,'synthetic child settle failure'); END;");
  const h=harness(t,{taskService:service,artifactReview:id=>reviews.push(id),mainTurns:[stream([call('D1','{}','delegate_executor'),call('D2','{}','delegate_executor')]),stream([],'must not request')],delegate:async opts=>{
    if(opts.taskContext.delegateCallId==='D2')await release.promise;return {success:true,message:'real synthetic tool result'};
  }});
  let settled=false;const running=h.runMain({taskContext:root});running.then(()=>{settled=true;},()=>{settled=true;});
  await until(()=>h.delegations.length===2);await until(()=>reviews.length===1);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false,'root must await the still-running sibling');
  release.resolve();await assert.rejects(running,/synthetic child settle failure/);
  assert.equal(h.requests.length,1);assert.equal(h.rows.filter(row=>row.role==='tool').length,2);
  assert.equal(h.rows.filter(row=>row.role==='tool'&&row.payload.toolCallId==='D1').length,1);
  const child=service.listAttempts(root.runId).find(row=>row.delegateCallId==='D1');assert.equal(child.state,'running');assert.deepEqual(reviews,[child.id]);
  assert.equal(h.store.stopExecutorTask('fixture-conv','D1').stopped,false);assert.equal(h.store.stopExecutorTask('fixture-conv','D2').stopped,false);
});
