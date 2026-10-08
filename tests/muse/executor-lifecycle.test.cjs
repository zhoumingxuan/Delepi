'use strict';
const test = require('node:test');
const { harness, deferred, until, call, stream, final, assert } = require('./harness.cjs');

const result = id => ({ id, result: { success: true, code: 'OK', message: 'fixture-' + id } });
function recordCallbacks(session, seen = []) {
  return {
    recordSession: session,
    onToolCall: (name, args, callId) => session.beginToolCall({ name, args, callId }),
    onToolResult: (name, success, message, callId, finishedAt) => {
      seen.push({ callId, finishedAt });
      session.endToolCall({ callId, success, message, finishedAt });
    },
  };
}

test('P02 fast tool settles visibly before slow tool; model batch retains declared order', async t => {
  const fast = deferred(), slow = deferred(), seen = [];
  const h = harness(t, {
    executorTurns: [stream([call('slow'), call('fast')]), stream([], final())],
    execute: ({ id }) => id === 'fast' ? fast.promise : slow.promise,
  });
  const session = h.session();
  const run = h.runExecutor(recordCallbacks(session, seen));
  await until(() => h.executions.length === 2);
  h.clock.set('2030-01-02T03:04:06.000Z');
  fast.resolve(result('fast'));
  await until(() => seen.length === 1);
  assert.equal(seen[0].callId, 'fast');
  assert.equal(seen[0].finishedAt, '2030-01-02T03:04:06.000Z');
  assert.equal(session.records.find(x => x.callId === 'fast').status, 'completed');
  assert.equal(h.logs[0].toolCalls.find(x => x.callId === 'fast').finishedAt, '2030-01-02T03:04:06.000Z');
  assert.equal(session.records.find(x => x.callId === 'slow').status, 'running');
  assert.equal(h.executorRequests.length, 1, 'model cannot consume an incomplete tool batch');
  h.clock.set('2030-01-02T03:04:09.000Z');
  slow.resolve(result('slow'));
  const finished = await run;
  assert.equal(finished.success, true);
  assert.deepEqual(seen.map(x => x.callId), ['fast', 'slow']);
  assert.deepEqual(h.executorRequests[1].filter(x => x.role === 'tool').map(x => x.tool_call_id), ['slow', 'fast']);
  assert.equal(session.records.find(x => x.callId === 'slow').finishedAt, '2030-01-02T03:04:09.000Z');
  assert.equal(h.adapters[0].closed, true);
});

test('final JSON with tool calls remains intermediate; parser only runs on a later final turn', async t => {
  const h = harness(t, {
    executorTurns: [stream([call('work')], final()), stream([], final())],
    execute: ({ id }, observed) => {
      assert.equal(observed.parserCalls.length, 0, 'parser has delivery side effects and must not run first');
      return Promise.resolve(result(id));
    },
  });
  const finished = await h.runExecutor();
  assert.equal(finished.success, true);
  assert.equal(h.executions.length, 1);
  assert.equal(h.parserCalls.length, 1);
  assert.equal(h.executorRequests.length, 2);
  assert.equal(h.executorRequests[1].filter(x => x.role === 'tool')[0].tool_call_id, 'work');
});

test('partial valid final returned by a cancelled stream cannot complete or invoke parser', async t => {
  const controller = new AbortController();
  const h = harness(t, { executorTurns: [() => {
    controller.abort(new Error('fixture-cancel'));
    return stream([], final());
  }] });
  await assert.rejects(h.runExecutor({ signal: controller.signal }), /fixture-cancel/);
  assert.equal(h.parserCalls.length, 0);
  assert.equal(h.executions.length, 0);
  assert.equal(h.adapters[0].closed, true);
  assert.equal(h.logs[0].finalStructuredOutput, undefined);
});

test('executor stream failure closes adapter and preserves an error log in fixture workspace', async t => {
  const h = harness(t, { executorTurns: [() => { throw Error('fixture-stream-failure'); }] });
  let failure;
  try { await h.runExecutor(); } catch (error) { failure = error; }
  assert.ok(failure && /fixture-stream-failure/.test(failure.message));
  assert.equal(h.adapters[0].closed, true);
  assert.ok(failure.executionLogPath.startsWith(h.root + '/'));
  assert.equal(require('node:fs').existsSync(failure.executionLogPath), true);
});

test('unexpected tool rejection waits for the other tool to settle before releasing the adapter', async t => {
  const slow = deferred(), failed = deferred();
  const h = harness(t, {
    executorTurns: [stream([call('failure'), call('slow')])],
    execute: ({ id }) => id === 'slow' ? slow.promise : failed.promise,
  });
  const session = h.session(), seen = [];
  let ended = false;
  const pending = h.runExecutor(recordCallbacks(session, seen)).then(
    () => { ended = true; throw Error('unexpected success'); },
    error => { ended = true; return error; },
  );
  await until(() => h.executions.length === 2);
  h.clock.set('2030-01-02T03:04:07.000Z');
  failed.reject(Error('fixture-tool-failure'));
  await until(() => seen.some(x => x.callId === 'failure'));
  assert.equal(ended, false);
  assert.equal(h.adapters[0].closed, false);
  assert.equal(session.records.find(x => x.callId === 'failure').status, 'failed');
  assert.equal(session.records.find(x => x.callId === 'failure').finishedAt, '2030-01-02T03:04:07.000Z');
  assert.equal(session.records.find(x => x.callId === 'slow').status, 'running');
  assert.equal(h.logs[0].toolCalls.find(x => x.callId === 'failure').status, 'failed');
  assert.equal(h.logs[0].toolCalls.find(x => x.callId === 'failure').finishedAt, '2030-01-02T03:04:07.000Z');
  slow.resolve(result('slow'));
  const error = await pending;
  assert.match(error.message, /fixture-tool-failure/);
  assert.equal(h.adapters[0].closed, true);
});

test('FIFO messages before init and during a tool batch inject once after all tool results', async t => {
  const work = deferred();
  const h = harness(t, {
    executorTurns: [stream([call('work')]), stream([], final())],
    execute: () => work.promise,
  });
  const session = h.session();
  session.enqueueUserMessage('before-init');
  const pending = h.runExecutor(recordCallbacks(session));
  await until(() => h.executions.length === 1);
  assert.equal(h.executorRequests[0].filter(x => x.content === 'before-init').length, 1);
  assert.equal(session.enqueueUserMessage('during-work').accepted, true);
  assert.equal(session.records.filter(x => x.kind === 'user-message').at(-1).state, 'queued');
  work.resolve(result('work'));
  await pending;
  const second = h.executorRequests[1];
  assert.equal(second.filter(x => x.content === 'before-init').length, 1);
  assert.equal(second.filter(x => x.content === 'during-work').length, 1);
  assert.ok(second.findIndex(x => x.content === 'during-work') > second.findIndex(x => x.role === 'tool'));
  assert.equal(session.records.filter(x => x.kind === 'user-message').at(-1).state, 'delivered');
});

test('cancellation during a tool batch leaves queued additions undelivered and late facts frozen', async t => {
  const work = deferred(), controller = new AbortController();
  const h = harness(t, { executorTurns: [stream([call('work')])], execute: () => work.promise });
  const session = h.session();
  const pending = h.runExecutor({ ...recordCallbacks(session), signal: controller.signal });
  const rejected = assert.rejects(pending, /fixture-cancel/);
  await until(() => h.executions.length === 1);
  session.enqueueUserMessage('must-not-inject');
  session.freezeForStop();
  controller.abort(Error('fixture-cancel'));
  work.resolve(result('work'));
  await rejected;
  session.markTerminal('aborted');
  assert.equal(session.modelMessages.filter(x => x.content === 'must-not-inject').length, 0);
  assert.equal(session.records.find(x => x.kind === 'user-message').state, 'undelivered');
  assert.equal(session.records.find(x => x.callId === 'work').status, 'failed');
  const before = JSON.stringify(session.records);
  session.endToolCall({ callId: 'work', success: true, message: 'late' });
  assert.equal(JSON.stringify(session.records), before);
  assert.equal(h.adapters[0].closed, true);
});

test('completion observer failures cannot replace successful tool facts or stop batch delivery', async t => {
  const h = harness(t, {
    executorTurns: [stream([call('one'), call('two')]), stream([], final())],
  });
  const notified = [];
  const finished = await h.runExecutor({
    onThinking: (_text, info) => {
      if (info?.type === 'tool-progress' && h.executions.length === 2) {
        throw Error('fixture-progress-observer-failure');
      }
    },
    onToolResult: (_name, _success, _message, callId) => {
      notified.push(callId);
      throw Error('fixture-result-observer-failure');
    },
  });
  assert.equal(finished.success, true);
  assert.deepEqual(notified, ['one', 'two']);
  assert.deepEqual(h.executorRequests[1].filter(x => x.role === 'tool').map(x => x.tool_call_id), ['one', 'two']);
  assert.equal(h.logs[0].toolCalls.every(x => x.status === 'completed'), true);
  assert.equal(h.logs[0].errors.length, 0);
  assert.equal(h.adapters[0].closed, true);
});
