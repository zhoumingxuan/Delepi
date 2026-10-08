'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,until}=require('./fixture.cjs');
const {deferred}=require('../muse-m2-brokers/fixture.cjs');

test('review: stop closes its owned real socket even when the session lookup cannot be read',async t=>{
  const entered=deferred();let failSessionReads=false;
  const f=await fixture(t,{
    routes:{'/public':(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.write('pending');entered.resolve();}},
    serviceDatabase(db){return new Proxy(db,{get(target,key){
      if(key==='prepare')return sql=>{if(failSessionReads&&sql==='SELECT * FROM m2_exploration_sessions WHERE run_id=?')throw Error('synthetic stop lookup failure');return target.prepare(sql);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});},
  });
  const session=f.start(f.plan()),stopApprove=f.approveAll();t.after(()=>{stopApprove();failSessionReads=false;});
  await entered.promise;failSessionReads=true;
  await assert.doesNotReject(f.exploration.stopExploration(session.runId));
  assert.ok(f.server.connections.every(connection=>connection.closed));
  assert.equal(f.server.requests.length,1);
  failSessionReads=false;assert.equal(f.exploration.listExplorations()[0].state,'stopped');
  assert.equal(f.tasks.getRun(session.runId).state,'cancelled');
});

test('review: repeated stops drain one Run and do not rewrite a terminal receipt',async t=>{
  const f=await fixture(t),session=f.start(f.plan());
  await until(()=>f.authority.listApprovals().some(card=>card.state==='pending'));
  await Promise.all([f.exploration.stopExploration(session.runId),f.exploration.stopExploration(session.runId)]);
  const before=f.db.prepare('SELECT * FROM m2_exploration_sessions WHERE run_id=?').get(session.runId);
  await f.exploration.stopExploration(session.runId);
  assert.deepEqual(f.db.prepare('SELECT * FROM m2_exploration_sessions WHERE run_id=?').get(session.runId),before);
  assert.equal(f.server.requests.length,0);
  assert.equal(f.tasks.getRun(session.runId).state,'cancelled');
});
