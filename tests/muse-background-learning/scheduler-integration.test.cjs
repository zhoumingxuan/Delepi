'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixture.cjs');
const {loadSource}=require('../muse-m2-brokers/fixture.cjs');
const {until}=require('../muse-m2-exploration/fixture.cjs');
let source;
async function setup(t) {
  let f,instant=Date.now(),n=0;
  f=await fixture(t,{model:{learningContext(goalId,goalRevision){
    const scheduled=f.db.prepare(`SELECT rule_id FROM muse_background_schedules WHERE goal_id=? AND goal_revision=?
      AND enabled=1 AND learning_enabled=1 AND blocked_reason IS NULL AND expires_at>?`).get(goalId,goalRevision,new Date(instant).toISOString());
    if(!scheduled)return;try{f.authority.assertStandingRule(scheduled.rule_id);}catch{return;}
    const context=f.learning.promptForGoal(goalId,goalRevision);return context?{instruction:context,skills:''}:undefined;
  }}});
  const api=await(source??=Promise.all(['src/main/db/migrations/background-schema.ts','src/main/modules/background/scheduler.ts'].map(loadSource))
    .then(parts=>Object.assign({},...parts)));
  f.db.exec(api.BACKGROUND_SCHEMA_SQL);
  const scheduler=api.createBackgroundScheduler(f.db,{goals:f.goals,authority:f.authority,exploration:f.exploration,taskService:f.tasks,
    learning:f.learning,now:()=>instant,uuid:()=>`learning-scheduler-${++n}`,foregroundBusy:()=>false});
  scheduler.reconcileInterrupted();t.after(()=>scheduler.dispose());
  const schedule=scheduler.configure(f.goal.id,f.goal.revision,{intervalMinutes:30,dailyRoundLimit:3,
    expiresAt:new Date(instant+7*86400000).toISOString(),protocol:'chat-completions',learningEnabled:true,autoPromote:true},1);
  return {...f,scheduler,schedule,advance:()=>{instant+=31*60000;},
    complete:async()=>{await scheduler.tick();return until(()=>{const row=scheduler.list()[0];return row.lastOutcome&&row.lastOutcome!=='running'&&row;},5000);}};
}

test('actual scheduled TLS pass auto-promotes Chinese text method and next slot model body adopts that exact immutable version',async t=>{
  const f=await setup(t);let result=await f.complete();assert.equal(result.lastOutcome,'completed',JSON.stringify(result));
  let skills=f.learning.list();assert.equal(skills.length,1);assert.equal(skills[0].title,'公开资料比较方法');assert.equal(skills[0].latestStatus,'active');
  const before=skills[0],modelRequests=f.server.requests.filter(request=>request.method==='POST');assert.equal(modelRequests.length,1);
  assert.equal(modelRequests[0].body.includes(before.id),false);assert.ok(modelRequests[0].body.includes('delepi-skill-candidate:v1'));
  f.advance();result=await f.complete();assert.equal(result.lastOutcome,'completed',JSON.stringify(result));
  const second=f.server.requests.filter(request=>request.method==='POST')[1];assert.ok(second.body.includes(before.id));
  assert.ok(second.body.includes(before.activeVersionId));assert.ok(second.body.includes(before.activeContentHash));
  assert.ok(second.body.includes('核对发布日期。'));
  skills=f.learning.list();assert.equal(skills[0].versionCount,1);assert.equal(skills[0].revision,before.revision);
  assert.equal(f.server.requests.length,4);assert.equal(f.authority.listApprovals().length,0);
  result=await f.scheduler.setEnabled(result.id,result.revision,false);assert.equal(result.state,'paused');
  f.advance();await f.scheduler.tick();assert.equal(f.server.requests.length,4);assert.equal(f.learning.promptForGoal(f.goal.id,f.goal.revision),'');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM muse_background_triggers').get().n,2);
});

test('standing permission revocation blocks next scheduled model request and removes learned prompt use',async t=>{
  const f=await setup(t),result=await f.complete();assert.equal(result.lastOutcome,'completed');
  assert.ok(f.learning.promptForGoal(f.goal.id,f.goal.revision).includes('公开资料比较方法'));
  const rule=f.authority.listRules().find(rule=>rule.id===result.ruleId);f.authority.revokeRule(rule.id,rule.revision);
  f.advance();await f.scheduler.tick();assert.equal(f.server.requests.length,2);assert.equal(f.scheduler.list()[0].state,'blocked');
  assert.equal(f.learning.promptForGoal(f.goal.id,f.goal.revision),'');assert.equal(f.learning.list()[0].versionCount,1);
});
