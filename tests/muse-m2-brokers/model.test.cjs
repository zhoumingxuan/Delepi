'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tlsFixture, SYNTHETIC_PUBLIC_ADDRESS, deferred, sha } = require('./fixture.cjs');
const { runtimeFixture } = require('./runtime-fixture.cjs');
const code = expected => error => error.code === expected;
const globalAccount = f => f.ledger.listAccounts().find(value => value.scope === 'global');
const publicAnswer = async () => [{ address:SYNTHETIC_PUBLIC_ADDRESS,family:4 }];
const transportFor = (f,server,extra={}) => f.api.createPinnedTransport({ resolve:publicAnswer,request:server.requestPinned,verifySocket:server.verifySocket,...extra });
const syntheticDestination = { endpoint:'https://model.fixture.test/v1',model:'synthetic-model',apiKey:'synthetic-provider-secret',revision:1,configHash:'opaque-secret-hash' };
const inputFor = document => ({ anchorRef:'output-anchor',destinationRef:'model-fixture',protocol:'chat-completions',documents:[document],additions:[] });
function modelFor(f,server,extra={}) {
  return f.api.createModelBroker(f.db,{ transport:transportFor(f,server,extra),resolveDestination:()=>syntheticDestination,verifyDocument:f.file.verifyDocument,
    verifyAddition(){throw new f.api.BrokerError('PUBLIC_ADDITION_NOT_MINTED');} });
}
async function documentFor(f,server) {
  const fetch=f.api.createFetchBroker(f.db,{ transport:transportFor(f,server),registerSnapshot:f.file.registerSnapshot });
  const saved=await fetch.fetch(f.session,'resource-fixture');return f.file.read(f.session,saved.resource.id);
}

test('public CC model sends only minted public context, exact destination credential and records real known usage', async t => {
  const f=await runtimeFixture(t,{ limits:{tokenUnits:100000} });f.authorizeRule();
  const server=await tlsFixture(t,{
    '/public':(_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<html><style>PRIVATE_STYLE_MARKER</style><script>NEVER_EXECUTE_THIS()</script><p>公开资料</p></html>');},
    '/v1/chat/completions':(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'公开研究报告'}}],usage:{prompt_tokens:10,completion_tokens:20}}));},
  });
  const document=await documentFor(f,server),result=await modelFor(f,server).invoke(f.session,inputFor(document));
  assert.equal(result.text,'公开研究报告');assert.deepEqual(result.usage,{inputTokens:10,outputTokens:20});
  const request=server.requests.find(value=>value.path==='/v1/chat/completions'),body=JSON.parse(request.body);
  assert.equal(request.headers.authorization,'Bearer synthetic-provider-secret');assert.equal(request.headers.host,'model.fixture.test');assert.equal(request.headers.cookie,undefined);
  assert.equal(body.stream,false);assert.equal(body.messages.length,1);assert.equal(body.tools,undefined);
  assert.ok(body.messages[0].content.includes('https://source.fixture.test/public'));
  assert.ok(body.messages[0].content.includes(document.contentHash));assert.equal(body.messages[0].content.includes('NEVER_EXECUTE_THIS'),false);
  assert.equal(body.messages[0].content.includes('PRIVATE_STYLE_MARKER'),false);
  assert.equal(globalAccount(f).used.modelRequests,1);assert.equal(globalAccount(f).used.tokenUnits,30);assert.equal(globalAccount(f).reserved.tokenUnits,0);
  const activity=f.db.prepare('SELECT details_json FROM activity_events').all().map(value=>value.details_json).join('\n');
  assert.equal(activity.includes('synthetic-provider-secret'),false);assert.equal(activity.includes(document.text),false);
});

test('public Responses use store:false and no previous session; absent usage remains reserved unknown', async t => {
  const f=await runtimeFixture(t,{limits:{tokenUnits:100000}});f.authorizeRule();
  const server=await tlsFixture(t,{
    '/public':(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('Public response source');},
    '/v1/responses':(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'Responses report'}]}]}));},
  });
  const document=await documentFor(f,server),result=await modelFor(f,server).invoke(f.session,{...inputFor(document),protocol:'responses'});
  const request=server.requests.find(value=>value.path==='/v1/responses'),body=JSON.parse(request.body);
  assert.equal(result.text,'Responses report');assert.equal(result.usage,undefined);assert.equal(body.store,false);assert.equal(body.previous_response_id,undefined);
  assert.equal(body.input.length,1);assert.equal(body.tools,undefined);
  assert.equal(globalAccount(f).used.modelRequests,1);assert.equal(globalAccount(f).used.tokenUnits,0);
  assert.equal(globalAccount(f).reserved.tokenUnits,Buffer.byteLength(request.body)+2048);
});

test('hand-crafted document clones and unconfirmed additions cannot reach any model or create a model reservation', async t => {
  const f=await runtimeFixture(t,{limits:{tokenUnits:100000}});f.authorizeRule();
  const server=await tlsFixture(t,{'/public':(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('Public');}});
  const document=await documentFor(f,server),model=modelFor(f,server);
  const clone={...document,text:'Private chat history',contentHash:sha('Private chat history')};
  await assert.rejects(model.invoke(f.session,inputFor(clone)),code('PUBLIC_DOCUMENT_NOT_MINTED'));
  await assert.rejects(model.invoke(f.session,{...inputFor(document),additions:[{id:'unconfirmed',text:'Private attachment',contentHash:sha('Private attachment'),goalId:'goal-fixture',dataScopeId:'scope-fixture',classification:'public'}]}),code('PUBLIC_ADDITION_NOT_MINTED'));
  assert.equal(server.requests.length,1);assert.equal(globalAccount(f).used.modelRequests,0);assert.equal(globalAccount(f).reserved.modelRequests,0);
});

test('model redirects never forward credentials and provider failures make one charged attempt without hidden retries', async t => {
  const f=await runtimeFixture(t,{limits:{tokenUnits:100000}});f.authorizeRule();let providerCalls=0;
  const server=await tlsFixture(t,{
    '/public':(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('Public');},
    '/v1/chat/completions':(_req,res)=>{providerCalls++;res.writeHead(providerCalls===1?302:500,{location:'https://source.fixture.test/public','content-type':'application/json'});res.end('{}');},
  });
  const document=await documentFor(f,server),model=modelFor(f,server);
  await assert.rejects(model.invoke(f.session,inputFor(document)),code('MODEL_REDIRECT_BLOCKED'));
  assert.equal(providerCalls,1);assert.equal(server.requests.length,2);assert.equal(globalAccount(f).used.modelRequests,1);
  await assert.rejects(model.invoke(f.session,inputFor(document)),code('MODEL_HTTP_STATUS_FAILED'));
  assert.equal(providerCalls,2);assert.equal(server.requests.length,3);assert.equal(globalAccount(f).used.modelRequests,2);
  assert.ok(globalAccount(f).reserved.tokenUnits>0);
});

test('revocation during model DNS aborts before provider connect and keeps the started attempt accounted', async t => {
  const f=await runtimeFixture(t,{limits:{tokenUnits:100000}}),rule=f.authorizeRule();
  const server=await tlsFixture(t,{'/public':(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('Public');}});
  const document=await documentFor(f,server),dns=deferred(),entered=deferred();
  const model=modelFor(f,server,{resolve:()=>{entered.resolve();return dns.promise;}});
  const pending=model.invoke(f.session,inputFor(document));await entered.promise;f.authority.revokeRule(rule.id,rule.revision);
  await assert.rejects(pending,code('CANCELLED'));dns.resolve([{address:SYNTHETIC_PUBLIC_ADDRESS,family:4}]);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(server.requests.length,1);assert.equal(globalAccount(f).used.modelRequests,1);assert.ok(globalAccount(f).reserved.tokenUnits>0);
});

test('eight large public documents are summarized from bounded UTF-8 excerpts within the default token account', async t => {
  const f=await runtimeFixture(t,{limits:{tokenUnits:100000,downloadBytes:5*1024*1024,storageBytes:5*1024*1024,maxDocumentBytes:1024*1024}});f.authorizeRule();
  const server=await tlsFixture(t,{
    '/public':(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('你'.repeat(40000));},
    '/v1/chat/completions':(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'Bounded report'}}],usage:{prompt_tokens:100,completion_tokens:20}}));},
  });
  const documents=[];for(let i=0;i<8;i++)documents.push(await documentFor(f,server));
  const result=await modelFor(f,server).invoke(f.session,{...inputFor(documents[0]),documents});
  const request=server.requests.find(value=>value.path==='/v1/chat/completions'),body=JSON.parse(request.body);
  assert.equal(result.text,'Bounded report');assert.ok(Buffer.byteLength(request.body)+2048<=100000);assert.ok(body.messages[0].content.includes('有界摘录'));
  assert.equal(body.messages[0].content.includes('\ufffd'),false);assert.equal(globalAccount(f).used.fetchRequests,8);assert.equal(globalAccount(f).used.modelRequests,1);
});

test('an explicitly configured local HTTP model uses only its exact trusted destination', async t => {
  const http=require('node:http'),f=await runtimeFixture(t,{limits:{tokenUnits:100000}});f.authorizeRule();
  const requests=[],server=http.createServer(async(req,res)=>{const parts=[];for await(const part of req)parts.push(part);requests.push({url:req.url,headers:req.headers,body:Buffer.concat(parts).toString()});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'Local public report'}}],usage:{prompt_tokens:5,completion_tokens:7}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port;
  const model=f.api.createModelBroker(f.db,{ resolveDestination:()=>({...syntheticDestination,endpoint:`http://127.0.0.1:${port}/v1`}),verifyDocument:f.file.verifyDocument,verifyAddition(){throw Error('none');} });
  const result=await model.invoke(f.session,{...inputFor(null),documents:[]});
  assert.equal(result.text,'Local public report');assert.equal(requests.length,1);assert.equal(requests[0].url,'/v1/chat/completions');
  assert.equal(requests[0].headers.authorization,'Bearer synthetic-provider-secret');assert.equal(globalAccount(f).used.modelRequests,1);assert.equal(globalAccount(f).used.tokenUnits,12);
});

test('changing the trusted model configuration after approval but during DNS sends no credential', async t => {
  const f=await runtimeFixture(t,{limits:{tokenUnits:100000}});f.authorizeRule();
  const server=await tlsFixture(t),dns=deferred(),entered=deferred();let changed=false;
  const model=f.api.createModelBroker(f.db,{ transport:transportFor(f,server,{resolve:()=>{entered.resolve();return dns.promise;}}),
    resolveDestination:()=>({...syntheticDestination,...(changed?{revision:2,configHash:'new-config'}:{})}),verifyDocument:f.file.verifyDocument,verifyAddition(){throw Error('none');} });
  const pending=model.invoke(f.session,{...inputFor(null),documents:[]});await entered.promise;changed=true;
  dns.resolve([{address:SYNTHETIC_PUBLIC_ADDRESS,family:4}]);await assert.rejects(pending,code('DESTINATION_CHANGED'));
  assert.equal(server.connections.length,0);assert.equal(globalAccount(f).used.modelRequests,1);assert.ok(globalAccount(f).reserved.tokenUnits>0);
});
