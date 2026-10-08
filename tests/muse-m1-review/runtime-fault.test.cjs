'use strict';
// Independent review probes: real runtime source and isolated native SQLite;
// models, tools and event delivery are controlled by the established fixture.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('../muse-m1-runtime/fixture.cjs');
const {harness,stream,call}=require('../muse/harness.cjs');

function assertNoUnpairedContinuation(h) {
  for(const messages of h.requests.slice(1)) {
    const declared=messages.flatMap(row=>row.tool_calls??[]).map(row=>row.id);
    const paired=messages.filter(row=>row.role==='tool').map(row=>row.tool_call_id);
    for(const id of declared) assert.ok(paired.includes(id),`continued model request lacks tool result ${id}`);
  }
}

async function observe(promise) {
  try {return {resolved:true,value:await promise};}
  catch(error) {return {resolved:false,error};}
}

test('independent review: child admission SQLite failure never continues the model with an unpaired tool',async t=>{
  const {service,db}=await fixture(t);const root=service.beginRun('fixture-conv');
  db.exec("CREATE TRIGGER fail_child_admission BEFORE INSERT ON task_attempts WHEN NEW.parent_attempt_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic child admission failure'); END;");
  const h=harness(t,{taskService:service,mainTurns:[stream([call('D','{}','delegate_executor')]),stream([],'synthetic final')]});
  const result=await observe(h.runMain({taskContext:root}));
  assert.equal(h.delegations.length,0,'failed admission must not dispatch a task');
  assertNoUnpairedContinuation(h);
  const stored=h.rows.filter(row=>row.role==='tool' && row.payload.toolCallId==='D');
  assert.equal(stored.length,1,'admission failure must preserve exactly one pair for later conversation replay');
  assert.equal(JSON.parse(stored[0].payload.result).current_task_execution_result.success,false);
  if(result.resolved) {
    assert.ok(h.rows.some(row=>row.role==='tool' && row.payload.toolCallId==='D'),'handled failure must preserve its tool result');
    const pair=h.requests[1]?.find(row=>row.role==='tool' && row.tool_call_id==='D');
    assert.ok(pair,'continuing after admission failure requires a real failure pair');
    assert.equal(JSON.parse(pair.content).current_task_execution_result.success,false);
  } else {
    assert.ok(!h.events.some(event=>event.name==='main-agent:done'),'unhandled storage failure cannot claim DONE');
  }
  assert.equal(service.listAttempts(root.runId).filter(row=>row.parentAttemptId).length,0,'failed child transaction rolled back');
});

test('independent review: record initialization exception settles the child and cannot omit its tool pair',async t=>{
  const {service}=await fixture(t);const root=service.beginRun('fixture-conv');
  const h=harness(t,{taskService:service,mainTurns:[stream([call('D','{}','delegate_executor')]),stream([],'synthetic final')]});
  const original=h.events.push.bind(h.events);let injected=false;
  h.events.push=(...events)=>{
    if(!injected && events.some(event=>event.name==='executor:record-signal')) {
      injected=true;throw new Error('synthetic record initialization failure');
    }
    return original(...events);
  };
  const result=await observe(h.runMain({taskContext:root}));
  assert.equal(injected,true);assert.equal(h.delegations.length,0);
  assert.equal(service.listAttempts(root.runId).find(row=>row.parentAttemptId).state,'failed');
  assertNoUnpairedContinuation(h);
  assert.equal(h.rows.filter(row=>row.role==='tool' && row.payload.toolCallId==='D').length,1,'setup failure remains paired in saved history');
  if(!result.resolved) assert.ok(!h.events.some(event=>event.name==='main-agent:done'));
});

test('independent review: child settlement persistence failure is surfaced instead of a successful main continuation',async t=>{
  const {service,db}=await fixture(t);const root=service.beginRun('fixture-conv');
  const reviews=[];
  db.exec("CREATE TRIGGER fail_child_settle BEFORE UPDATE ON task_attempts WHEN NEW.parent_attempt_id IS NOT NULL AND NEW.state='completed' BEGIN SELECT RAISE(ABORT,'synthetic child settle failure'); END;");
  const h=harness(t,{taskService:service,mainTurns:[stream([call('D','{}','delegate_executor')]),stream([],'synthetic final')],
    artifactReview:attemptId=>reviews.push(attemptId),delegate:async()=>({success:true,message:'synthetic completed task',data:{}})});
  const result=await observe(h.runMain({taskContext:root}));
  assert.equal(h.delegations.length,1,'actual tool execution must not replay');
  assert.equal(service.listAttempts(root.runId).find(row=>row.parentAttemptId).state,'running','rollback retains unconfirmed persistent state');
  assert.deepEqual(reviews,[service.listAttempts(root.runId).find(row=>row.parentAttemptId).id],'review marking must run even when durable settlement throws');
  assert.equal(result.resolved,false,'failed durable settlement must be surfaced to the outer lifecycle');
  assert.ok(!h.events.some(event=>event.name==='main-agent:done'),'cannot claim main success while durable child settlement failed');
  assert.equal(h.requests.length,1,'must not issue a new model request after durable settlement failure');
  const stored=h.rows.filter(row=>row.role==='tool' && row.payload.toolCallId==='D');
  assert.equal(stored.length,1,'failed bookkeeping must not duplicate an already paired actual tool result');
  assert.equal(JSON.parse(stored[0].payload.result).current_task_execution_result.success,true,'actual completed work is preserved even when lifecycle bookkeeping is unknown');
});

test('independent review: separate owners cannot admit, deliver, or mutate the active attempt owned by another service',async t=>{
  const {service,api,db}=await fixture(t);const root=service.beginRun('C');
  const child=service.beginAttempt(root,{taskId:'T',delegateCallId:'D'});
  service.acceptMessage(child,'M','synthetic');
  const other=api.createTaskService(db,{ownerId:'other-owner'});
  assert.throws(()=>other.beginRun('C'),/UNIQUE/);
  assert.equal(other.isCurrent(child),false);
  assert.equal(other.recordToolStarted(child,{callId:'late',toolName:'synthetic'}),false);
  assert.equal(other.recordToolSettled(child,{callId:'late',toolName:'synthetic',success:true}),false);
  assert.equal(other.injectNext(child,()=>assert.fail('another owner must not inject')),null);
  assert.equal(other.requestStop(child),false);
  assert.equal(other.settleAttempt(child,'completed'),false);
  assert.equal(service.listInbox({runId:root.runId})[0].state,'accepted');
});
