'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { tlsFixture, deferred, SYNTHETIC_PUBLIC_ADDRESS, sha } = require('./fixture.cjs');
const { sourceApi, runtimeFixture } = require('./runtime-fixture.cjs');
const publicAnswer = async () => [{ address: SYNTHETIC_PUBLIC_ADDRESS, family: 4 }];
const code = expected => error => error.code === expected;
const options = signal => ({ url: new URL('https://source.fixture.test/public'), method: 'GET', publicAddressOnly: true,
  signal, timeoutMs: 500, maxWireBytes: 1000, maxDocumentBytes: 1000, beforeStart() {}, beforeConnect() {} });
const transportFor = (api, server, extras = {}) => api.createPinnedTransport({ resolve: publicAnswer, request: server.requestPinned, verifySocket: server.verifySocket, ...extras });
const globalAccount = f => f.ledger.listAccounts().find(value => value.scope === 'global');

test('public transport excludes special IPv4/IPv6 and encoded/local/userinfo URLs', async () => {
  const api = await sourceApi(), matrix = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/ip-boundaries.json')));
  for (const address of matrix.deniedAddresses) assert.equal(api.isPublicAddress(address), false, address);
  for (const url of matrix.deniedUrls) assert.throws(() => api.publicHttpsUrl(url), code('PUBLIC_URL_BLOCKED'), url);
  for (const address of ['93.184.216.34', '8.8.8.8', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(api.isPublicAddress(address), true);
  for (const address of ['192.0.2.1','198.51.100.1','203.0.113.1','2001:db8::1','3fff::1']) assert.equal(api.isPublicAddress(address), false);
});

test('mixed DNS answers are blocked before any socket and every supplied lookup uses the checked pin', async t => {
  const api = await sourceApi(), server = await tlsFixture(t, { '/public': (_req,res) => { res.writeHead(200, {'content-type':'text/plain'}); res.end('public'); } });
  const controller = new AbortController();
  const rejected = transportFor(api, server, { resolve: async () => [{ address: SYNTHETIC_PUBLIC_ADDRESS, family: 4 }, { address:'127.0.0.1', family:4 }] });
  await assert.rejects(rejected.request(options(controller.signal)), code('DNS_ADDRESS_BLOCKED'));
  assert.equal(server.connections.length, 0);
  const response = await transportFor(api, server).request(options(controller.signal));
  assert.equal(response.body.toString(), 'public'); assert.equal(server.requests.length, 1);
  assert.equal(server.connections[0].resolved.address, SYNTHETIC_PUBLIC_ADDRESS);
  assert.equal(server.connections[0].servername, 'source.fixture.test'); assert.equal(server.requests[0].headers.host, 'source.fixture.test');
  assert.equal(server.requests[0].headers.cookie, undefined); assert.equal(server.requests[0].headers.authorization, undefined);
});

test('default transport rejects an actual socket destination differing from its DNS pin', async t => {
  const api = await sourceApi(), server = await tlsFixture(t, { '/public': (_req,res) => { res.writeHead(200, {'content-type':'text/plain'}); res.end('unexpected'); } });
  const transport = api.createPinnedTransport({ resolve: publicAnswer, request: server.requestPinned });
  await assert.rejects(transport.request(options(new AbortController().signal)), code('SOCKET_ADDRESS_CHANGED'));
  assert.equal(server.requests.length, 0);
});

test('chunked overread is stopped without an unbounded body and gzip expansion has an independent limit', async t => {
  const api = await sourceApi();
  const server = await tlsFixture(t, {
    '/public': (_req,res) => { res.writeHead(200, {'content-type':'text/plain'}); res.end(Buffer.alloc(2000, 65)); },
    '/gzip': (_req,res) => { res.writeHead(200, {'content-type':'text/plain','content-encoding':'gzip'}); res.end(zlib.gzipSync(Buffer.alloc(2000, 65))); },
  });
  const transport = transportFor(api, server), initial = options(new AbortController().signal);
  await assert.rejects(transport.request(initial), error => error.code === 'WIRE_BYTES_EXCEEDED' && error.receivedBytes === 2000 && error.started === true);
  await assert.rejects(transport.request({ ...initial, url: new URL('https://source.fixture.test/gzip') }), error => error.code === 'DOCUMENT_BYTES_EXCEEDED' && error.receivedBytes < 1000);
  assert.equal(server.requests.length, 2);
});

test('successful compressed responses finish decoding after socket close and retain exact wire byte counts', async t => {
  const api = await sourceApi(), body = Buffer.from('Synthetic body '.repeat(25)), compressed = zlib.gzipSync(body);
  const server = await tlsFixture(t, { '/public': (_req,res) => { res.writeHead(200, {'content-type':'text/plain','content-encoding':'gzip'}); res.end(compressed); } });
  const result = await transportFor(api, server).request(options(new AbortController().signal));
  assert.deepEqual(result.body, body); assert.equal(result.receivedBytes, compressed.length);
});

test('whole-operation timeout covers delayed DNS and no socket is started when the DNS result arrives late', async t => {
  const api = await sourceApi(), dns = deferred(), server = await tlsFixture(t);
  const transport = transportFor(api, server, { resolve: () => dns.promise });
  let starts = 0;
  await assert.rejects(transport.request({ ...options(new AbortController().signal), timeoutMs: 20, beforeStart() { starts++; } }), error => error.code === 'REQUEST_TIMEOUT' && error.started);
  dns.resolve([{ address:SYNTHETIC_PUBLIC_ADDRESS,family:4 }]); await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1); assert.equal(server.connections.length, 0);
});

test('cancellation settles only after the real client request closes and starts no follow-up attempt', async t => {
  const api = await sourceApi(), seen = deferred(), server = await tlsFixture(t, { '/public': (_req,res) => { res.writeHead(200, {'content-type':'text/plain'}); res.write('part'); seen.resolve(); } });
  let clientClosed = false;
  const transport = transportFor(api, server, { request: (requestOptions,callback) => { const req=server.requestPinned(requestOptions,callback); req.once('close',()=>{clientClosed=true;}); return req; } });
  const controller = new AbortController(), pending = transport.request(options(controller.signal));
  await seen.promise; controller.abort();
  await assert.rejects(pending, code('CANCELLED')); assert.equal(clientClosed, true); assert.equal(server.requests.length, 1);
});

test('Fetch registers a real public snapshot and accounts a registered redirect as separate attempts', async t => {
  const f = await runtimeFixture(t), nextUrl = 'https://redirect.fixture.test/final', nextHash=sha(nextUrl);
  f.db.prepare("INSERT INTO m2_resources(id,goal_id,data_scope_id,kind,url,content_hash,size_bytes,revision,created_at) VALUES('redirect-source','goal-fixture','scope-fixture','public_url',?,?,0,1,?)").run(nextUrl,nextHash,new Date(f.now()).toISOString());
  f.snapshot.resources.push({id:'redirect-source',goalId:'goal-fixture',dataScopeId:'scope-fixture',kind:'public_url',url:nextUrl,contentHash:nextHash,sizeBytes:0,revision:1});
  f.db.prepare('UPDATE m2_run_scopes SET snapshot_json=? WHERE run_id=?').run(JSON.stringify(f.snapshot),f.context.runId);
  f.authorizeRule();
  const server = await tlsFixture(t, {
    '/public': (_req,res) => { res.writeHead(302, {location:nextUrl,'content-type':'text/plain'}); res.end('redirect'); },
    '/final': (_req,res) => { res.writeHead(200, {'content-type':'text/plain'}); res.end('Final public source'); },
  });
  const fetch = f.api.createFetchBroker(f.db,{transport:transportFor(f.api,server),registerSnapshot:f.file.registerSnapshot});
  const result = await fetch.fetch(f.session,'resource-fixture');
  assert.equal(result.finalUrl,nextUrl); assert.equal(result.resource.parentId,'redirect-source');
  assert.equal(server.requests.length,2); assert.equal(globalAccount(f).used.fetchRequests,2);
  assert.equal(globalAccount(f).used.storageBytes,Buffer.byteLength('Final public source'));
  const doc = await f.file.read(f.session,result.resource.id); assert.equal(doc.text,'Final public source');
  assert.equal(globalAccount(f).used.downloadBytes,Buffer.byteLength('redirect') + Buffer.byteLength(doc.text));
});

test('Fetch refuses an unregistered redirect after charging the completed first request', async t => {
  const f=await runtimeFixture(t);f.authorizeRule();
  const server=await tlsFixture(t,{'/public':(_req,res)=>{res.writeHead(302,{location:'https://unapproved.fixture.test/other'});res.end('move');}});
  const fetch=f.api.createFetchBroker(f.db,{transport:transportFor(f.api,server),registerSnapshot:f.file.registerSnapshot});
  await assert.rejects(fetch.fetch(f.session,'resource-fixture'),code('REDIRECT_SCOPE_BLOCKED'));
  assert.equal(server.requests.length,1);assert.equal(globalAccount(f).used.fetchRequests,1);assert.equal(globalAccount(f).reserved.fetchRequests,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_resources WHERE kind='public_snapshot'").get().n,0);
});

test('Fetch DNS failures are durable started attempts and DNS cancellation cannot refund the request', async t => {
  const f=await runtimeFixture(t);f.authorizeRule();
  let sawStarted=false;
  const failed=f.api.createFetchBroker(f.db,{transport:f.api.createPinnedTransport({resolve:async()=>{sawStarted=f.db.prepare("SELECT state FROM m2_operations ORDER BY created_at DESC").get().state==='started';throw Error('synthetic resolver failure');}}),registerSnapshot:f.file.registerSnapshot});
  await assert.rejects(failed.fetch(f.session,'resource-fixture'),code('DNS_FAILED'));
  assert.equal(sawStarted,true);assert.equal(globalAccount(f).used.fetchRequests,1);
  const dns=deferred(), entered=deferred();
  const waiting=f.api.createFetchBroker(f.db,{transport:f.api.createPinnedTransport({resolve:()=>{entered.resolve();return dns.promise;}}),registerSnapshot:f.file.registerSnapshot});
  const pending=waiting.fetch(f.session,'resource-fixture');await entered.promise;f.controller.abort();
  await assert.rejects(pending,code('CANCELLED'));assert.equal(globalAccount(f).used.fetchRequests,2);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_operations WHERE state='settled'").get().n,2);
  dns.resolve([{address:SYNTHETIC_PUBLIC_ADDRESS,family:4}]);await new Promise(resolve=>setImmediate(resolve));
});

test('Fetch receipts retain actual overread bytes and snapshot receipt faults retain written bytes as unknown', async t => {
  const f=await runtimeFixture(t);f.authorizeRule();
  const server=await tlsFixture(t,{'/public':(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end(Buffer.alloc(2000,65));}});
  const fetch=f.api.createFetchBroker(f.db,{transport:transportFor(f.api,server),registerSnapshot:f.file.registerSnapshot});
  await assert.rejects(fetch.fetch(f.session,'resource-fixture'),code('WIRE_BYTES_EXCEEDED'));
  assert.equal(globalAccount(f).used.downloadBytes,2000);assert.equal(globalAccount(f).used.fetchRequests,1);
  assert.equal(globalAccount(f).reserved.downloadBytes,0);
});

test('a native snapshot registration failure retains its file and unknown storage without a fake success', async t => {
  const f=await runtimeFixture(t);f.authorizeRule();
  f.db.exec("CREATE TRIGGER refuse_snapshot BEFORE INSERT ON m2_public_file_identity BEGIN SELECT RAISE(ABORT,'synthetic snapshot receipt failure'); END");
  const server=await tlsFixture(t,{'/public':(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('retained public bytes');}});
  const fetch=f.api.createFetchBroker(f.db,{transport:transportFor(f.api,server),registerSnapshot:f.file.registerSnapshot});
  await assert.rejects(fetch.fetch(f.session,'resource-fixture'),code('PUBLIC_SNAPSHOT_RECEIPT_UNKNOWN'));
  assert.equal(fs.readdirSync(f.publicRoot).length,1);assert.equal(globalAccount(f).reserved.storageBytes,Buffer.byteLength('retained public bytes'));
  assert.equal(globalAccount(f).used.fetchRequests,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_resources WHERE kind='public_snapshot'").get().n,0);
  assert.equal(f.db.prepare('SELECT state FROM m2_operations').get().state,'outcome_unknown');
});

test('Fetch waits for approval without a slot, ledger reservation or DNS; approval commits before resolver I/O', async t => {
  const f=await runtimeFixture(t), dns=deferred();
  const fetch=f.api.createFetchBroker(f.db,{ transport:f.api.createPinnedTransport({ resolve:async()=>{
    assert.equal(f.db.prepare("SELECT state FROM m2_operations").get().state,'started');
    assert.equal(f.concurrency.active,1);dns.resolve();throw Error('synthetic DNS only');
  }}),registerSnapshot:f.file.registerSnapshot });
  const pending=fetch.fetch(f.session,'resource-fixture');
  await new Promise(resolve=>setImmediate(resolve));
  const card=f.authority.listApprovals()[0];assert.equal(card.state,'pending');
  assert.equal(f.concurrency.active,0);assert.equal(f.ledger.listAccounts().length,0);assert.equal(f.clock.snapshot().branches.waitingUser,1);
  f.authority.decideApproval(card.id,card.revision,'once',1);
  await dns.promise;await assert.rejects(pending,code('DNS_FAILED'));
  assert.equal(globalAccount(f).used.fetchRequests,1);assert.equal(f.concurrency.active,0);
});

test('rejecting a pending Fetch and pre-cancelled Fetch issue no operation or DNS attempt', async t => {
  const f=await runtimeFixture(t);let resolves=0;
  const fetch=f.api.createFetchBroker(f.db,{ transport:f.api.createPinnedTransport({ resolve:async()=>{resolves++;return publicAnswer();} }),registerSnapshot:f.file.registerSnapshot });
  const pending=fetch.fetch(f.session,'resource-fixture');await new Promise(resolve=>setImmediate(resolve));
  const card=f.authority.listApprovals()[0];f.authority.decideApproval(card.id,card.revision,'reject',1);
  await assert.rejects(pending,code('APPROVAL_REJECTED'));
  assert.equal(resolves,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_operations').get().n,0);
  f.controller.abort();await assert.rejects(fetch.fetch(f.session,'resource-fixture'),code('CANCELLED'));
  assert.equal(resolves,0);assert.equal(f.ledger.listAccounts().length,0);
});

test('prepared work revoked while waiting for a slot never reaches DNS and its reservation is released', async t => {
  const f=await runtimeFixture(t),rule=f.authorizeRule();let resolves=0;
  const occupied=[await f.concurrency.acquire(new AbortController().signal),await f.concurrency.acquire(new AbortController().signal)];
  const fetch=f.api.createFetchBroker(f.db,{ transport:f.api.createPinnedTransport({ resolve:async()=>{resolves++;return publicAnswer();} }),registerSnapshot:f.file.registerSnapshot });
  const pending=fetch.fetch(f.session,'resource-fixture');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.concurrency.waiting,1);f.authority.revokeRule(rule.id,rule.revision);
  await assert.rejects(pending,code('CANCELLED'));assert.equal(f.concurrency.waiting,0);occupied[0]();occupied[1]();
  assert.equal(resolves,0);assert.equal(globalAccount(f).used.fetchRequests,0);assert.equal(globalAccount(f).reserved.fetchRequests,0);
  assert.ok(f.db.prepare('SELECT state FROM m2_budget_reservations').all().every(value=>value.state==='released'));
});

test('the whole-operation timeout also covers headers and body stalls after the TLS connection', async t => {
  const api=await sourceApi(), server=await tlsFixture(t,{
    '/headers':()=>{},
    '/body':(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.write('incomplete');},
  });
  const transport=transportFor(api,server),initial={...options(new AbortController().signal),timeoutMs:20};
  for(const pathname of ['/headers','/body'])await assert.rejects(transport.request({...initial,url:new URL('https://source.fixture.test'+pathname)}),code('REQUEST_TIMEOUT'));
  assert.equal(server.requests.length,2);
});

test('cancellation at the durable-start callback or before the DNS microtask issues no late resolver work',async()=>{
  const api=await sourceApi();let resolves=0;
  const transport=api.createPinnedTransport({resolve:async()=>{resolves++;return publicAnswer();}}),controller=new AbortController();
  const pending=transport.request({...options(controller.signal),beforeStart(){controller.abort();}});
  await assert.rejects(pending,code('CANCELLED'));await new Promise(resolve=>setImmediate(resolve));assert.equal(resolves,0);
  const nextController=new AbortController(),next=transport.request(options(nextController.signal));nextController.abort();
  await assert.rejects(next,code('CANCELLED'));await new Promise(resolve=>setImmediate(resolve));assert.equal(resolves,0);
});
