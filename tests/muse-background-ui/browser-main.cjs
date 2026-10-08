'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const fixtureRoot = path.resolve(process.argv[2]);
const allowed = path.resolve(__dirname, '../../isolated-runs');
if (!fs.realpathSync(fixtureRoot).startsWith(fs.realpathSync(allowed) + path.sep)) throw Error('Autonomy fixture path escaped');
app.setName('Delepi Background UI Fixture'); app.setPath('userData', fixtureRoot); app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await window.loadFile(path.join(fixtureRoot, 'index.html'));
    const results = await window.webContents.executeJavaScript('window.__runBackgroundScenarios()');
    fs.writeFileSync(path.join(fixtureRoot, 'results.json'), JSON.stringify({ ok: true, results })); window.destroy(); app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(fixtureRoot, 'results.json'), JSON.stringify({ ok: false, error: error.stack || String(error) })); window.destroy(); app.exit(1);
  }
});
