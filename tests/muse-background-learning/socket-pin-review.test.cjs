'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),https=require('node:https');
const {loadSource,tlsFixture}=require('../muse-m2-brokers/fixture.cjs');
let source;
const api=()=>source??=loadSource('src/main/modules/brokers/pinned-http.ts');
function options(url){return {url:new URL(url),method:'GET',publicAddressOnly:false,signal:new AbortController().signal,
  timeoutMs:1000,maxWireBytes:1024,maxDocumentBytes:1024,beforeStart(){},beforeConnect(){}};}

for(const forceAll of [false,true])test(`native Node HTTP socket to its sole checked pin succeeds with production address comparison (${forceAll?'native all:true lookup contract':'fixed family'})`,async t=>{
  const diagnostics=[],server=http.createServer((_req,res)=>res.end('actual HTTP pin'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const transport=(await api()).createPinnedTransport({resolve:async()=>[{address:'127.0.0.1',family:4}],request:(input,callback)=>{
    assert.equal(input.family,4);assert.equal(input.autoSelectFamily,false);
    const lookup=input.lookup,req=http.request({...input,...(forceAll?{family:undefined,autoSelectFamily:true}:{}),lookup(host,settings,done){diagnostics.push({kind:'lookup',settings});return lookup(host,settings,done);}},callback);
    req.on('socket',socket=>{diagnostics.push({kind:'socket',connecting:socket.connecting,remoteAddress:socket.remoteAddress});
      socket.on('connect',()=>diagnostics.push({kind:'connect',connecting:socket.connecting,remoteAddress:socket.remoteAddress}));});
    req.on('error',error=>diagnostics.push({kind:'error',code:error.code,message:error.message}));return req;
  }});
  let result;try{result=await transport.request(options(`http://source.fixture.test:${server.address().port}/public`));}
  catch(error){t.diagnostic(JSON.stringify(diagnostics));throw error;}
  assert.equal(result.body.toString(),'actual HTTP pin');
  assert.equal(diagnostics.find(value=>value.kind==='lookup').settings.all===true,forceAll);
});

test('native Node TLS socket to its sole checked pin succeeds with production address comparison and fixture-only CA',async t=>{
  const diagnostics=[],server=await tlsFixture(t,{'/public':(_req,res)=>res.end('actual TLS pin')});
  const transport=(await api()).createPinnedTransport({resolve:async()=>[{address:'127.0.0.1',family:4}],request:(input,callback)=>{
    const lookup=input.lookup,req=https.request({...input,ca:server.cert,lookup(host,settings,done){diagnostics.push({kind:'lookup',settings});return lookup(host,settings,done);}},callback);
    req.on('socket',socket=>{diagnostics.push({kind:'socket',connecting:socket.connecting,remoteAddress:socket.remoteAddress});
      socket.on('connect',()=>diagnostics.push({kind:'connect',connecting:socket.connecting,remoteAddress:socket.remoteAddress}));
      socket.on('secureConnect',()=>diagnostics.push({kind:'secureConnect',connecting:socket.connecting,remoteAddress:socket.remoteAddress}));});
    req.on('error',error=>diagnostics.push({kind:'error',code:error.code,message:error.message}));return req;
  }});
  let result;try{result=await transport.request(options(`https://source.fixture.test:${server.port}/public`));}
  catch(error){t.diagnostic(JSON.stringify(diagnostics));throw error;}
  assert.equal(result.body.toString(),'actual TLS pin');assert.equal(server.requests.length,1);
});
