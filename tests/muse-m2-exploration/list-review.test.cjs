'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,until}=require('./fixture.cjs');

test('review: a full history refresh uses bounded SQL and preserves live approval and public DTO facts',async t=>{
  const queries=[];
  const f=await fixture(t,{serviceDatabase(db){return new Proxy(db,{get(target,key){
    if(key==='prepare')return sql=>{queries.push(sql);return target.prepare(sql);};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});}});
  const plan=f.plan(),live=f.start(plan);
  await until(()=>f.authority.listApprovals().some(card=>card.state==='pending'));
  f.db.transaction(()=>{
    for(let i=0;i<205;i++){
      const id=`historical-plan-${String(i).padStart(3,'0')}`;
      f.db.prepare("INSERT INTO m2_exploration_plans SELECT ?,goal_id,goal_revision,caller_id,snapshot_json,revision,'started',expires_at,created_at FROM m2_exploration_plans WHERE id=?").run(id,plan.id);
      f.db.prepare("INSERT INTO m2_exploration_sessions(id,plan_id,goal_id,run_id,state,source_count,created_at,settled_at) VALUES(?,?,?,?,'completed',1,?,?)")
        .run(`historical-session-${i}`,id,f.goal.id,`historical-run-${i}`,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z');
    }
  })();
  queries.length=0;
  const rows=f.exploration.listExplorations();
  assert.equal(rows.length,200);
  assert.ok(queries.length<=2,`history refresh issued ${queries.length} SQL queries`);
  assert.equal(rows[0].runId,live.runId);
  assert.equal(rows[0].state,'waiting_approval');
  assert.equal(rows[0].pendingApprovalCount,1);
  assert.ok(rows[0].absoluteRemainingMilliseconds>0);
  for(const row of rows){
    assert.equal(row.goalRevision,f.goal.revision);
    assert.equal(row.sourceTotal,1);
    assert.deepEqual(row.destination,plan.destination);
    assert.equal(JSON.stringify(row).includes('configHash'),false);
  }
  queries.length=0;
  const withoutClock=({activeRemainingMilliseconds,absoluteRemainingMilliseconds,...facts})=>facts;
  assert.deepEqual(f.exploration.listExplorations(f.goal.id).map(withoutClock),rows.map(withoutClock));
  assert.ok(queries.length<=2);
  await f.exploration.stopExploration(live.runId);
  const terminal=f.exploration.listExplorations()[0];
  assert.equal(terminal.state,'stopped');
  assert.equal(terminal.pendingApprovalCount,0);
});
