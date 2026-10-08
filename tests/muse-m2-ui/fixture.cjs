'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');
const WORK = path.resolve(__dirname, '../..');
async function fixture(t) {
  const allowed = path.join(WORK, 'isolated-runs'); fs.mkdirSync(allowed, { recursive: true });
  const root = fs.mkdtempSync(path.join(allowed, 'm2-ipc-ui-'));
  const state = { handlers: new Map(), calls: [], bridgeCalls: [], subscriptions: [], api: null };
  const log = (name, result) => (...args) => { state.calls.push({ name, args }); return result; };
  state.services = {
    goals: { list: log('goals.list', []), get: log('goals.get', { goal: {}, resources: [] }), listDestinations: log('goals.listDestinations', []), create: log('goals.create', { id: 'goal-new' }), update: log('goals.update', { id: 'goal-updated' }), setState: log('goals.setState', {}) },
    authority: { listApprovals: log('authority.listApprovals', []), decideApproval: log('authority.decideApproval', { revision: 2 }), previewRule: log('authority.previewRule', {}), issueRule: log('authority.issueRule', {}), listRules: log('authority.listRules', []), revokeRule: log('authority.revokeRule'), listGrants: log('authority.listGrants', []), revokeGrant: log('authority.revokeGrant'), getPolicy: log('authority.getPolicy', {}), updatePolicy: log('authority.updatePolicy', {}), assertOsRequest: log('authority.assertOsRequest') },
    os: { status: log('os.status', []), request: log('os.request', {}), openSettings: log('os.openSettings', { opened: true }) },
  };
  state.electron = {
    app: { isPackaged: true }, systemPreferences: {}, shell: {},
    ipcMain: { handle: (channel, callback) => { if (state.handlers.has(channel)) throw Error('Duplicate handler'); state.handlers.set(channel, callback); } },
    contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'electronAPI') state.api = value; } },
    ipcRenderer: { invoke: async (...args) => { state.bridgeCalls.push(args); return { ok: true, result: {} }; }, send: (...args) => state.bridgeCalls.push(args), on: (channel, callback) => state.subscriptions.push({ channel, callback }), removeListener: (channel, callback) => { state.subscriptions = state.subscriptions.filter(item => item.channel !== channel || item.callback !== callback); } },
  };
  const previous = globalThis.__m2UiFixture; globalThis.__m2UiFixture = state;
  const result = await esbuild.build({ stdin: { contents: [
    'export * from "./src/main/modules/autonomy-ipc";', 'export * from "./src/main/modules/permissions/os-adapter";',
    'export * from "./src/main/modules/goals/goal-service";', 'export * from "./src/shared/ipc-channels";',
    'import "./src/preload/preload";',
  ].join('\n'), resolveDir: WORK }, bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'electron-boundary', setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'const e=globalThis.__m2UiFixture.electron;export const app=e.app,systemPreferences=e.systemPreferences,shell=e.shell,ipcMain=e.ipcMain,contextBridge=e.contextBridge,ipcRenderer=e.ipcRenderer;', loader: 'js' }));
  } }] });
  const filename = path.join(root, 'main', 'fixture.cjs'), loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = module.paths; loaded._compile(result.outputFiles[0].text, filename);
  const pageUrl = pathToFileURL(path.join(root, 'renderer', 'index.html')).href;
  function window(id = 1, url = pageUrl) {
    const sends = [], frame = { url, parent: null };
    const webContents = { id, mainFrame: frame, destroyed: false, isDestroyed() { return this.destroyed; }, getURL: () => frame.url, send: (...args) => sends.push(args) };
    return { webContents, sends, destroyed: false, isDestroyed() { return this.destroyed; } };
  }
  const event = target => ({ sender: target.webContents, senderFrame: target.webContents.mainFrame });
  const mainWindow = window();
  t.after(() => { globalThis.__m2UiFixture = previous; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, state, api: loaded.exports, mainWindow, window, event, pageUrl };
}
module.exports = { fixture };
