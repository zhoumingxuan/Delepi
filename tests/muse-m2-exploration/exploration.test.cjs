'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,until}=require('./fixture.cjs');
const {deferred}=require('../muse-m2-brokers/fixture.cjs');
const code=expected=>error=>error.code===expected;
const count=(f,table)=>f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const globalAccount=f=>f.ledger.listAccounts().find(value=>value.scope==='global');

test('D plan preview is local, protocol-specific and starts no Run, budget or I/O',async t=>{
  const f=await fixture(t),plan=f.plan('responses');
  assert.equal(plan.protocol,'responses');assert.equal(plan.sources.length,1);assert.equal(plan.destination.id,f.destination.id);
  assert.equal(count(f,'runs'),0);assert.equal(count(f,'m2_operations'),0);assert.equal(f.ledger.listAccounts().length,0);assert.equal(f.server.requests.length,0);
  assert.equal(JSON.stringify(plan).includes(f.settings.mainModelApiKey),false);
  assert.throws(()=>f.exploration.startExploration(plan.id,plan.revision,2),code('UNTRUSTED_CALLER'));
  assert.throws(()=>f.exploration.startExploration(plan.id,plan.revision+1,1),code('REVISION_CONFLICT'));
});

for(const protocol of ['chat-completions','responses'])test(`D real ${protocol} chain waits for approval and saves an independently reviewable scoped artifact`,async t=>{
  const f=await fixture(t),plan=f.plan(protocol),session=f.start(plan);
  assert.equal(f.start(plan).runId,session.runId);assert.equal(count(f,'runs'),1);
  const pending=await until(()=>f.authority.listApprovals().find(card=>card.state==='pending'));
  assert.equal(f.server.requests.length,0);assert.equal(f.ledger.listAccounts().length,0);
  assert.equal(f.exploration.listExplorations()[0].state,'waiting_approval');
  assert.equal(f.exploration.appendPublicMessage(session.runId,'public-note','Include this confirmed public fact.',true,1).accepted,true);
  const stopApprove=f.approveAll();t.after(stopApprove);
  await f.exploration.waitForRun(session.runId);stopApprove();
  const result=f.exploration.listExplorations()[0];assert.equal(result.state,'completed',JSON.stringify({result,operations:f.db.prepare('SELECT id,state,result_kind FROM m2_operations').all()}));assert.equal(result.sourceCount,1);assert.ok(result.artifactId);assert.ok(result.settledAt);
  const provider=f.server.requests.find(request=>request.path===`/v1/${protocol==='responses'?'responses':'chat/completions'}`);
  assert.ok(provider);assert.ok(provider.body.includes('Include this confirmed public fact.'));
  assert.equal(f.server.requests.length,2);assert.equal(globalAccount(f).used.fetchRequests,1);assert.equal(globalAccount(f).used.modelRequests,1);
  const artifact=f.db.prepare('SELECT * FROM artifacts WHERE id=?').get(result.artifactId);
  assert.ok(artifact);assert.ok(fs.readFileSync(artifact.path,'utf8').includes('https://source.example.com/public'));
  assert.equal(f.db.prepare('SELECT goal_id FROM m2_artifact_scopes WHERE artifact_id=?').get(result.artifactId).goal_id,f.goal.id);
  assert.equal(f.exploration.appendPublicMessage(session.runId,'late','too late',true,1).accepted,false);
  assert.equal(count(f,'m2_public_inbox'),1);assert.equal(f.db.prepare('SELECT state FROM run_inbox').get().state,'injected');
});

test('D public append rejects private confirmation and foreign caller before its payload can enter the model',async t=>{
  const f=await fixture(t),session=f.start(f.plan());await until(()=>f.authority.listApprovals().some(card=>card.state==='pending'));
  assert.equal(f.exploration.appendPublicMessage(session.runId,'private','PRIVATE',false,1).accepted,false);
  assert.throws(()=>f.exploration.appendPublicMessage(session.runId,'foreign','FOREIGN',true,2),code('UNTRUSTED_CALLER'));
  assert.equal(count(f,'run_inbox'),0);await f.exploration.stopExploration(session.runId);
  assert.equal(f.server.requests.length,0);assert.equal(f.exploration.listExplorations()[0].state,'stopped');
});

test('D stop waits for actual sibling sockets to close and sends no model request afterwards',async t=>{
  const entered=deferred();let sources=0;
  const stalled=(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.write('pending');if(++sources===2)entered.resolve();};
  const f=await fixture(t,{urls:['https://source.example.com/public','https://source.example.com/second'],routes:{'/public':stalled,'/second':stalled}}),session=f.start(f.plan());
  const stopApprove=f.approveAll();t.after(stopApprove);await entered.promise;
  await f.exploration.stopExploration(session.runId);stopApprove();
  assert.equal(f.exploration.listExplorations()[0].state,'stopped');assert.equal(globalAccount(f).used.fetchRequests,2);assert.equal(globalAccount(f).used.modelRequests,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_operations WHERE state IN ('prepared','started')").get().n,0);
  assert.equal(f.server.requests.length,2);
  assert.ok(f.server.connections.every(connection=>connection.closed));
});

test('D failed stop persistence cancels live network first and preserves outcome_unknown instead of claiming a clean stop',async t=>{
  const entered=deferred();const f=await fixture(t,{routes:{'/public':(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.write('pending');entered.resolve();}}}),session=f.start(f.plan());
  const stopApprove=f.approveAll();t.after(stopApprove);await entered.promise;
  f.db.exec("CREATE TRIGGER refuse_stop BEFORE UPDATE ON m2_exploration_sessions WHEN NEW.state='stop_requested' BEGIN SELECT RAISE(ABORT,'synthetic stop receipt failure'); END");
  await assert.rejects(f.exploration.stopExploration(session.runId),code('PERSISTENCE_FAILED'));stopApprove();
  assert.equal(f.server.requests.length,1);assert.equal(globalAccount(f).used.fetchRequests,1);assert.equal(globalAccount(f).used.modelRequests,0);
  assert.equal(f.exploration.listExplorations()[0].state,'outcome_unknown');
});

test('D changing a Goal invalidates the active scope and cancels its I/O without dropping historical sources',async t=>{
  const entered=deferred();const f=await fixture(t,{routes:{'/public':(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.write('pending');entered.resolve();}}}),session=f.start(f.plan());
  const stopApprove=f.approveAll();t.after(stopApprove);await entered.promise;
  f.goals.update(f.goal.id,f.goal.revision,{...f.draft,topic:'Updated public topic'});await f.exploration.waitForRun(session.runId);stopApprove();
  const result=f.exploration.listExplorations()[0];assert.equal(result.state,'stopped');assert.equal(result.stopReason,'GOAL_CHANGED');
  assert.equal(f.server.requests.length,1);assert.equal(count(f,'m2_run_scopes'),1);assert.equal(globalAccount(f).used.modelRequests,0);
});

test('D failed model attempt produces no artifact and never falls back to another protocol',async t=>{
  const f=await fixture(t,{routes:{
    '/public':(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('public');},
    '/v1/chat/completions':(_req,res)=>{res.writeHead(500,{'content-type':'application/json'});res.end('{}');},
  }}),session=f.start(f.plan());const stopApprove=f.approveAll();t.after(stopApprove);
  await f.exploration.waitForRun(session.runId);stopApprove();
  assert.equal(f.exploration.listExplorations()[0].state,'failed');assert.equal(count(f,'artifacts'),0);assert.equal(f.server.requests.length,2);
  assert.equal(globalAccount(f).used.modelRequests,1);assert.ok(globalAccount(f).reserved.tokenUnits>0);
});

test('D a native start-record failure rolls back Run and scope and sends no I/O',async t=>{
  const f=await fixture(t),plan=f.plan();f.db.exec("CREATE TRIGGER refuse_start BEFORE INSERT ON m2_exploration_sessions BEGIN SELECT RAISE(ABORT,'synthetic start failure'); END");
  assert.throws(()=>f.start(plan),/synthetic start failure/);assert.equal(count(f,'runs'),0);assert.equal(count(f,'task_attempts'),0);assert.equal(count(f,'m2_run_scopes'),0);assert.equal(f.server.requests.length,0);
  assert.equal(f.db.prepare('SELECT state FROM m2_exploration_plans').get().state,'pending');
});

test('D rejects later public additions once the model card is waiting and never loads private M1 history',async t=>{
  const f=await fixture(t),privateRun=f.tasks.beginRun('private-history');f.tasks.acceptMessage(privateRun,'private-original','PRIVATE_CHAT_HISTORY_MARKER');
  const session=f.start(f.plan());
  for(;;){const card=await until(()=>f.authority.listApprovals().find(value=>value.state==='pending'));
    if(card.action.capability==='model.invoke'){
      assert.equal(f.exploration.appendPublicMessage(session.runId,'late','late public input',true,1).accepted,false);
      assert.equal(count(f,'m2_public_inbox'),0);f.authority.decideApproval(card.id,card.revision,'run',1);break;
    }
    f.authority.decideApproval(card.id,card.revision,'run',1);
  }
  const stopApprove=f.approveAll();t.after(stopApprove);await f.exploration.waitForRun(session.runId);stopApprove();
  assert.equal(f.exploration.listExplorations()[0].state,'completed');
  const request=f.server.requests.find(value=>value.path==='/v1/chat/completions');assert.equal(request.body.includes('PRIVATE_CHAT_HISTORY_MARKER'),false);
  assert.equal(f.db.prepare("SELECT text FROM run_inbox WHERE message_id='private-original'").get().text,'PRIVATE_CHAT_HISTORY_MARKER');
});

test('D trusted destination changes stop a live request and preserve its unknown usage without protocol retries',async t=>{
  const entered=deferred();const f=await fixture(t,{routes:{
    '/public':(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('public');},
    '/v1/chat/completions':(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{');entered.resolve();},
  }}),session=f.start(f.plan());const stopApprove=f.approveAll();t.after(stopApprove);await entered.promise;
  f.settings.mainModelApiKey='changed-synthetic-key';f.exploration.cancelAll('DESTINATION_CHANGED');await f.exploration.waitForRun(session.runId);stopApprove();
  const result=f.exploration.listExplorations()[0];assert.equal(result.state,'stopped');assert.equal(result.stopReason,'DESTINATION_CHANGED');
  assert.equal(f.server.requests.length,2);assert.ok(f.server.connections.every(value=>value.closed));assert.equal(count(f,'artifacts'),0);
  assert.equal(globalAccount(f).used.modelRequests,1);assert.ok(globalAccount(f).reserved.tokenUnits>0);
});

test('D process reconciliation preserves a prepared Run, spent request and unknown use without any automatic resume',async t=>{
  const f=await fixture(t),plan=f.plan(),context=f.tasks.beginRun('synthetic-interrupted-public');f.goals.bindRun(context,f.goal.id,f.goal.revision);
  const resources=f.goals.get(f.goal.id).resources,source=resources.find(value=>value.kind==='public_url');
  const ruleCard=f.authority.previewRule({goalId:f.goal.id,expectedGoalRevision:f.goal.revision,capabilities:['fetch.public'],resourceRefs:[source.id],expiresAt:new Date(Date.now()+900000).toISOString(),resumeAfterRestart:true},1);
  f.authority.issueRule(ruleCard.id,ruleCard.revision,1);
  const lease=f.authority.prepare(context,{capability:'fetch.public',resourceRef:source.id,resourceVersion:`${source.revision}:${source.contentHash}`,summary:'Synthetic interrupted attempt',units:{modelRequests:0,fetchRequests:1,downloadBytes:100,storageBytes:100,tokenUnits:0}});
  f.authority.markStarted(lease.leaseId,context);
  f.db.prepare("INSERT INTO m2_exploration_sessions(id,plan_id,goal_id,run_id,state,created_at) VALUES('interrupted-session',?,?,?,'running',?)").run(plan.id,f.goal.id,context.runId,new Date().toISOString());
  f.tasks.reconcileInterrupted();f.authority.reconcileInterrupted();assert.equal(f.exploration.reconcileInterrupted(),1);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.server.requests.length,0);
  assert.equal(f.exploration.listExplorations()[0].state,'interrupted');assert.equal(f.authority.listRules()[0].state,'suspended');
  assert.equal(globalAccount(f).used.fetchRequests,1);assert.equal(globalAccount(f).reserved.downloadBytes,100);assert.equal(globalAccount(f).reserved.storageBytes,100);
  assert.equal(f.db.prepare('SELECT state FROM m2_operations WHERE id=?').get(lease.operationId).state,'outcome_unknown');
});
