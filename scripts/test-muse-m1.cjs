// Native SQLite is built for the app's Electron ABI. Run its Node mode, not the host Node ABI.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const tests = fs.readdirSync(path.join(root, 'tests'), {withFileTypes: true})
  .filter(e => e.isDirectory() && e.name.startsWith('muse-m1'))
  .flatMap(e => fs.readdirSync(path.join(root, 'tests', e.name))
    .filter(n => n.endsWith('.test.cjs')).map(n => path.join('tests', e.name, n)));
if (!tests.length) throw new Error('No M1 tests found');
const result = spawnSync(require('electron'), ['--test', ...tests], {
  cwd: root, env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
