'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixture.cjs');
const request = (payload = {}, expectedRevision) => ({ requestId: 'request-fixture', payload, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
test('every autonomy endpoint rejects foreign windows, subframes, external navigation and destroyed senders before effects', async t => {
  const f = await fixture(t); f.api.registerAutonomyIpcHandlers(() => f.mainWindow, f.state.services);
  assert.equal(f.state.handlers.size, Object.keys(f.api.IPC_AUTONOMY).length - 1);
  for (const [channel, handler] of f.state.handlers) {
    for (const event of [f.event(f.window(2)), { sender: f.mainWindow.webContents, senderFrame: { url: f.pageUrl, parent: f.mainWindow.webContents.mainFrame } }, { sender: f.mainWindow.webContents, senderFrame: null }]) {
      assert.equal((await handler(event, request())).code, 'UNTRUSTED_SENDER', channel);
    }
  }
  for (const url of ['https://external.invalid/', f.pageUrl + '?injected=1', f.pageUrl.replace('index.html', 'other.html')]) {
    f.mainWindow.webContents.mainFrame.url = url;
    for (const [channel, handler] of f.state.handlers) assert.equal((await handler(f.event(f.mainWindow), request())).code, 'UNTRUSTED_SENDER', channel);
  }
  f.mainWindow.webContents.mainFrame.url = f.pageUrl; f.mainWindow.webContents.destroyed = true;
  for (const handler of f.state.handlers.values()) assert.equal((await handler(f.event(f.mainWindow), request())).code, 'UNTRUSTED_SENDER');
  assert.equal(f.state.calls.length, 0); assert.equal(f.mainWindow.sends.length, 0);
});
test('single registration uses replacement live services/window and derives approval caller identity at invoke time', async t => {
  const f = await fixture(t); let live = f.mainWindow;
  f.api.registerAutonomyIpcHandlers(() => live, f.state.services); const count = f.state.handlers.size;
  const old = live; live = f.window(57); f.api.registerAutonomyIpcHandlers(() => live, f.state.services);
  assert.equal(f.state.handlers.size, count);
  const handler = f.state.handlers.get(f.api.IPC_AUTONOMY.APPROVAL_DECIDE);
  const raw = request({ previewId: 'preview-1', choice: 'once', confirmed: true }, 4);
  assert.equal((await handler(f.event(old), raw)).code, 'UNTRUSTED_SENDER');
  assert.deepEqual(await handler(f.event(live), raw), { ok: true, result: { revision: 2 } });
  assert.deepEqual(f.state.calls[0], { name: 'authority.decideApproval', args: ['preview-1', 4, 'once', 57] });
  assert.deepEqual(live.sends, [[f.api.IPC_AUTONOMY.CHANGED]]); assert.equal(old.sends.length, 0);
});
test('IPC rejects forged actions, keys, leases, paths, identities, missing consent and revisions', async t => {
  const f = await fixture(t); f.api.registerAutonomyIpcHandlers(() => f.mainWindow, f.state.services);
  const C = f.api.IPC_AUTONOMY, invoke = (channel, raw) => f.state.handlers.get(channel)(f.event(f.mainWindow), raw);
  const validDraft = { title: '公开主题', topic: '公开问题', sourceUrls: ['https://example.com/'], destinationId: 'destination-1', expectedOutput: '简报', stopConditions: '完成停止', limits: f.api.DEFAULT_EXPLORATION_LIMITS };
  for (const [channel, raw] of [
    [C.GOAL_LIST, { ...request(), callerId: 99 }], [C.GOAL_GET, request({ goalId: '../../private' })],
    [C.APPROVAL_DECIDE, request({ previewId: 'preview-1', choice: 'once' }, 1)],
    [C.APPROVAL_DECIDE, request({ previewId: 'preview-1', choice: 'once', confirmed: true })],
    [C.APPROVAL_DECIDE, request({ previewId: 'preview-1', choice: ['once'], confirmed: true }, 1)],
    [C.APPROVAL_DECIDE, request({ previewId: 'preview-1', choice: 'once', confirmed: true, action: { capability: 'shell' } }, 1)],
    [C.APPROVAL_DECIDE, request({ previewId: 'preview-1', choice: 'once', confirmed: true, callerId: 1 }, 1)],
    [C.RULE_ISSUE, request({ previewId: 'preview-1', confirmed: true, apiKey: 'synthetic-secret' }, 1)],
    [C.RULE_REVOKE, request({ ruleId: 'rule-1', leaseId: 'lease-1' }, 1)],
    [C.GOAL_STATE, request({ goalId: 'goal-1', state: ['active'] }, 1)],
    [C.OS_REQUEST, request({ kind: 'camera' })], [C.OS_SETTINGS, request({ kind: 'camera', url: 'file:///private' })],
    [C.EXPLORATION_START, request({ planId: 'plan-1', confirmed: true, runId: 'spoofed' }, 1)],
    [C.EXPLORATION_PLAN, request({ goalId: 'goal-1', protocol: 'auto' }, 1)],
    [C.EXPLORATION_PLAN, request({ goalId: 'goal-1', protocol: ['responses'] }, 1)],
    [C.EXPLORATION_PLAN, request({ goalId: 'goal-1', protocol: 'responses', baseUrl: 'https://forged.example.com' }, 1)],
    [C.PUBLIC_APPEND, request({ runId: 'run-1', messageId: 'message-1', text: '公开资料', confirmedPublic: false })],
    ...['ownerId', 'dataScopeId', 'filePath', 'classification'].map(key => [C.GOAL_CREATE, request({ draft: { ...validDraft, [key]: 'forged' } })]),
    [C.GOAL_CREATE, request({ draft: { ...validDraft, sourceUrls: ['http://example.com/'] } })],
    [C.GOAL_CREATE, request({ draft: { ...validDraft, sourceUrls: ['https://127.0.0.1/'] } })],
    [C.GOAL_CREATE, request({ draft: { ...validDraft, sourceUrls: ['https://example.com/', 'https://example.com/'] } })],
    [C.GOAL_CREATE, request({ draft: { ...validDraft, limits: { ...validDraft.limits, concurrency: 3 } } })],
    [C.GOAL_CREATE, request({ draft: { ...validDraft, limits: { ...validDraft.limits, activeMilliseconds: 0 } } })],
    [C.POLICY_UPDATE, request({ patch: { deniedCapabilities: ['shell'], deniedLegacyTools: [] } }, 1)],
    [C.POLICY_UPDATE, request({ patch: { deniedCapabilities: [], deniedLegacyTools: [], allowAll: true } }, 1)],
  ]) assert.equal((await invoke(channel, raw)).code, 'INVALID_REQUEST', channel);
  assert.equal(f.state.calls.length, 0);
  assert.equal((await invoke(C.GOAL_CREATE, request({ draft: validDraft }))).ok, true);
  assert.equal(f.state.calls[0].args[0].sourceUrls[0], 'https://example.com/');
});
test('A/B rejects exploration when domain services are absent and future plan/start use trusted caller without nested results', async t => {
  const f = await fixture(t); f.api.registerAutonomyIpcHandlers(() => f.mainWindow, f.state.services);
  const C = f.api.IPC_AUTONOMY, invoke = (channel, raw) => f.state.handlers.get(channel)(f.event(f.mainWindow), raw);
  for (const [channel, raw] of [[C.BUDGET, request()], [C.EXPLORATION_PLAN, request({ goalId: 'goal-1' }, 1)], [C.EXPLORATION_START, request({ planId: 'plan-1', confirmed: true }, 1)], [C.EXPLORATION_STOP, request({ runId: 'run-1' })], [C.EXPLORATION_LIST, request()], [C.PUBLIC_APPEND, request({ runId: 'run-1', messageId: 'message-1', text: 'public', confirmedPublic: true })]]) assert.equal((await invoke(channel, raw)).code, 'STAGE_NOT_READY');
  assert.equal(f.state.calls.length, 0);
  const calls = [], result = { id: 'fixture-plan' };
  f.api.registerAutonomyIpcHandlers(() => f.mainWindow, { ...f.state.services, explorationReady: true, stages: { planExploration: (...args) => { calls.push(args); return result; }, startExploration: async (...args) => { calls.push(args); return { id: 'fixture-session' }; } } });
  assert.deepEqual(await invoke(C.EXPLORATION_PLAN, request({ goalId: 'goal-1' }, 2)), { ok: true, result });
  assert.deepEqual(await invoke(C.EXPLORATION_START, request({ planId: 'plan-1', confirmed: true }, 3)), { ok: true, result: { id: 'fixture-session' } });
  assert.deepEqual(calls, [['goal-1', 2, 'chat-completions', 1], ['plan-1', 3, 1]]);
  assert.deepEqual(await invoke(C.EXPLORATION_PLAN, request({ goalId: 'goal-1', protocol: 'responses' }, 4)), { ok: true, result });
  assert.deepEqual(calls[2], ['goal-1', 4, 'responses', 1]);
});
test('domain errors become fixed safe messages and revision conflicts retain only numeric current revision', async t => {
  const f = await fixture(t), C = f.api.IPC_AUTONOMY;
  f.api.registerAutonomyIpcHandlers(() => f.mainWindow, f.state.services);
  const handler = f.state.handlers.get(C.RULE_ISSUE), raw = request({ previewId: 'preview-1', confirmed: true }, 1);
  f.state.services.authority.issueRule = () => { throw Object.assign(Error('private SQL /Users/private key=synthetic'), { code: 'REVISION_CONFLICT', currentRevision: 5 }); };
  let response = await handler(f.event(f.mainWindow), raw); assert.equal(response.code, 'REVISION_CONFLICT'); assert.equal(response.currentRevision, 5); assert.equal(response.message, '内容已更新，请刷新后重新确认');
  f.state.services.authority.issueRule = () => { throw Object.assign(Error('private SQL /Users/private key=synthetic'), { code: 'RAW_SECRET', currentRevision: '/private' }); };
  response = await handler(f.event(f.mainWindow), raw); assert.equal(response.code, 'OPERATION_FAILED'); assert.equal(response.currentRevision, undefined); assert.ok(!JSON.stringify(response).includes('private')); assert.equal(f.mainWindow.sends.length, 0);
  f.api.registerAutonomyIpcHandlers(() => f.mainWindow, { ...f.state.services, explorationReady: true, stages: { startExploration: () => { throw Object.assign(Error('private SQL'), { code: 'GOAL_ALREADY_RUNNING' }); } } });
  response = await f.state.handlers.get(C.EXPLORATION_START)(f.event(f.mainWindow), request({ planId: 'plan-1', confirmed: true }, 1));
  assert.equal(response.code, 'GOAL_ALREADY_RUNNING'); assert.equal(response.message, '这个主题已有正在运行的探索，请先查看进度');
  for (const code of ['PUBLIC_INBOX_SCOPE_CHANGED', 'PUBLIC_INBOX_SCOPE_MISMATCH', 'PUBLIC_INBOX_DEADLINE_EXPIRED']) {
    f.api.registerAutonomyIpcHandlers(() => f.mainWindow, { ...f.state.services, explorationReady: true, stages: { appendPublicMessage: () => { throw Object.assign(Error('/private synthetic-secret'), { code }); } } });
    response = await f.state.handlers.get(C.PUBLIC_APPEND)(f.event(f.mainWindow), request({ runId: 'run-1', messageId: 'message-1', text: '公开补充', confirmedPublic: true }));
    assert.equal(response.code, code); assert.ok(!JSON.stringify(response).includes('private')); assert.ok(!JSON.stringify(response).includes('synthetic-secret'));
  }
});
test('preload exposes narrow consent/cas payloads, never permits caller injection and unsubscribes exact listeners', async t => {
  const f = await fixture(t), bridge = f.state.api.autonomy, C = f.api.IPC_AUTONOMY;
  assert.equal(bridge.previewAction, undefined); assert.equal(bridge.issueGrant, undefined); assert.equal(bridge.acquireLease, undefined);
  await bridge.decideApproval('preview-1', 2, 'run', { callerId: 88 });
  await bridge.issueRule('preview-2', 4);
  await bridge.requestOs('camera');
  await bridge.startExploration('plan-1', 6);
  for (const [channel, raw] of f.state.bridgeCalls) { assert.match(raw.requestId, /^[a-f0-9-]{36}$/); assert.deepEqual(Object.keys(raw).sort(), ['payload', 'requestId', ...(raw.expectedRevision === undefined ? [] : ['expectedRevision'])].sort()); assert.equal(raw.payload.callerId, undefined); assert.equal(raw.payload.confirmed, true); assert.ok(channel.startsWith('autonomy:')); }
  assert.deepEqual(f.state.bridgeCalls[0][1].payload, { previewId: 'preview-1', choice: 'run', confirmed: true });
  let wakes = 0; const unsubscribe = bridge.onChanged(() => wakes++); assert.equal(f.state.subscriptions.at(-1).channel, C.CHANGED); const subscription = f.state.subscriptions.at(-1); subscription.callback({}); assert.equal(wakes, 1); unsubscribe(); assert.ok(!f.state.subscriptions.includes(subscription));
  await bridge.planExploration('goal-1', 5); await bridge.planExploration('goal-1', 6, 'responses');
  assert.deepEqual(f.state.bridgeCalls.at(-2)[1].payload, { goalId: 'goal-1' });
  assert.deepEqual(f.state.bridgeCalls.at(-1)[1].payload, { goalId: 'goal-1', protocol: 'responses' });
  assert.equal(f.state.bridgeCalls.at(-1)[1].expectedRevision, 6);
});
test('legacy OS denial prevents adapter prompts while read-only queries and explicit settings remain available', async t => {
  const f = await fixture(t), C = f.api.IPC_AUTONOMY;
  f.state.services.authority.assertOsRequest = () => { throw Object.assign(Error('legacy policy'), { code: 'POLICY_BLOCKED' }); };
  f.api.registerAutonomyIpcHandlers(() => f.mainWindow, f.state.services);
  const invoke = (channel, payload) => f.state.handlers.get(channel)(f.event(f.mainWindow), request(payload));
  assert.equal((await invoke(C.OS_REQUEST, { kind: 'camera', confirmed: true })).code, 'POLICY_BLOCKED');
  assert.equal(f.state.calls.length, 0); assert.equal(f.mainWindow.sends.length, 0);
  assert.equal((await invoke(C.OS_STATUS, {})).ok, true);
  assert.equal((await invoke(C.OS_SETTINGS, { kind: 'camera' })).ok, true);
  assert.deepEqual(f.state.calls.map(item => item.name), ['os.status', 'os.openSettings']);
});
test('exploration readiness requires the main-process release flag and complete services; public FIFO caller is derived from live window', async t => {
  const f = await fixture(t), C = f.api.IPC_AUTONOMY, calls = [];
  const stages = { budget: () => ({ accounts: [] }), planExploration: () => ({}), startExploration: () => ({}), stopExploration: () => {}, listExplorations: () => [], appendPublicMessage: (...args) => { calls.push(args); return { accepted: true }; } };
  let live = f.mainWindow;
  f.api.registerAutonomyIpcHandlers(() => live, { ...f.state.services, stages });
  const invoke = (channel, raw = request()) => f.state.handlers.get(channel)(f.event(live), raw);
  assert.deepEqual(await invoke(C.STATUS), { ok: true, result: { explorationReady: false } });
  assert.equal((await invoke(C.EXPLORATION_PLAN, request({ goalId: 'goal-1' }, 1))).code, 'STAGE_NOT_READY');
  f.api.registerAutonomyIpcHandlers(() => live, { ...f.state.services, explorationReady: true, stages: { ...stages, appendPublicMessage: undefined } });
  assert.equal((await invoke(C.STATUS)).result.explorationReady, false);
  live = f.window(27); f.api.registerAutonomyIpcHandlers(() => live, { ...f.state.services, explorationReady: true, stages });
  assert.equal((await invoke(C.STATUS)).result.explorationReady, true);
  assert.deepEqual(await invoke(C.PUBLIC_APPEND, request({ runId: 'run-1', messageId: 'message-1', text: '明确公开的补充', confirmedPublic: true })), { ok: true, result: { accepted: true } });
  assert.deepEqual(calls, [['run-1', 'message-1', '明确公开的补充', true, 27]]);
  assert.equal((await invoke(C.PUBLIC_APPEND, request({ runId: 'run-1', messageId: 'message-1', text: '补充', confirmedPublic: true, callerId: 27 }))).code, 'INVALID_REQUEST'); assert.equal(calls.length, 1);
});
test('runtime admission remains live after IPC registration and disposal closes every exploration entry', async t => {
  const f = await fixture(t), C = f.api.IPC_AUTONOMY, calls = [];
  let ready = false;
  const stages = { budget: () => ({ accounts: [] }), planExploration: () => { calls.push('plan'); return {}; }, startExploration: () => { calls.push('start'); return {}; }, stopExploration: () => {}, listExplorations: () => [], appendPublicMessage: () => { calls.push('append'); return { accepted: true }; } };
  f.api.registerAutonomyIpcHandlers(() => f.mainWindow, { ...f.state.services, get explorationReady() { return ready; }, get stages() { return ready ? stages : undefined; } });
  const invoke = (channel, raw = request()) => f.state.handlers.get(channel)(f.event(f.mainWindow), raw);
  assert.equal((await invoke(C.STATUS)).result.explorationReady, false);
  ready = true;
  assert.equal((await invoke(C.STATUS)).result.explorationReady, true);
  assert.equal((await invoke(C.EXPLORATION_PLAN, request({ goalId: 'goal-1' }, 1))).ok, true);
  ready = false;
  assert.equal((await invoke(C.STATUS)).result.explorationReady, false);
  for (const [channel, raw] of [[C.BUDGET, request()], [C.EXPLORATION_PLAN, request({ goalId: 'goal-1' }, 1)], [C.EXPLORATION_START, request({ planId: 'plan-1', confirmed: true }, 1)], [C.EXPLORATION_STOP, request({ runId: 'run-1' })], [C.EXPLORATION_LIST, request()], [C.PUBLIC_APPEND, request({ runId: 'run-1', messageId: 'message-1', text: 'public', confirmedPublic: true })]]) assert.equal((await invoke(channel, raw)).code, 'STAGE_NOT_READY');
  assert.deepEqual(calls, ['plan']);
});
