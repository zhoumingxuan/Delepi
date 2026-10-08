'use strict';
// Bounded synthetic hot-path probe; never connects to providers or the production database.
const {performance}=require('node:perf_hooks');
const {fixture}=require('../muse-m1-runtime/fixture.cjs');
(async()=>{
  const cleanup=[];const {service,db}=await fixture({after:fn=>cleanup.push(fn)});
  try {
    const root=service.beginRun('benchmark-synthetic');
    const context=service.beginAttempt(root,{taskId:'T',delegateCallId:'D'});
    const count=10000;const samples=[];let preparations=0;
    const prepare=db.prepare.bind(db);db.prepare=(sql)=>{preparations++;return prepare(sql);};
    for(let i=0;i<1000;i++)service.isCurrent(context);
    preparations=0;
    for(let sample=0;sample<5;sample++){
      const started=performance.now();
      for(let i=0;i<count;i++)if(!service.isCurrent(context))throw Error('Unexpected stale benchmark fixture');
      samples.push(Number((performance.now()-started).toFixed(3)));
    }
    service.requestStop(context);
    if(service.isCurrent(context)||!service.isCurrent(context,{allowStopping:true}))throw Error('Fresh state reads are required');
    console.log(JSON.stringify({scope:'synthetic-isCurrent-only',checks:count*5,sampleChecks:count,
      elapsedMs:samples,medianMs:[...samples].sort((a,b)=>a-b)[2],preparations},null,2));
  }finally{for(const fn of cleanup.reverse())await fn();}
})().catch(error=>{console.error(error);process.exitCode=1;});
