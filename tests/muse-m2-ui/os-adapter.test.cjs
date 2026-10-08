'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixture.cjs');
const options = (changes = {}) => ({ platform: 'darwin', client: 'synthetic installed client', usageDescriptions: { camera: true, microphone: true }, preferences: {}, shell: { openExternal: async () => {}, openPath: async () => '' }, now: () => '2030-01-01T00:00:00.000Z', ...changes });
test('read-only status never prompts, captures media, requests accessibility or opens settings', async t => {
  const f = await fixture(t), calls = [], adapter = f.api.createElectronOsAdapter(options({ preferences: {
    getMediaAccessStatus: kind => { calls.push(['query', kind]); return kind === 'camera' ? 'granted' : kind === 'microphone' ? 'not-determined' : 'denied'; },
    isTrustedAccessibilityClient: prompt => { calls.push(['accessibility', prompt]); return false; },
    askForMediaAccess: () => { throw Error('A query must never request'); },
  }, shell: { openExternal: () => { throw Error('A query must never open settings'); }, openPath: () => { throw Error('A query must never open settings'); } } }));
  const rows = await adapter.status(); assert.equal(rows.length, 7);
  assert.deepEqual(calls, [['query', 'camera'], ['query', 'microphone'], ['query', 'screen'], ['accessibility', false]]);
  assert.equal(rows[0].status, 'granted'); assert.equal(rows[0].requestSupported, false);
  assert.equal(rows[1].status, 'unknown'); assert.equal(rows[1].requestSupported, true);
  assert.equal(rows[2].status, 'not-granted'); assert.equal(rows[2].requestSupported, false);
  for (const kind of ['inputMonitoring', 'automation', 'fullDisk']) { const row = rows.find(item => item.kind === kind); assert.equal(row.status, 'unknown'); assert.equal(row.querySupported, false); assert.equal(row.requestSupported, false); assert.equal(row.settingsSupported, true); }
});
test('explicit media request re-queries system state and never treats a returned success as a granted permission', async t => {
  const f = await fixture(t), calls = [], adapter = f.api.createElectronOsAdapter(options({ preferences: {
    getMediaAccessStatus: kind => { calls.push(['query', kind]); return 'not-determined'; },
    askForMediaAccess: async kind => { calls.push(['request', kind]); return true; },
  } }));
  const row = await adapter.request('camera'); assert.equal(row.status, 'unknown');
  assert.deepEqual(calls, [['query', 'camera'], ['request', 'camera'], ['query', 'camera']]);
});
test('missing usage declarations, unsupported permissions and foreign platforms cannot request TCC', async t => {
  const f = await fixture(t); let requests = 0;
  const preferences = { getMediaAccessStatus: () => 'not-determined', askForMediaAccess: async () => { requests++; return true; } };
  const absent = f.api.createElectronOsAdapter(options({ preferences, usageDescriptions: {} }));
  assert.equal((await absent.query('camera')).requestSupported, false);
  await assert.rejects(absent.request('camera'), /OS_USAGE_DESCRIPTION_MISSING/);
  for (const kind of ['screen', 'inputMonitoring', 'automation', 'fullDisk']) await assert.rejects(absent.request(kind), /OS_REQUEST_UNSUPPORTED/);
  const windows = f.api.createElectronOsAdapter(options({ platform: 'win32', preferences }));
  assert.equal((await windows.query('camera')).requestSupported, false); await assert.rejects(windows.request('camera'), /OS_REQUEST_UNSUPPORTED/);
  const linux = f.api.createElectronOsAdapter(options({ platform: 'linux', preferences }));
  assert.equal((await linux.query('camera')).querySupported, false); assert.deepEqual(await linux.openSettings('camera'), { opened: false });
  assert.equal(requests, 0);
});
test('parallel explicit requests are serialized and a completed request releases the busy guard', async t => {
  const f = await fixture(t); let complete, requests = 0;
  const adapter = f.api.createElectronOsAdapter(options({ preferences: { getMediaAccessStatus: () => 'not-determined', askForMediaAccess: () => { requests++; return new Promise(resolve => { complete = resolve; }); } } }));
  const first = adapter.request('camera'); await assert.rejects(adapter.request('microphone'), /OS_REQUEST_BUSY/); assert.equal(requests, 1);
  complete(false); await first;
  const second = adapter.request('microphone'); assert.equal(requests, 2); complete(false); await second;
});
test('accessibility prompts only after explicit request and failed queries remain unknown without raw details', async t => {
  const f = await fixture(t), calls = [], adapter = f.api.createElectronOsAdapter(options({ preferences: {
    isTrustedAccessibilityClient: prompt => { calls.push(prompt); return false; },
    getMediaAccessStatus: () => { throw Error('private path /Users/private'); },
  } }));
  assert.equal((await adapter.query('accessibility')).status, 'not-granted'); assert.deepEqual(calls, [false]);
  assert.equal((await adapter.request('accessibility')).status, 'not-granted'); assert.deepEqual(calls, [false, true, false]);
  const row = await adapter.query('camera'); assert.equal(row.status, 'unknown'); assert.equal(row.requestSupported, false); assert.ok(!row.detail.includes('private'));
});
test('system settings use a fixed allowlist and fallback failures report unopened instead of granting permission', async t => {
  const f = await fixture(t), calls = [], adapter = f.api.createElectronOsAdapter(options({ shell: {
    openExternal: async url => { calls.push(url); throw Error('fixture open failed'); },
    openPath: async filename => { calls.push(filename); return 'could not open'; },
  } }));
  assert.deepEqual(await adapter.openSettings('fullDisk'), { opened: false });
  assert.deepEqual(calls, ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles', '/System/Applications/System Settings.app']);
  await assert.rejects(adapter.openSettings('../../private'), /INVALID_REQUEST/); assert.equal(calls.length, 2);
  const windowsCalls = [], windows = f.api.createElectronOsAdapter(options({ platform: 'win32', shell: { openExternal: async url => { windowsCalls.push(url); }, openPath: async () => '' } }));
  assert.deepEqual(await windows.openSettings('camera'), { opened: true }); assert.deepEqual(windowsCalls, ['ms-settings:privacy-webcam']); assert.deepEqual(await windows.openSettings('fullDisk'), { opened: false });
});
