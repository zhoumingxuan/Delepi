'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./ipc-fixture.cjs');
const request = (payload = {}, expectedRevision) => ({ requestId: 'request-fixture', payload, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
const config = () => ({ intervalMinutes: 30, dailyRoundLimit: 3, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), protocol: 'responses', learningEnabled: true, autoPromote: true });
function port(calls) {
  const log = name => (...args) => { calls.push({ name, args }); return { id: 'schedule-1' }; };
  return { ready: () => true, list: log('list'), configure: log('configure'), setEnabled: log('setEnabled'), runNow: log('runNow'), listSkills: log('listSkills'), rollbackSkill: log('rollbackSkill') };
}
test('background endpoints reject foreign windows, frames and external pages before reading runtime', async t => {
  const f = await fixture(t), calls = []; let providers = 0;
  f.api.registerBackgroundIpcHandlers(() => f.mainWindow, () => { providers++; return port(calls); });
  assert.equal(f.state.handlers.size, Object.keys(f.api.IPC_BACKGROUND).length);
  for (const handler of f.state.handlers.values()) for (const event of [f.event(f.window(2)), { sender: f.mainWindow.webContents, senderFrame: null }, { sender: f.mainWindow.webContents, senderFrame: { url: f.pageUrl, parent: f.mainWindow.webContents.mainFrame } }]) assert.equal((await handler(event, request())).code, 'UNTRUSTED_SENDER');
  for (const url of ['https://external.invalid/', f.pageUrl + '?injected=1', f.pageUrl.replace('index.html', 'else.html')]) {
    f.mainWindow.webContents.mainFrame.url = url;
    for (const handler of f.state.handlers.values()) assert.equal((await handler(f.event(f.mainWindow), request())).code, 'UNTRUSTED_SENDER');
  }
  f.mainWindow.webContents.mainFrame.url = f.pageUrl; f.mainWindow.destroyed = true;
  for (const handler of f.state.handlers.values()) assert.equal((await handler(f.event(f.mainWindow), request())).code, 'UNTRUSTED_SENDER');
  assert.equal(providers, 0); assert.deepEqual(calls, []);
});
test('background readiness follows current runtime and new main window; mutation derives caller identity and sends advisory notification', async t => {
  const f = await fixture(t), calls = [], C = f.api.IPC_BACKGROUND; let live = f.mainWindow, runtime;
  f.api.registerBackgroundIpcHandlers(() => live, () => runtime);
  const invoke = (channel, raw = request()) => f.state.handlers.get(channel)(f.event(live), raw);
  assert.deepEqual(await invoke(C.STATUS), { ok: true, result: { ready: false, appMustRemainRunning: true } });
  assert.equal((await invoke(C.LIST)).code, 'STAGE_NOT_READY');
  runtime = port(calls); const count = f.state.handlers.size, old = live; live = f.window(59);
  f.api.registerBackgroundIpcHandlers(() => live, () => runtime); assert.equal(f.state.handlers.size, count);
  assert.equal((await f.state.handlers.get(C.STATUS)(f.event(old), request())).code, 'UNTRUSTED_SENDER');
  assert.equal((await invoke(C.STATUS)).result.ready, true);
  const options = config();
  assert.deepEqual(await invoke(C.CONFIGURE, request({ goalId: 'goal-1', config: options, confirmed: true }, 4)), { ok: true, result: { id: 'schedule-1' } });
  assert.deepEqual(calls, [{ name: 'configure', args: ['goal-1', 4, options, 59] }]);
  assert.deepEqual(live.sends, [[f.api.IPC_AUTONOMY.CHANGED]]); assert.deepEqual(old.sends, []);
  runtime = undefined; assert.equal((await invoke(C.STATUS)).result.ready, false); assert.equal((await invoke(C.RUN_NOW, request({ scheduleId: 'schedule-1', confirmed: true }, 1))).code, 'STAGE_NOT_READY');
});
test('background mutation whitelist rejects missing consent, revisions, identities, config injection and invalid bounds', async t => {
  const f = await fixture(t), calls = [], C = f.api.IPC_BACKGROUND; f.api.registerBackgroundIpcHandlers(() => f.mainWindow, () => port(calls));
  const invoke = (channel, raw) => f.state.handlers.get(channel)(f.event(f.mainWindow), raw);
  const valid = { goalId: 'goal-1', config: config(), confirmed: true };
  for (const [channel, raw] of [
    [C.LIST, { ...request(), callerId: 55 }], [C.SKILL_LIST, request({ goalId: '../../private' })],
    [C.CONFIGURE, request({ ...valid, callerId: 55 }, 1)], [C.CONFIGURE, request({ ...valid, confirmed: false }, 1)], [C.CONFIGURE, request(valid)],
    ...[29, 1441, 30.5, '30'].map(value => [C.CONFIGURE, request({ ...valid, config: { ...valid.config, intervalMinutes: value } }, 1)]),
    ...[0, 4, 1.5, '3'].map(value => [C.CONFIGURE, request({ ...valid, config: { ...valid.config, dailyRoundLimit: value } }, 1)]),
    ...['filePath', 'apiKey', 'content', 'leaseId', 'allowAll'].map(key => [C.CONFIGURE, request({ ...valid, config: { ...valid.config, [key]: 'synthetic' } }, 1)]),
    [C.CONFIGURE, request({ ...valid, config: { ...valid.config, protocol: ['responses'] } }, 1)],
    [C.CONFIGURE, request({ ...valid, config: { ...valid.config, expiresAt: '2026-10-99T00:00:00.000Z' } }, 1)],
    [C.CONFIGURE, request({ ...valid, config: { ...valid.config, learningEnabled: false } }, 1)],
    [C.SET_ENABLED, request({ scheduleId: 'schedule-1', enabled: 'false', confirmed: true }, 1)],
    [C.SET_ENABLED, request({ scheduleId: 'schedule-1', enabled: true }, 1)],
    [C.RUN_NOW, request({ scheduleId: 'schedule-1', confirmed: true, runId: 'forged' }, 1)],
    [C.RUN_NOW, request({ scheduleId: 'schedule-1', confirmed: true })],
    [C.SKILL_ROLLBACK, request({ skillId: 'skill-1', confirmed: true, versionId: 'forged' }, 1)],
    [C.SKILL_ROLLBACK, request({ skillId: 'skill-1' }, 1)],
  ]) assert.equal((await invoke(channel, raw)).code, 'INVALID_REQUEST', channel);
  assert.deepEqual(calls, []);
  assert.equal((await invoke(C.SET_ENABLED, request({ scheduleId: 'schedule-1', enabled: false, confirmed: true }, 5))).ok, true);
  assert.equal((await invoke(C.RUN_NOW, request({ scheduleId: 'schedule-1', confirmed: true }, 6))).ok, true);
  assert.equal((await invoke(C.SKILL_ROLLBACK, request({ skillId: 'skill-1', confirmed: true }, 7))).ok, true);
  assert.deepEqual(calls, [{ name: 'setEnabled', args: ['schedule-1', 5, false] }, { name: 'runNow', args: ['schedule-1', 6] }, { name: 'rollbackSkill', args: ['skill-1', 7] }]);
});
test('background errors remain fixed safe messages and only numeric current revision escapes', async t => {
  const f = await fixture(t), runtime = port([]), C = f.api.IPC_BACKGROUND; f.api.registerBackgroundIpcHandlers(() => f.mainWindow, () => runtime);
  const invoke = () => f.state.handlers.get(C.RUN_NOW)(f.event(f.mainWindow), request({ scheduleId: 'schedule-1', confirmed: true }, 2));
  runtime.runNow = () => { throw Object.assign(Error('/Users/private key=synthetic'), { code: 'REVISION_CONFLICT', currentRevision: 5 }); };
  assert.deepEqual(await invoke(), { ok: false, code: 'REVISION_CONFLICT', message: '内容已更新，请刷新后重新确认', retryable: true, currentRevision: 5 });
  runtime.runNow = () => { throw Object.assign(Error('/Users/private key=synthetic'), { code: 'RAW_PRIVATE', currentRevision: '/private' }); };
  const response = await invoke(); assert.equal(response.code, 'OPERATION_FAILED'); assert.equal(response.currentRevision, undefined); assert.ok(!JSON.stringify(response).includes('private')); assert.deepEqual(f.mainWindow.sends, []);
});
test('preload exposes narrow background contracts and unsubscribes exactly its own autonomy listener', async t => {
  const f = await fixture(t), api = f.state.api.background, C = f.api.IPC_BACKGROUND, options = config();
  await api.configure('goal-1', 4, options, { callerId: 99 }); await api.setEnabled('schedule-1', 6, false); await api.runNow('schedule-1', 7); await api.rollbackSkill('skill-1', 8);
  assert.deepEqual(f.state.bridgeCalls.map(([channel, value]) => [channel, value.payload, value.expectedRevision]), [[C.CONFIGURE, { goalId: 'goal-1', config: options, confirmed: true }, 4], [C.SET_ENABLED, { scheduleId: 'schedule-1', enabled: false, confirmed: true }, 6], [C.RUN_NOW, { scheduleId: 'schedule-1', confirmed: true }, 7], [C.SKILL_ROLLBACK, { skillId: 'skill-1', confirmed: true }, 8]]);
  for (const [, value] of f.state.bridgeCalls) { assert.match(value.requestId, /^[a-f0-9-]{36}$/); assert.equal(value.payload.callerId, undefined); }
  let backgrounds = 0, autonomies = 0;
  const unsubAutonomy = f.state.api.autonomy.onChanged(() => autonomies++), unsubBackground = api.onChanged(() => backgrounds++);
  const subscriptions = [...f.state.subscriptions]; subscriptions.forEach(item => item.callback({})); assert.equal(backgrounds, 1); assert.equal(autonomies, 1);
  unsubBackground(); assert.equal(f.state.subscriptions.length, 1); assert.equal(f.state.subscriptions[0], subscriptions[0]); f.state.subscriptions[0].callback({}); assert.equal(autonomies, 2); unsubAutonomy(); assert.deepEqual(f.state.subscriptions, []);
});
