const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { getEventListeners } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

// Bundle production code; all provider/tool/Electron boundaries are synthetic.
const sourceRoot = process.env.MUSE_TEST_SOURCE_ROOT || path.resolve(__dirname, '../..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'delepi-muse-adapter-'));
const entry = [
  'src/main/modules/llm/adapters/adapter-factory.ts',
  'src/main/modules/executor-agent/executor-task-record-store.ts',
  'src/main/modules/executor-agent/executor-system-prompt.ts',
].map((file) => `export * from ${JSON.stringify(path.join(sourceRoot, file))};`).join('\n');
globalThis.__museRuntimeTest = {};
const exportsReady = esbuild.build({
  stdin: { contents: entry, resolveDir: sourceRoot, sourcefile: 'synthetic-entry.ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{
    name: 'synthetic-runtime-boundaries',
    setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'synthetic' }));
      build.onResolve({ filter: /(?:^|\/)openai-client$/ }, () => ({ path: 'openai-client', namespace: 'synthetic' }));
      build.onResolve({ filter: /(?:^|\/)executor-registry$/ }, () => ({ path: 'executor-registry', namespace: 'synthetic' }));
      build.onResolve({ filter: /(?:^|\/)tasks\/task-service$/ }, () => ({ path: 'task-service', namespace: 'synthetic' }));
      build.onLoad({ filter: /.*/, namespace: 'synthetic' }, ({ path: key }) => ({
        contents: key === 'electron'
          ? `export const app = {isPackaged:false,getPath:()=>${JSON.stringify(fixtureRoot)}};`
          : key === 'task-service'
            ? 'export const getTaskService = () => {throw new Error("No persistence allowed in M0 adapter fixture");};'
          : key === 'openai-client'
            ? 'export const streamChat = (...args) => globalThis.__museRuntimeTest.streamChat(...args);'
            : 'export const getDynamicExecutorToolMeta = () => null;',
        loader: 'js',
      }));
    },
  }],
}).then((result) => {
  const filename = path.join(fixtureRoot, 'runtime.cjs');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded._compile(result.outputFiles[0].text, loaded.filename);
  return loaded.exports;
});

const nativeFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = nativeFetch;
  delete globalThis.__museRuntimeTest;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});
const config = (signal) => ({
  api: { baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic-only', model: 'synthetic' },
  thinkingLevel: '', systemMessage: 'synthetic instruction', signal,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const makeSession = (api, label) => {
  const identity = { conversationId: label, delegateCallId: 'delegate', taskId: 'task', messageId: 'msg', taskName: label };
  return { identity, session: api.beginExecutorTaskRecord(identity) };
};
const entries = (api, identity) => api.queryExecutorTaskRecord(identity).entries;

test('pre-aborted initialization starts no protocol request', async () => {
  const api = await exportsReady;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('', { status: 200 }); };
  const controller = new AbortController();
  const reason = new Error('synthetic cancel');
  controller.abort(reason);
  await assert.rejects(api.initAdapterWithFallback(config(controller.signal)), (error) => error === reason);
  assert.equal(calls, 0);
});

test('cancelled active probe aborts fetch, closes candidate and skips fallback', async () => {
  const api = await exportsReady;
  const started = deferred();
  const controller = new AbortController();
  const reason = new Error('synthetic active cancel');
  const requests = [];
  const prototype = Object.getPrototypeOf(Object.getPrototypeOf(api.createProtocolAdapter('responses')));
  const realClose = prototype.close;
  let closeCount = 0;
  prototype.close = function () { closeCount++; return realClose.call(this); };
  globalThis.fetch = (url, options) => {
    requests.push(url);
    started.resolve(options.signal);
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  try {
    const pending = api.initAdapterWithFallback(config(controller.signal));
    const requestSignal = await started.promise;
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(requestSignal.aborted, true);
    assert.equal(requests.length, 1);
    assert.equal(closeCount, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally { prototype.close = realClose; }
});

test('cancellation concurrent with unsupported protocol prevents CC fallback', async () => {
  const api = await exportsReady;
  const controller = new AbortController();
  const reason = new Error('synthetic fallback cancel');
  let calls = 0;
  globalThis.fetch = async () => { calls++; controller.abort(reason); return new Response('', { status: 404 }); };
  await assert.rejects(api.initAdapterWithFallback(config(controller.signal)), (error) => error === reason);
  assert.equal(calls, 1);
});

test('probe resolving despite abort cannot transfer adapter ownership', async () => {
  const api = await exportsReady;
  const controller = new AbortController();
  const reason = new Error('synthetic late probe cancel');
  let bodyCancelled = false;
  globalThis.fetch = async () => {
    controller.abort(reason);
    return { status: 200, body: { cancel: async () => { bodyCancelled = true; } } };
  };
  await assert.rejects(api.initAdapterWithFallback(config(controller.signal)), (error) => error === reason);
  assert.equal(bodyCancelled, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('normal Responses 404 falls back to usable CC and close stays idempotent', async () => {
  const api = await exportsReady;
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(url); return new Response('', { status: url.endsWith('/responses') ? 404 : 200 }); };
  const setup = await api.initAdapterWithFallback(config());
  assert.equal(setup.protocol, 'cc');
  assert.deepEqual(urls.map((url) => url.split('/').pop()), ['responses', 'completions']);
  setup.adapter.close();
  setup.adapter.close();
  await assert.rejects(setup.adapter.sendMessage([], { multimodal: false }), /closed/);
});

for (const protocol of ['cc', 'responses']) {
  test(`explicit ${protocol} uses only the selected endpoint`, async () => {
    const api = await exportsReady;
    const urls = [];
    globalThis.fetch = async (url) => { urls.push(url); return new Response('', { status: 200 }); };
    const setup = await api.initAdapterWithFallback(config(), protocol);
    assert.equal(setup.protocol, protocol);
    assert.deepEqual(urls.map((url) => url.split('/').pop()), [protocol === 'cc' ? 'completions' : 'responses']);
    setup.adapter.close();
  });

  test(`explicit ${protocol} failure closes the candidate and never falls back`, async () => {
    const api = await exportsReady;
    const urls = [];
    const prototype = Object.getPrototypeOf(Object.getPrototypeOf(api.createProtocolAdapter(protocol)));
    const realClose = prototype.close;
    let closes = 0;
    prototype.close = function () { closes++; return realClose.call(this); };
    globalThis.fetch = async (url) => { urls.push(url); return new Response('', { status: 404 }); };
    try {
      await assert.rejects(api.initAdapterWithFallback(config(), protocol), (error) => error.name === 'ModelApiAbortError');
      assert.equal(urls.length, 1);
      assert.equal(closes, 1);
    } finally { prototype.close = realClose; }
  });

  test(`explicit ${protocol} preserves cancellation and releases the candidate`, async () => {
    const api = await exportsReady;
    const started = deferred();
    const controller = new AbortController();
    const reason = new Error('synthetic explicit protocol cancellation');
    let calls = 0;
    globalThis.fetch = (url, options) => {
      calls++;
      started.resolve();
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    };
    const pending = api.initAdapterWithFallback(config(controller.signal), protocol);
    await started.promise;
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(calls, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

test('both unsupported protocols keep the original API error classification', async () => {
  const api = await exportsReady;
  globalThis.fetch = async () => new Response('', { status: 404 });
  await assert.rejects(api.initAdapterWithFallback(config()), (error) => error.name === 'ModelApiAbortError' && error.message.includes('Responses') && error.message.includes('Chat Completions'));
});

test('Responses transport rejection clears its long timeout and task listener', async () => {
  const api = await exportsReady;
  globalThis.fetch = async () => new Response('', { status: 200 });
  const adapter = api.createProtocolAdapter('responses');
  await adapter.init(config());
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const outstanding = new Set();
  globalThis.setTimeout = (...args) => { const handle = realSetTimeout(...args); outstanding.add(handle); return handle; };
  globalThis.clearTimeout = (handle) => { outstanding.delete(handle); return realClearTimeout(handle); };
  const controller = new AbortController();
  try {
    globalThis.fetch = async () => { throw new Error('synthetic transport failure'); };
    for (let i = 0; i < 3; i++) {
      await assert.rejects(adapter.executeStreamRequest({}, controller.signal), /synthetic transport failure/);
      assert.equal(outstanding.size, 0);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }
  } finally {
    for (const handle of outstanding) realClearTimeout(handle);
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    adapter.close();
  }
});

test('CC rejects an aborted partial final before finished/tool callbacks', async () => {
  const api = await exportsReady;
  globalThis.fetch = async () => new Response('', { status: 200 });
  const adapter = api.createProtocolAdapter('cc');
  await adapter.init(config());
  const controller = new AbortController();
  const reason = new Error('synthetic partial cancel');
  let callbacks = 0;
  adapter.onFinished(() => callbacks++);
  adapter.onToolCall(() => { callbacks++; });
  globalThis.__museRuntimeTest.streamChat = async () => {
    controller.abort(reason);
    return { content: '{"success":true}', reasoning: '', toolCalls: [], finishReason: 'stop', assistantMessage: { role: 'assistant', content: '{"success":true}' } };
  };
  await assert.rejects(adapter.sendMessage([], { multimodal: false, signal: controller.signal }), (error) => error === reason);
  assert.equal(callbacks, 0);
  adapter.close();
});

test('Responses active stream cancellation rejects, releases reader, timer and listener', async () => {
  const api = await exportsReady;
  globalThis.fetch = async () => new Response('', { status: 200 });
  const adapter = api.createProtocolAdapter('responses');
  await adapter.init(config());
  const controller = new AbortController();
  const reason = new Error('synthetic Responses stream cancel');
  const started = deferred();
  let finished = 0;
  let readerAborted = false;
  adapter.onFinished(() => finished++);
  globalThis.fetch = async (url, options) => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"delta":"partial"}\n\n'));
      options.signal.addEventListener('abort', () => { readerAborted = true; stream.error(options.signal.reason); }, { once: true });
      started.resolve();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const pending = adapter.sendMessage([{ role: 'user', content: 'synthetic' }], { multimodal: false, signal: controller.signal });
  await started.promise;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(readerAborted, true);
  assert.equal(finished, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  adapter.close();
});

test('Responses keeps text/tool pairing and stateful incremental inbox semantics', async () => {
  const api = await exportsReady;
  globalThis.fetch = async () => new Response('', { status: 200 });
  const adapter = api.createProtocolAdapter('responses');
  await adapter.init(config());
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    const output = requests.length === 1 ? [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'provisional final' }] },
      { type: 'function_call', call_id: 'same-id', name: 'synthetic_tool', arguments: '{}' },
    ] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'after tool' }] }];
    const data = JSON.stringify({ response: { id: `response-${requests.length}`, store: true, output } });
    return new Response(`event: response.completed\ndata: ${data}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const messages = [{ role: 'user', content: 'initial' }];
  const first = await adapter.sendMessage(messages, { multimodal: false });
  assert.equal(first.content, 'provisional final');
  assert.equal(first.toolCalls[0].id, 'same-id');
  messages.push(first.assistantMessage, { role: 'tool', tool_call_id: 'same-id', content: 'synthetic result' });
  assert.equal(adapter.insertMessage({ role: 'user', content: 'new inbox' }).accepted, true);
  const second = await adapter.sendMessage(messages, { multimodal: false });
  assert.equal(second.content, 'after tool');
  assert.equal(requests[1].previous_response_id, 'response-1');
  assert.equal(requests[1].reasoning, undefined);
  assert.equal(requests[1].input.filter((item) => item.type === 'function_call_output' && item.call_id === 'same-id').length, 1);
  assert.equal(requests[1].input.filter((item) => item.role === 'user').length, 1);
  assert.equal(requests[1].input.find((item) => item.role === 'user').content[0].text, 'new inbox');
  adapter.close();
});

test('standalone adapter insert stays FIFO, bounded and single-drain', async () => {
  const api = await exportsReady;
  globalThis.fetch = async () => new Response('', { status: 200 });
  const adapter = api.createProtocolAdapter('cc');
  await adapter.init(config());
  for (let i = 0; i < 10; i++) assert.equal(adapter.insertMessage({ role: 'user', content: `u${i}` }).accepted, true);
  assert.deepEqual(adapter.insertMessage({ role: 'user', content: 'overflow' }), { accepted: false, reason: 'queue-full' });
  globalThis.__museRuntimeTest.streamChat = async () => ({ content: 'ok', reasoning: '', toolCalls: [], finishReason: 'stop', assistantMessage: { role: 'assistant', content: 'ok' } });
  const messages = [];
  await adapter.sendMessage(messages, { multimodal: false });
  await adapter.sendMessage(messages, { multimodal: false });
  assert.deepEqual(messages.map((item) => item.content), Array.from({ length: 10 }, (_, i) => `u${i}`));
  assert.equal(adapter.insertMessage({ role: 'user', content: 'next round' }).accepted, true);
  adapter.requestStop();
  assert.equal(adapter.insertMessage({ role: 'user', content: 'after stop' }).reason, 'stop-requested');
  adapter.close();
});

test('initialization-time inbox is injected once, FIFO, with untouched model text', async () => {
  const api = await exportsReady;
  const { identity, session } = makeSession(api, 'init-inbox');
  try {
    const texts = ['first\u0000raw', 'same', 'same'];
    for (const text of texts) assert.equal(session.enqueueUserMessage(text).accepted, true);
    assert.deepEqual(entries(api, identity).map((item) => item.state), ['queued', 'queued', 'queued']);
    const messages = session.adoptMessages([{ role: 'system', content: 'base' }]);
    assert.equal(session.consumePendingUserMessages(), 3);
    assert.equal(session.consumePendingUserMessages(), 0);
    assert.strictEqual(messages, session.modelMessages);
    assert.deepEqual(messages.slice(1).map((item) => item.content), texts.map(api.buildExecutorUserTaskMessage));
    assert.ok(messages[1].content.includes('\u0000'));
    const records = entries(api, identity);
    assert.ok(records.every((item) => item.state === 'delivered' && item.deliveredAt));
    assert.equal(records[0].text.includes('\u0000'), false);
  } finally { api.clearExecutorTaskRecords(identity.conversationId); }
});

test('inbox injection follows the complete assistant/tool batch, preserving pair order', async () => {
  const api = await exportsReady;
  const { identity, session } = makeSession(api, 'batch-inbox');
  try {
    const messages = session.adoptMessages([{ role: 'assistant', content: null, tool_calls: [
      { id: 'slow', type: 'function', function: { name: 'a', arguments: '{}' } },
      { id: 'fast', type: 'function', function: { name: 'b', arguments: '{}' } },
    ] }]);
    session.enqueueUserMessage('during tools');
    assert.equal(messages.length, 1);
    messages.push({ role: 'tool', tool_call_id: 'slow', content: 'slow result' });
    messages.push({ role: 'tool', tool_call_id: 'fast', content: 'fast result' });
    session.consumePendingUserMessages();
    assert.deepEqual(messages.map((item) => item.role), ['assistant', 'tool', 'tool', 'user']);
    assert.deepEqual(messages.slice(1, 3).map((item) => item.tool_call_id), ['slow', 'fast']);
  } finally { api.clearExecutorTaskRecords(identity.conversationId); }
});

test('record queue capacity recovers after actual injection', async () => {
  const api = await exportsReady;
  const { identity, session } = makeSession(api, 'capacity-inbox');
  try {
    for (let i = 0; i < 10; i++) assert.equal(session.enqueueUserMessage(`u${i}`).accepted, true);
    assert.equal(session.enqueueUserMessage('overflow').reason, 'queue-full');
    session.consumePendingUserMessages();
    assert.equal(session.modelMessages.length, 10);
    assert.equal(session.enqueueUserMessage('after drain').accepted, true);
    session.consumePendingUserMessages();
    assert.equal(session.modelMessages.length, 11);
  } finally { api.clearExecutorTaskRecords(identity.conversationId); }
});

test('stop rejects new messages and leaves original queued text undelivered', async () => {
  const api = await exportsReady;
  const { identity, session } = makeSession(api, 'stop-inbox');
  try {
    session.enqueueUserMessage('queued before stop');
    session.freezeForStop();
    assert.equal(session.enqueueUserMessage('after stop').reason, 'stop-requested');
    assert.equal(session.consumePendingUserMessages(), 0);
    session.markTerminal('aborted');
    assert.equal(entries(api, identity)[0].state, 'undelivered');
    assert.equal(session.modelMessages.length, 0);
    assert.equal(session.enqueueUserMessage('after terminal').reason, 'terminal');
  } finally { api.clearExecutorTaskRecords(identity.conversationId); }
});

test('tool record uses supplied settle timestamp and does not move it on duplicate result', async () => {
  const api = await exportsReady;
  const { identity, session } = makeSession(api, 'settle-time');
  try {
    const finishedAt = '2026-10-07T00:00:01.123Z';
    session.beginToolCall({ callId: 'fast', name: 'synthetic', args: '{}' });
    session.endToolCall({ callId: 'fast', success: true, message: 'done', finishedAt });
    session.endToolCall({ callId: 'fast', success: false, message: 'duplicate', finishedAt: '2026-10-07T00:00:05.000Z' });
    const record = entries(api, identity).find((item) => item.kind === 'tool');
    assert.equal(record.finishedAt, finishedAt);
    assert.equal(record.status, 'completed');
  } finally { api.clearExecutorTaskRecords(identity.conversationId); }
});
