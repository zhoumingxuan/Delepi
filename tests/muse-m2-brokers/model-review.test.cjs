'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tlsFixture, SYNTHETIC_PUBLIC_ADDRESS } = require('./fixture.cjs');
const { runtimeFixture } = require('./runtime-fixture.cjs');
const code = expected => error => error.code === expected;
const globalAccount = f => f.ledger.listAccounts().find(value => value.scope === 'global');
async function modelFixture(t, responses) {
  const f = await runtimeFixture(t, { limits: { tokenUnits: 100000 } }); f.authorizeRule();
  let calls = 0;
  const send = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(responses[calls++]));
  };
  const server = await tlsFixture(t, { '/v1/responses': send, '/v1/chat/completions': send });
  const model = f.api.createModelBroker(f.db, {
    transport: f.api.createPinnedTransport({ resolve: async () => [{ address: SYNTHETIC_PUBLIC_ADDRESS, family: 4 }],
      request: server.requestPinned, verifySocket: server.verifySocket }),
    resolveDestination: () => ({ endpoint: 'https://model.fixture.test/v1', model: 'synthetic-model',
      apiKey: 'synthetic-provider-secret', revision: 1, configHash: 'opaque-secret-hash' }),
    verifyDocument: f.file.verifyDocument, verifyAddition() { throw Error('No additions in response review fixture'); },
  });
  return { ...f, server, invoke: protocol => model.invoke(f.session, {
    anchorRef: 'output-anchor', destinationRef: 'model-fixture', protocol, documents: [], additions: [],
  }) };
}
const output = [{ type: 'message', content: [{ type: 'output_text', text: 'Partial text must not become a completed report' }] }];

test('Responses explicit incomplete/failed/nonterminal states reject partial text and settle reported token usage', async t => {
  const cases = [
    ['incomplete', 'MODEL_RESPONSE_INCOMPLETE'], ['failed', 'MODEL_RESPONSE_FAILED'],
    ['cancelled', 'MODEL_RESPONSE_FAILED'], ['in_progress', 'MODEL_RESPONSE_INCOMPLETE'], ['queued', 'MODEL_RESPONSE_INCOMPLETE'],
  ];
  const f = await modelFixture(t, cases.map(([status]) => ({ status, output, usage: { input_tokens: 11, output_tokens: 13 } })));
  for (const [, expected] of cases) await assert.rejects(f.invoke('responses'), code(expected));
  assert.equal(f.server.requests.length, cases.length); assert.equal(globalAccount(f).used.modelRequests, cases.length);
  assert.equal(globalAccount(f).used.tokenUnits, 24 * cases.length); assert.equal(globalAccount(f).reserved.tokenUnits, 0);
  assert.ok(f.db.prepare('SELECT result_kind FROM m2_operations').all().every(row => row.result_kind === 'failed'));
});

test('CC explicit truncation/filter/tool outcomes reject text rather than publish a complete report', async t => {
  const cases = [
    ['length', 'MODEL_RESPONSE_INCOMPLETE'], ['content_filter', 'MODEL_RESPONSE_INCOMPLETE'], [null, 'MODEL_RESPONSE_INCOMPLETE'],
    ['tool_calls', 'MODEL_RESPONSE_INVALID'], ['function_call', 'MODEL_RESPONSE_INVALID'],
  ];
  const f = await modelFixture(t, cases.map(([finish_reason]) => ({ choices: [{ finish_reason, message: { content: 'Partial report' } }],
    usage: { prompt_tokens: 7, completion_tokens: 9 } })));
  for (const [, expected] of cases) await assert.rejects(f.invoke('chat-completions'), code(expected));
  assert.equal(f.server.requests.length, cases.length); assert.equal(globalAccount(f).used.tokenUnits, 16 * cases.length);
  assert.equal(globalAccount(f).reserved.tokenUnits, 0);
});

test('Responses message outcome must also be complete even if the parent response claims completion', async t => {
  const f = await modelFixture(t, [{ status: 'completed', output: [{ ...output[0], status: 'incomplete' }],
    usage: { input_tokens: 4, output_tokens: 6 } }]);
  await assert.rejects(f.invoke('responses'), code('MODEL_RESPONSE_INCOMPLETE'));
  assert.equal(globalAccount(f).used.tokenUnits, 10); assert.equal(globalAccount(f).reserved.tokenUnits, 0);
});

test('an explicit provider error cannot be masked by compatible response text and preserves known usage', async t => {
  const f = await modelFixture(t, [{ error: { message: 'Synthetic sensitive provider detail' }, choices: [{ message: { content: 'Stale report' } }],
    usage: { prompt_tokens: 3, completion_tokens: 5 } }]);
  await assert.rejects(f.invoke('chat-completions'), code('MODEL_RESPONSE_FAILED'));
  assert.equal(globalAccount(f).used.tokenUnits, 8); assert.equal(globalAccount(f).reserved.tokenUnits, 0);
  assert.equal(JSON.stringify(f.db.prepare('SELECT details_json FROM activity_events').all()).includes('Synthetic sensitive provider detail'), false);
});

test('malformed provider JSON shapes return a stable broker error and keep unknown spending held', async t => {
  const malformed = [null, [], { choices: { 0: { message: { content: 'Object posing as choices' } } } },
    { output: [null] }, { output: [{ type: 'message', content: [null] }] },
    { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Partial' }, { type: 'output_text', text: 42 }] }] }];
  const f = await modelFixture(t, malformed);
  for (let index = 0; index < malformed.length; index++) await assert.rejects(f.invoke(index < 3 ? 'chat-completions' : 'responses'), code('MODEL_RESPONSE_INVALID'));
  assert.equal(f.server.requests.length, malformed.length); assert.equal(globalAccount(f).used.modelRequests, malformed.length);
  assert.equal(globalAccount(f).used.tokenUnits, 0); assert.ok(globalAccount(f).reserved.tokenUnits > 0);
});

test('completed provider outcomes and providers omitting optional outcome fields remain compatible', async t => {
  const f = await modelFixture(t, [
    { status: 'completed', output }, { output },
    { choices: [{ finish_reason: 'stop', message: { content: 'Complete report' } }] },
    { choices: [{ message: { content: 'Compatible report' } }] },
  ]);
  for (const protocol of ['responses', 'responses', 'chat-completions', 'chat-completions']) assert.ok((await f.invoke(protocol)).text);
  assert.equal(f.server.requests.length, 4); assert.equal(globalAccount(f).used.modelRequests, 4);
});
