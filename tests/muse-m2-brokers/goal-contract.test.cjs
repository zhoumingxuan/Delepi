'use strict';
// Independent preparation-stage contract probes for root-owned Goal/scope code.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {loadSource,databaseFixture}=require('./fixture.cjs');

async function fixture(t){
  const {RUNTIME_SCHEMA_SQL}=await loadSource('src/main/db/migrations/runtime-schema.ts');
  const {AUTONOMY_SCHEMA_SQL}=await loadSource('src/main/db/migrations/autonomy-schema.ts');
  const taskApi=await loadSource('src/main/modules/tasks/task-service.ts');
  const goalApi=await loadSource('src/main/modules/goals/goal-service.ts');
  const {db}=databaseFixture(t,RUNTIME_SCHEMA_SQL+AUTONOMY_SCHEMA_SQL);let id=0;
  const tasks=taskApi.createTaskService(db,{ownerId:'independent-owner',uuid:()=>`task-${++id}`});
  const settings={mainModelBaseUrl:'https://model.example.com/v1',mainModelName:'synthetic',mainModelApiKey:'synthetic-not-a-real-key'};
  const goals=goalApi.createGoalService(db,{taskService:tasks,config:{getSettings:()=>settings},uuid:()=>`goal-${++id}`});
  const [destination]=goals.listDestinations();
  const draft={title:'synthetic public topic',topic:'public documents only',sourceUrls:['https://example.com/allowed'],
    destinationId:destination.id,expectedOutput:'synthetic summary',stopConditions:'one document',limits:goalApi.DEFAULT_EXPLORATION_LIMITS};
  return {db,tasks,goals,draft,goalApi,settings};
}

test('independent Goal contract: create, bind and CAS update preserve scoped snapshots',async t=>{
  const f=await fixture(t);const goal=f.goals.create(f.draft);
  const root=f.tasks.beginRun('synthetic-conversation');f.goals.bindRun(root,goal.id,goal.revision);
  const binding=f.db.prepare('SELECT * FROM m2_run_scopes WHERE run_id=?').get(root.runId);
  assert.equal(binding.owner_id,root.ownerId);assert.equal(binding.generation,root.generation);
  const snapshot=JSON.parse(binding.snapshot_json);assert.equal(snapshot.goal.id,goal.id);
  const anchor=snapshot.resources.find(resource=>resource.kind==='artifact');
  assert.ok(anchor,'public model/publication scope needs its trusted output anchor');
  assert.equal(anchor.goalId,goal.id);assert.equal(anchor.dataScopeId,goal.dataScopeId);
  assert.ok(/^[a-f0-9]{64}$/.test(anchor.contentHash));assert.equal(Object.hasOwn(anchor,'file_path'),false);
  assert.equal(JSON.stringify(snapshot).includes(f.settings.mainModelApiKey),false);
  const updated=f.goals.update(goal.id,goal.revision,{...f.draft,title:'new synthetic title'});
  assert.equal(updated.revision,goal.revision+1);assert.equal(JSON.parse(binding.snapshot_json).goal.title,goal.title);
  assert.throws(()=>f.goals.update(goal.id,goal.revision,f.draft),/REVISION_CONFLICT/);
  assert.equal(f.db.prepare('SELECT snapshot_json FROM m2_run_scopes').get().snapshot_json,binding.snapshot_json);
});

test('independent Goal contract: new scope does not inherit snapshots descended from a removed source',async t=>{
  const f=await fixture(t);const goal=f.goals.create(f.draft);
  const source=f.goals.get(goal.id).resources.find(resource=>resource.kind==='public_url');
  f.db.prepare("INSERT INTO m2_resources(id,goal_id,data_scope_id,kind,file_path,content_hash,size_bytes,revision,parent_id,created_at) VALUES(?,?,?,'public_snapshot',?,?,1,1,?,?)")
    .run('old-snapshot',goal.id,goal.dataScopeId,'/synthetic/never-read','a'.repeat(64),source.id,new Date().toISOString());
  const old=f.tasks.beginRun('synthetic-old');f.goals.bindRun(old,goal.id,goal.revision);
  const oldSnapshot=f.db.prepare('SELECT snapshot_json FROM m2_run_scopes WHERE run_id=?').get(old.runId).snapshot_json;
  const updated=f.goals.update(goal.id,goal.revision,{...f.draft,sourceUrls:['https://example.com/new-source']});
  const current=f.goals.get(goal.id);
  assert.equal(current.resources.some(resource=>resource.id==='old-snapshot'),false,'scope reduction must filter descendants as well as source URLs');
  assert.ok(f.db.prepare('SELECT id FROM m2_resources WHERE id=?').get('old-snapshot'),'history remains stored');
  const fresh=f.tasks.beginRun('synthetic-new');f.goals.bindRun(fresh,goal.id,updated.revision);
  const freshSnapshot=JSON.parse(f.db.prepare('SELECT snapshot_json FROM m2_run_scopes WHERE run_id=?').get(fresh.runId).snapshot_json);
  assert.equal(freshSnapshot.resources.some(resource=>resource.id==='old-snapshot'),false);
  assert.equal(f.db.prepare('SELECT snapshot_json FROM m2_run_scopes WHERE run_id=?').get(old.runId).snapshot_json,oldSnapshot);
});

test('independent Goal contract: no local hostname alias is registered as a public source',async t=>{
  const {goalApi}=await fixture(t);
  for(const raw of ['https://localhost./private','https://example.local./private','https://example.internal./private',
    'https://127.1/private','https://2130706433/private','https://[::ffff:127.0.0.1]/private'])
    assert.throws(()=>goalApi.validateSourceUrl(raw),/INVALID_REQUEST/,raw);
});
