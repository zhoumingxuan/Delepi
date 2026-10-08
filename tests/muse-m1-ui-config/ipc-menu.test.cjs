'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixture.cjs');
const request = (payload = {}, extra = {}) => ({ requestId: 'request-fixture', payload, ...extra });

test('trusted sender requires the live main top frame and exact application page', async t => {
  const f = await fixture(t), options = { packagedPageUrl: f.pageUrl, isPackaged: true };
  assert.doesNotThrow(() => f.api.assertTrustedSender(f.event(f.mainWindow), f.mainWindow, options));
  const subframe = { url: f.pageUrl, parent: f.mainWindow.webContents.mainFrame };
  for (const event of [f.event(f.window(2)), { sender: f.mainWindow.webContents, senderFrame: subframe }, { sender: f.mainWindow.webContents, senderFrame: null }]) {
    assert.throws(() => f.api.assertTrustedSender(event, f.mainWindow, options), /UNTRUSTED_SENDER/);
  }
  for (const url of ['https://example.invalid/', f.pageUrl + '?injected=1', f.pageUrl.replace('index.html', 'another.html'), 'invalid']) assert.equal(f.api.isTrustedPageUrl(url, options), false);
  assert.equal(f.api.isTrustedPageUrl(f.pageUrl + '#settings', options), true);
  const dev = { ...options, isPackaged: false, devServerUrl: 'http://localhost:5173/' };
  assert.equal(f.api.isTrustedPageUrl('http://localhost:5173/', dev), true);
  for (const url of ['http://localhost:5173/untrusted', 'http://localhost:5174/', 'http://127.0.0.1:5173/']) assert.equal(f.api.isTrustedPageUrl(url, dev), false);
  assert.equal(f.api.isTrustedPageUrl('http://localhost:5173/', { ...dev, isPackaged: true }), false);
  f.mainWindow.destroyed = true; assert.throws(() => f.api.assertTrustedSender(f.event(f.mainWindow), f.mainWindow, options), /UNTRUSTED_SENDER/);
});

test('every config endpoint rejects preview windows, external pages and subframes before side effects', async t => {
  const f = await fixture(t); let reloads = 0;
  f.api.registerConfigIpc(() => f.mainWindow, () => reloads++);
  const before = f.snapshot();
  const variants = [f.event(f.window(2)), { sender: f.mainWindow.webContents, senderFrame: { url: f.pageUrl, parent: f.mainWindow.webContents.mainFrame } }];
  for (const [channel, handler] of f.state.handlers) {
    for (const event of variants) await assert.rejects(async () => handler(event, {}), /UNTRUSTED_SENDER/, channel);
  }
  f.mainWindow.webContents.mainFrame.url = 'https://external.invalid/';
  for (const [channel, handler] of f.state.handlers) await assert.rejects(async () => handler(f.event(f.mainWindow), {}), /UNTRUSTED_SENDER/, channel);
  assert.deepEqual(f.snapshot(), before); assert.equal(reloads, 0); assert.equal(f.state.dialogs.length, 0);
});

test('config IPC accepts a batch atomically and rejects path bypass and unconfirmed import', async t => {
  const f = await fixture(t); f.api.registerConfigIpc(() => f.mainWindow, () => {});
  const invoke = (channel, raw) => f.state.handlers.get(channel)(f.event(f.mainWindow), raw);
  const revision = f.api.configManager.getRevision();
  assert.deepEqual(invoke(f.api.IPC_CONFIG.SAVE_BATCH, { patch: { mainModelName: 'batch-model', mainThinkingLevel: '' }, expectedRevision: revision }), { revision: revision + 1 });
  const before = f.snapshot();
  for (const [channel, raw] of [
    [f.api.IPC_CONFIG.IMPORT_PREVIEW, { filePath: '/untrusted/path' }],
    [f.api.IPC_CONFIG.PROFILES_IMPORT, { filePath: '/untrusted/path' }],
    [f.api.IPC_CONFIG.IMPORT_COMMIT, { token: 'token', expectedRevision: revision }],
    [f.api.IPC_CONFIG.SAVE_BATCH, { patch: { mainModelName: 'x' }, filePath: '/path' }],
    [f.api.IPC_CONFIG.PROFILES_SWITCH, { id: '../../path' }],
    [f.api.IPC_CONFIG.PROFILES_SAVE, { name: 'invalid', blank: 'yes' }],
  ]) await assert.rejects(async () => invoke(channel, raw));
  assert.deepEqual(f.snapshot(), before); assert.equal(f.state.dialogs.length, 0);
});

test('Muse IPC is registered once, resolves the live window, and rejects every foreign sender', async t => {
  const f = await fixture(t); let live = f.mainWindow;
  f.api.registerMuseIpcHandlers(() => live); const registrationCount = f.state.registrations.length;
  f.api.registerMuseIpcHandlers(() => live); assert.equal(f.state.registrations.length, registrationCount);
  for (const [channel, handler] of f.state.handlers) {
    const response = await handler(f.event(f.window(9)), request());
    assert.equal(response.ok, false, channel); assert.equal(response.code, 'UNTRUSTED_SENDER', channel);
  }
  assert.equal(f.state.calls.length, 0);
  const old = live; live = f.window(2);
  const info = f.state.handlers.get(f.api.IPC_MUSE.APP_INFO);
  assert.equal((await info(f.event(old), request())).code, 'UNTRUSTED_SENDER');
  assert.equal((await info(f.event(live), request())).result.version, '0.7.0-m1-fixture');
  f.state.wake(7); assert.deepEqual(live.sends, [[f.api.IPC_MUSE.CHANGED, { cursor: 7 }]]); assert.equal(old.sends.length, 0);
  live.webContents.mainFrame.url = 'https://external.invalid/'; f.state.wake(8); assert.equal(live.sends.length, 1);
});

test('Muse IPC restricts IDs, cursors, revision and payload keys without execution identity authority', async t => {
  const f = await fixture(t); f.api.registerMuseIpcHandlers(() => f.mainWindow);
  const invoke = (channel, value) => f.state.handlers.get(channel)(f.event(f.mainWindow), value);
  for (const [channel, value] of [
    [f.api.IPC_MUSE.RUN_LIST, request({ conversationId: '../../path' })],
    [f.api.IPC_MUSE.RUN_LIST, request({ runId: 'spoofed-run' })],
    [f.api.IPC_MUSE.ACTIVITY_LIST, request({ afterEventId: -1 })],
    [f.api.IPC_MUSE.ACTIVITY_LIST, request({ throughEventId: 1.5 })],
    [f.api.IPC_MUSE.ARTIFACT_OPEN, request({ artifactId: '/private/file' })],
    [f.api.IPC_MUSE.ARTIFACT_OPEN, request({ artifactId: 'artifact-1', filePath: '/private/file' })],
    [f.api.IPC_MUSE.ARTIFACT_ACCEPT, request({ artifactId: 'artifact-1', accepted: true })],
    [f.api.IPC_MUSE.ARTIFACT_ACCEPT, request({ artifactId: 'artifact-1', accepted: 'yes' }, { expectedRevision: 1 })],
    [f.api.IPC_MUSE.ARTIFACT_INDEX, request({ cursor: 'x'.repeat(513) })],
    [f.api.IPC_MUSE.ARTIFACT_INDEX, request({ limit: 201 })],
    [f.api.IPC_MUSE.APP_INFO, request({}, { mainRunContext: { runId: 'spoofed' } })],
  ]) { const response = await invoke(channel, value); assert.equal(response.code, 'INVALID_REQUEST', channel); }
  assert.equal(f.state.calls.length, 0);
  assert.equal((await invoke(f.api.IPC_MUSE.ACTIVITY_LIST, request({ runId: 'run-1', afterEventId: 3, throughEventId: 9, limit: 10 }))).ok, true);
  assert.deepEqual(f.state.calls[0], { name: 'listActivity', value: { runId: 'run-1', afterEventId: 3, throughEventId: 9, limit: 10 } });
  assert.equal((await invoke(f.api.IPC_MUSE.ARTIFACT_ACCEPT, request({ artifactId: 'artifact-1', accepted: true }, { expectedRevision: 4 }))).ok, true);
  assert.deepEqual(f.state.calls[1].value, { artifactId: 'artifact-1', expectedRevision: 4, accepted: true, requestId: 'request-fixture' });
});

test('native settings menu resolves the replacement window and cannot restart task services', async t => {
  const f = await fixture(t); let live = f.mainWindow;
  f.api.registerNativeMenu(() => live);
  const menu = f.state.menus[0], settings = menu.flatMap(item => item.submenu || []).find(item => item.accelerator === 'CmdOrCtrl+,');
  assert.ok(settings); assert.ok(menu.some(item => (item.submenu || []).some(child => child.role === 'copy')));
  const old = live; live = f.window(2); settings.click();
  assert.equal(live.shown, 1); assert.equal(live.focused, 1); assert.deepEqual(live.sends, [[f.api.IPC_MUSE.OPEN_SETTINGS]]);
  assert.equal(old.sends.length, 0); assert.equal(f.state.calls.length, 0); assert.equal(f.state.registrations.length, 0);
  live.webContents.mainFrame.url = 'https://external.invalid/'; settings.click(); assert.equal(live.sends.length, 1);
  live = null; assert.doesNotThrow(() => settings.click());
});

test('Muse IPC reports stale artifact revision as a conflict without exposing raw details', async t => {
  const f = await fixture(t); f.api.registerMuseIpcHandlers(() => f.mainWindow);
  f.state.calls.push = () => { throw Object.assign(new Error('STALE_REVISION'), { currentRevision: 3 }); };
  const response = await f.state.handlers.get(f.api.IPC_MUSE.ARTIFACT_ACCEPT)(f.event(f.mainWindow),
    request({ artifactId: 'artifact-fixture', accepted: true }, { expectedRevision: 1 }));
  assert.equal(response.ok, false); assert.equal(response.code, 'REVISION_CONFLICT');
  assert.equal(response.currentRevision, 3); assert.equal(response.message, '内容已更新，请刷新后再操作');
});
