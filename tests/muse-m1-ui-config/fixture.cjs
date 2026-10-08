'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');
const Database = require('better-sqlite3');
const WORK = path.resolve(__dirname, '../..');
const ALLOWED = path.join(WORK, 'isolated-runs');

async function fixture(t) {
  fs.mkdirSync(ALLOWED, { recursive: true });
  const root = fs.mkdtempSync(path.join(ALLOWED, 'm1-ui-config-'));
  if (!fs.realpathSync(root).startsWith(fs.realpathSync(ALLOWED) + path.sep)) throw new Error('Fixture path escaped');
  const db = new Database(path.join(root, 'config.sqlite'));
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)');
  const state = {
    db, handlers: new Map(), registrations: [], calls: [], menus: [], wake: undefined,
    openResult: { canceled: true, filePaths: [] }, saveResult: { canceled: true }, confirmation: 0,
    dialogs: [],
    fileIo: require('node:fs/promises'),
  };
  state.electron = {
    app: { isPackaged: true, name: 'Delepi Fixture', getVersion: () => '0.7.0-m1-fixture', getPath: () => root },
    ipcMain: { handle: (channel, callback) => {
      if (state.handlers.has(channel)) throw new Error('Duplicate handler: ' + channel);
      state.handlers.set(channel, callback); state.registrations.push(channel);
    } },
    Menu: { buildFromTemplate: template => template, setApplicationMenu: template => state.menus.push(template) },
    dialog: {
      showOpenDialog: async (window, options) => { state.dialogs.push({ kind: 'open', window, options }); return state.openResult; },
      showSaveDialog: async (window, options) => { state.dialogs.push({ kind: 'save', window, options }); return state.saveResult; },
      showMessageBox: async (window, options) => { state.dialogs.push({ kind: 'confirmation', window, options }); return { response: state.confirmation }; },
    },
  };
  const log = (name, value) => { state.calls.push({ name, value }); };
  state.tasks = {
    listRuns: value => { log('listRuns', value); return []; },
    getRun: value => { log('getRun', value); return null; },
    listAttempts: value => { log('listAttempts', value); return []; },
    listActivity: value => { log('listActivity', value); return { events: [], throughEventId: 3, nextAfterEventId: 3, hasMore: false }; },
    listInbox: value => { log('listInbox', value); return []; },
    setWakeListener: callback => { state.wake = callback; },
  };
  state.artifacts = {
    listArtifacts: async value => { log('listArtifacts', value); return { items: [] }; },
    getArtifact: async value => { log('getArtifact', value); return null; },
    openArtifact: async value => { log('openArtifact', value); },
    acceptArtifact: async value => { log('acceptArtifact', value); return { id: value.artifactId, revision: value.expectedRevision + 1 }; },
    indexLegacyArtifacts: async value => { log('indexLegacyArtifacts', value); return { scanned: 0, indexed: 0, skipped: 0, errors: 0, done: true }; },
  };
  const previous = globalThis.__m1UiConfigFixture;
  globalThis.__m1UiConfigFixture = state;
  const result = await esbuild.build({
    stdin: { contents: [
      'export * from "./src/main/modules/config/config-manager";',
      'export * from "./src/main/modules/config/config-profile-service";',
      'export * from "./src/main/modules/config/config-profile-io";',
      'export * from "./src/main/modules/config/settings-transaction";',
      'export * from "./src/main/modules/config/config-ipc";',
      'export * from "./src/main/ipc/trusted-sender";',
      'export * from "./src/main/modules/native-menu";',
      'export * from "./src/main/modules/muse-ipc";',
      'export * from "./src/shared/ipc-channels";',
      'export * from "./src/shared/constants";',
    ].join('\n'), resolveDir: WORK },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'strict-fixture-boundaries', setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }));
      build.onResolve({ filter: /^node:fs\/promises$/ }, () => ({ path: 'fileIo', namespace: 'fixture' }));
      build.onResolve({ filter: /(?:^|\/)db$/ }, () => ({ path: 'db', namespace: 'fixture' }));
      build.onResolve({ filter: /tasks\/task-service$/ }, () => ({ path: 'tasks', namespace: 'fixture' }));
      build.onResolve({ filter: /artifacts\/service$/ }, () => ({ path: 'artifacts', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: boundary }) => {
        const sources = {
          electron: 'const e=globalThis.__m1UiConfigFixture.electron; export const app=e.app,ipcMain=e.ipcMain,Menu=e.Menu,dialog=e.dialog;',
          fileIo: 'const invoke=(name,args)=>globalThis.__m1UiConfigFixture.fileIo[name](...args); export const open=(...args)=>invoke("open",args),lstat=(...args)=>invoke("lstat",args),rename=(...args)=>invoke("rename",args),unlink=(...args)=>invoke("unlink",args);',
          db: 'export const getDb=()=>globalThis.__m1UiConfigFixture.db; export const listSettings=()=>Object.fromEntries(getDb().prepare("SELECT key,value_json FROM settings").all().map(r=>[r.key,JSON.parse(r.value_json)]));',
          tasks: 'export const getTaskService=()=>globalThis.__m1UiConfigFixture.tasks;',
          artifacts: 'const a=globalThis.__m1UiConfigFixture.artifacts; export const listArtifacts=a.listArtifacts,getArtifact=a.getArtifact,openArtifact=a.openArtifact,acceptArtifact=a.acceptArtifact,indexLegacyArtifacts=a.indexLegacyArtifacts;',
        };
        return { contents: sources[boundary], loader: 'js' };
      });
    } }],
  });
  const filename = path.join(root, 'main', 'fixture.cjs');
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = module.paths;
  loaded._compile(result.outputFiles[0].text, filename);
  const api = loaded.exports;
  api.configManager.reload();
  const pageUrl = pathToFileURL(path.join(root, 'renderer', 'index.html')).href;
  function window(id = 1, url = pageUrl) {
    const sends = [], frame = { url, parent: null };
    const webContents = { id, mainFrame: frame, destroyed: false, isDestroyed() { return this.destroyed; }, getURL: () => frame.url, send: (...args) => sends.push(args) };
    return { webContents, sends, destroyed: false, shown: 0, focused: 0, isDestroyed() { return this.destroyed; }, show() { this.shown++; }, focus() { this.focused++; } };
  }
  const mainWindow = window();
  const event = target => ({ sender: target.webContents, senderFrame: target.webContents.mainFrame });
  const snapshot = () => db.prepare('SELECT * FROM settings ORDER BY key').all();
  t.after(() => { globalThis.__m1UiConfigFixture = previous; db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, state, api, window, mainWindow, event, snapshot, pageUrl };
}
module.exports = { fixture };
