'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {loadSource,databaseFixture}=require('../muse-m2-brokers/fixture.cjs');
async function fixture(t){
  const [runtime,schema,goals,tasks]=await Promise.all([
    loadSource('src/main/db/migrations/runtime-schema.ts'),loadSource('src/main/db/migrations/autonomy-schema.ts'),
    loadSource('src/main/modules/goals/goal-service.ts'),loadSource('src/main/modules/tasks/task-service.ts')]);
  const {db,root}=databaseFixture(t,runtime.RUNTIME_SCHEMA_SQL+schema.AUTONOMY_SCHEMA_SQL);let n=0;
  const at='2030-01-01T00:00:00.000Z';const settings={mainModelBaseUrl:'https://model.example.com/v1',mainModelName:'synthetic',mainModelApiKey:'synthetic-fixture-secret'};
  const taskService=tasks.createTaskService(db,{ownerId:'owner',uuid:()=>`task-${++n}`,now:()=>at});const changed=[];
  const service=goals.createGoalService(db,{taskService,config:{getSettings:()=>settings},now:()=>at,uuid:()=>`goal-${++n}`,onScopeChanged:id=>changed.push(id)});
  const destination=service.listDestinations()[0];
  const draft={title:'公开研究',topic:'只阅读公开材料',sourceUrls:['https://example.com/docs'],destinationId:destination.id,
    expectedOutput:'带来源摘要',stopConditions:'额度耗尽或手动停止',limits:goals.DEFAULT_EXPLORATION_LIMITS};
  return {db,root,service,taskService,draft,settings,changed,goals};
}
test('goal creates public scope and references, binding pins actual model config without exposing secret/path',async t=>{
  const f=await fixture(t);const g=f.service.create(f.draft);const result=f.service.get(g.id);
  assert.equal(result.resources.length,2);assert.equal(result.resources[0].kind,'artifact');
  const context=f.taskService.beginRun('public-fixture');f.service.bindRun(context,g.id,g.revision);
  const scope=f.db.prepare('SELECT * FROM m2_run_scopes').get();const snap=JSON.parse(scope.snapshot_json);
  assert.equal(scope.mode,'public');assert.equal(scope.owner_id,context.ownerId);assert.equal(snap.destination.revision,1);
  assert.equal(new Date(scope.deadline_at)-new Date(scope.created_at),g.limits.absoluteMilliseconds);
  assert.ok(!JSON.stringify([result,f.service.listDestinations(),snap]).includes('synthetic-fixture-secret'));
  assert.ok(!JSON.stringify(result).includes('file_path'));
  assert.throws(()=>f.service.bindRun({...context,taskId:'forged'},g.id,g.revision),/STALE/);
});
test('CAS edits pause rules and previews, preserve old scope and call only owned goal cancellation',async t=>{
  const f=await fixture(t);const g=f.service.create(f.draft);const context=f.taskService.beginRun('public-fixture');f.service.bindRun(context,g.id,1);
  const original=f.db.prepare('SELECT snapshot_json FROM m2_run_scopes').get().snapshot_json;
  const next=f.service.update(g.id,1,{...f.draft,sourceUrls:['https://example.com/new']});assert.equal(next.revision,2);
  assert.equal(f.db.prepare('SELECT snapshot_json FROM m2_run_scopes').get().snapshot_json,original);
  assert.deepEqual(f.service.get(g.id).resources.filter(r=>r.kind==='public_url').map(r=>r.url),['https://example.com/new']);
  assert.throws(()=>f.service.update(g.id,1,f.draft),/REVISION_CONFLICT/);assert.equal(f.changed.length,1);
  const paused=f.service.setState(g.id,2,'paused');assert.equal(paused.state,'paused');
  const other=f.taskService.beginRun('other');assert.throws(()=>f.service.bindRun(other,g.id,paused.revision),/STALE/);
  const archived=f.service.setState(g.id,paused.revision,'archived');assert.throws(()=>f.service.setState(g.id,archived.revision,'active'),/GOAL_INACTIVE/);
});
test('destination credential or endpoint changes invalidate availability and increment revision; no copied keys',async t=>{
  const f=await fixture(t);const d=f.service.listDestinations()[0];f.settings.mainModelApiKey='different-fixture-only';
  const selected=f.service.resolveDestination(d.id);assert.equal(selected.revision,2);
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM m2_model_destinations').all()).includes('different-fixture-only'));
  f.settings.mainModelBaseUrl='http://public.example.com/v1';assert.equal(f.service.listDestinations()[0].available,false);
  for(const host of ['10.attacker.example.com','127.attacker.example.com','192.168.attacker.example.com','172.16.attacker.example.com']) {
    f.settings.mainModelBaseUrl=`http://${host}/v1`;assert.equal(f.service.listDestinations()[0].available,false);
  }
  assert.throws(()=>f.service.create(f.draft),/DESTINATION_UNAVAILABLE/);
  f.settings.mainModelBaseUrl='http://127.0.0.1:11434/v1';assert.equal(f.service.listDestinations()[0].available,true);
});
test('source/limit validation rejects local paths, credentials, literals, non-HTTPS and forged fields',async t=>{
  const f=await fixture(t);
  for(const url of ['http://example.com','https://127.0.0.1','https://[::1]','https://localhost','https://a.local','https://user:pass@example.com','file:///tmp/private','https://example.com/#fragment'])
    assert.throws(()=>f.service.create({...f.draft,sourceUrls:[url]}));
  for(const patch of [{concurrency:3},{modelRequests:-1},{activeMilliseconds:0},{tokenUnits:NaN},{absoluteMilliseconds:5},{maxDocumentBytes:20*1024*1024}])
    assert.throws(()=>f.service.create({...f.draft,limits:{...f.draft.limits,...patch}}));
  assert.throws(()=>f.service.create({...f.draft,ownerId:'forged'}));assert.equal(f.service.list().length,0);
});
test('goal audit and scope updates roll back together on persistence error; audit is immutable',async t=>{
  const f=await fixture(t);const g=f.service.create(f.draft);
  f.db.exec("CREATE TRIGGER synthetic_fail BEFORE INSERT ON m2_audit_events WHEN NEW.kind='goal.updated' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  assert.throws(()=>f.service.update(g.id,1,{...f.draft,title:'changed'}),/fixture failure/);
  assert.equal(f.service.get(g.id).goal.revision,1);assert.equal(f.changed.length,0);
  assert.throws(()=>f.db.exec("UPDATE m2_audit_events SET kind='forged'"),/immutable/);
  assert.throws(()=>f.db.exec('DELETE FROM m2_audit_events'),/immutable/);
});
