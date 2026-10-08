'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const path=require('node:path');
const {loadSource,databaseFixture}=require('../muse-m2-brokers/fixture.cjs');
async function setup(t){
  const [migration,tasks,autonomy]=await Promise.all([
    loadSource('src/main/db/migrations/index.ts'),loadSource('src/main/modules/tasks/task-service.ts'),loadSource('src/main/modules/autonomy-runtime.ts')]);
  const f=databaseFixture(t,'CREATE TABLE settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);');
  await migration.applyMuseMigrations(f.db,{backupDir:path.join(f.root,'backups')});
  const taskService=tasks.createTaskService(f.db),listeners=new Set();
  let settings={mainModelBaseUrl:'https://model.example.com/v1',mainModelName:'synthetic-model',mainModelApiKey:'synthetic-local-key'};
  const config={getSettings:()=>settings,onModelConfigurationChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  const runtime=autonomy.createAutonomyRuntime(f.db,taskService,config,()=>{},{publicRoot:path.join(f.root,'public'),artifactRoot:path.join(f.root,'artifacts')});
  t.after(async()=>{await runtime.dispose();});
  return {...f,runtime,taskService,changeModel(){settings={...settings,mainModelName:'changed-synthetic-model'};for(const listener of listeners)listener();}};
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const limits={activeMilliseconds:300000,absoluteMilliseconds:900000,modelRequests:6,fetchRequests:8,downloadBytes:5*1024*1024,storageBytes:5*1024*1024,tokenUnits:100000,maxDocumentBytes:1024*1024,concurrency:2};
test('production composition opens stages only after recovery, and pending public work is isolated and fully stopped',async t=>{
  const f=await setup(t),r=f.runtime;
  assert.equal(r.explorationReady,false);assert.equal(r.stages,undefined);
  await r.reconcilePublicState();r.completeStartup();assert.equal(r.explorationReady,true);
  const goal=r.goals.create({title:'Synthetic public',topic:'Only public data',sourceUrls:['https://source.example.com/public'],destinationId:r.goals.listDestinations()[0].id,expectedOutput:'A report',stopConditions:'One pass',limits});
  const before=f.taskService.listRuns().length;
  const plan=r.stages.planExploration(goal.id,1,'responses',1);assert.equal(f.taskService.listRuns().length,before);
  const session=r.stages.startExploration(plan.id,1,1);await turn();
  assert.equal(r.authority.listApprovals().filter(p=>p.runId===session.runId).length,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM m2_operations').get().n,0);
  assert.equal(r.stages.budget().accounts.length,0);
  const trusted=f.taskService.beginRun('unrelated-trusted-conversation');
  await r.stages.stopExploration(session.runId);
  assert.equal(r.stages.listExplorations()[0].state,'stopped');
  assert.equal(f.taskService.getRun(session.runId).state,'cancelled');assert.equal(f.taskService.isCurrent(trusted),true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM m2_operations').get().n,0);
});
test('committed configuration changes cancel the orchestration even when only an approval is waiting',async t=>{
  const f=await setup(t),r=f.runtime;await r.reconcilePublicState();r.completeStartup();
  const goal=r.goals.create({title:'Synthetic public',topic:'Only public data',sourceUrls:['https://source.example.com/public'],destinationId:r.goals.listDestinations()[0].id,expectedOutput:'A report',stopConditions:'One pass',limits});
  const plan=r.stages.planExploration(goal.id,1,'chat-completions',1),session=r.stages.startExploration(plan.id,1,1);await turn();
  f.changeModel();await r.exploration.waitForRun(session.runId);
  const result=r.stages.listExplorations()[0];assert.equal(result.state,'stopped');assert.equal(result.stopReason,'DESTINATION_CHANGED');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM m2_operations').get().n,0);
  assert.equal(r.authority.listApprovals().filter(p=>p.state==='pending').length,0);
});
