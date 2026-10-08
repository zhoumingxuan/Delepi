 'use strict';
const test=require('node:test');
const {harness,call,input,stream,final,assert,clone}=require('./harness.cjs');
function rawSurfaces(h,expected){
 assert.deepEqual(h.delegations.map(x=>x.rawArguments),expected,'real runDelegatedTask inputs');
 const declarations=h.rows.filter(x=>x.role==='assistant'&&x.payload.tool_calls);
 assert.equal(declarations.length,1);assert.deepEqual(declarations[0].payload.tool_calls.map(x=>x.function.arguments),expected);
 assert.deepEqual(h.events.filter(x=>x.name==='main-agent:tool-call').map(x=>x.p.arguments),expected);
 const ipc=h.events.find(x=>x.name==='assistant.message.done'&&x.p.message.toolCalls?.length);
 assert.deepEqual(ipc.p.message.toolCalls.map(x=>x.arguments),expected);
 assert.deepEqual(h.rows.filter(x=>x.role==='tool').map(x=>x.payload.arguments),expected);
 assert.deepEqual(h.requests[1].find(x=>x.role==='assistant'&&x.tool_calls).tool_calls.map(x=>x.function.arguments),expected);
}
test('A01 正常JSON保留原字串且各消费面一致',{timeout:5000},async t=>{
 const raw=' \n{ "taskname": "原串\\n转义", "n": 1e2, "z": -0, "a": "\\u4e2d" }\t';
 const tc=call('A',raw,'delegate_executor');const before=clone(tc);
 const h=harness(t,{mainTurns:[stream([tc]),stream([],'done')]});await h.runMain();
 rawSurfaces(h,[raw]);assert.deepEqual(tc,before);assert.equal(h.delegations.length,1);
 assert.equal(h.sessions[0].taskName,'原串\n转义');
});
test('A02 P01 包裹修复真正派发slice而非显示净化',{timeout:5000},async t=>{
 const clean=input('  sliced  '),raw='outside ```json\n'+clean+'\n``` tail';const tc=call('A',raw,'delegate_executor');const before=clone(tc);
 const h=harness(t,{mainTurns:[stream([tc]),stream([],'done')],executorTurns:[stream([],final())],integrate:true});
 await h.runMain();rawSurfaces(h,[clean]);assert.deepEqual(tc,before);assert.equal(h.logs[0].rawArguments,clean);
 assert.equal(h.logs[0].inputIssues,undefined);assert.equal(h.sessions[0].taskName,'sliced');assert.equal(h.sessions[0].status,'completed');
});
test('A03 不可修复一条导致整轮无派发直到上限',{timeout:5000},async t=>{
 for(const invalid of ['', 'not JSON', '{bad}', '{} {}']){
   const bad=stream([call('ok',input(),'delegate_executor'),call('bad',invalid,'delegate_executor'),call('u','{}','unknown')]);
   const h=harness(t,{mainTurns:[bad,bad,bad,bad]});await assert.rejects(h.runMain(),/参数校验失败超过重试上限/);
   assert.equal(h.delegations.length,0);assert.equal(h.rows.filter(x=>x.role==='tool').length,0);
   assert.equal(h.events.filter(x=>x.name==='main-agent:tool-call').length,0);
   assert.equal(h.rows.filter(x=>x.payload.tool_calls).length,0);assert.equal(h.requests.length,4);
   assert.deepEqual(h.delays.filter(x=>x===1000),[1000,1000,1000]);
   assert.equal(h.events.filter(x=>x.name==='main-agent:chunk'&&x.p.reset).length,3);
 }
});
test('A04 可解析非对象与缺字段仍走executor INVALID_INPUT',{timeout:5000},async t=>{
 const values=[['null','null 类型'],['[]','array 类型'],['123','number 类型'],['"text"','string 类型'],['{}','taskname 缺失']];
 for(const [raw,issue] of values){
   const h=harness(t,{mainTurns:[stream([call('A',raw,'delegate_executor')]),stream([],'done')],integrate:true});
   await h.runMain();assert.equal(h.delegations.length,1);assert.equal(h.delegations[0].rawArguments,raw);assert.equal(h.executorRequests.length,0);
   const result=h.logs[0].finalResult;assert.equal(result.success,false);assert.equal(result.code,'DELEGATED_TASK_INVALID_INPUT');assert.ok(result.message.includes(issue));
   assert.equal(h.events.filter(x=>x.name==='main-agent:chunk'&&x.p.reset).length,0);assert.equal(h.sessions[0].status,'failed');
 }
});
test('A05 空ID过滤且未知工具消息原语义',{timeout:5000},async t=>{
 const h=harness(t,{mainTurns:[stream([call('', 'invalid','delegate_executor'),call(' U ','anything','unknown'),call('A',input(),'delegate_executor')]),stream([],'done')]});
 await h.runMain();assert.equal(h.delegations.length,1);assert.deepEqual(h.events.filter(x=>x.name==='main-agent:tool-call').map(x=>x.p.callId),[' U ','A']);
 const u=h.rows.find(x=>x.role==='tool'&&x.payload.toolCallId===' U ');assert.equal(u.payload.arguments,'');assert.equal(u.payload.isError,true);
 assert.deepEqual(JSON.parse(u.payload.result),{success:false,message:'未知工具调用：unknown'});
 assert.deepEqual(h.events.find(x=>x.name==='tool.batch.completed').p.toolCallIds,[' U ','A']);
});
test('A06 P01 重复ID保留两个槽位参数不按ID覆盖',{timeout:5000},async t=>{
 const a=input('one'),b=input('two');const h=harness(t,{mainTurns:[stream([call('D','prefix '+a,'delegate_executor'),call('D','prefix '+b,'delegate_executor')]),stream([],'done')]});
 await h.runMain();assert.deepEqual(h.sessions.map(x=>x.taskName),['one','two']);
 const inputs=h.sessions.map(s=>h.delegations.find(x=>x.taskId===s.taskId)?.rawArguments);assert.deepEqual(inputs,[a,b]);
 assert.deepEqual(h.rows.find(x=>x.payload.tool_calls).payload.tool_calls.map(x=>x.function.arguments),[a,b]);
 assert.deepEqual(h.events.filter(x=>x.name==='main-agent:tool-call').map(x=>x.p.arguments),[a,b]);
 assert.deepEqual(h.rows.filter(x=>x.role==='tool').map(x=>x.payload.arguments).sort(),[a,b].sort());
 // Collision is upstream characteristic: only last session is addressed by delegateCallId.
 assert.equal(h.delegations.length,2);assert.equal(h.rows.filter(x=>x.role==='tool').length,2);
});
test('A07 参数/模型重试复位与取消优先不产生残留声明',{timeout:5000},async t=>{
 const h=harness(t,{mainTurns:[(opts)=>{opts.onChunk({delta:'old',content:'old',reasoningDelta:'old',reasoning:'old'});opts.onStreamRetry();opts.onChunk({delta:'',content:'',reasoningDelta:'new',reasoning:'new'});return stream([call('A','bad','delegate_executor')]);},stream([call('A',input(),'delegate_executor')]),stream([],'done')]});
 await h.runMain();assert.equal(h.delegations.length,1);assert.equal(h.rows.filter(x=>x.role==='tool').length,1);
 assert.ok(h.events.filter(x=>x.name==='main-agent:chunk'&&x.p.reset).length>=2);
 const declaration=h.rows.find(x=>x.payload.tool_calls);assert.equal(declaration.payload.content,'');assert.ok(!JSON.stringify(declaration.payload).includes('old'));assert.ok(!JSON.stringify(declaration.payload).includes('new'));assert.equal(h.rows.filter(x=>x.role==='assistant'&&!x.payload.tool_calls).at(-1).payload.content,'done');
 const c=new AbortController();const h2=harness(t,{mainTurns:[()=>{c.abort(new Error('cancel'));return stream([call('A','bad','delegate_executor')]);}]});
 await assert.rejects(h2.runMain({signal:c.signal}),/cancel|ABORTED/);assert.equal(h2.delegations.length,0);assert.equal(h2.delays.filter(x=>x===1000).length,0);
});
