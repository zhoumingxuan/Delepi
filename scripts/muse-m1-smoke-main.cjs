// Isolated GUI only: caller provides a freshly-created temp fixture. Never use production userData.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {app, BrowserWindow, Menu} = require('electron');
const fixture = fs.realpathSync(process.env.MUSE_SMOKE_FIXTURE || '');
const tempRoot = fs.realpathSync(os.tmpdir());
if (!fixture.startsWith(tempRoot + path.sep) || !fs.existsSync(path.join(fixture, 'synthetic-fixture.json'))) {
  throw new Error('A synthetic temp fixture is required');
}
app.setPath('userData', path.join(fixture, 'userData'));
app.setName('Delepi M1 Isolated Smoke');
process.chdir(fixture);
delete process.env.VITE_DEV_SERVER_URL;
delete process.env.ELECTRON_RUN_AS_NODE;
const compiledMain=path.resolve(process.env.MUSE_SMOKE_COMPILED_MAIN || path.resolve(__dirname, '../dist/main/index.js'));
if(compiledMain.startsWith('/Applications/'))throw new Error('Installed application is forbidden in isolated smoke');
require(compiledMain);
// Reviewable smoke controls, present only in this launcher, never in the app bundle.
app.whenReady().then(() => {
  globalThis.__museSmoke = {
    openSettings() {
      const visit = items => {for (const item of items) {
        if (item.label === '设置…') {item.click();return true;}
        if (item.submenu && visit(item.submenu.items)) return true;
      }return false;};
      return visit(Menu.getApplicationMenu()?.items ?? []);
    },
    recreateMain() {
      for (const window of BrowserWindow.getAllWindows()) window.close();
      setTimeout(() => app.emit('activate'), 100);
    },
    quit() { app.quit(); },
  };
});
