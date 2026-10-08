// Keep native SQLite on the Electron ABI and run the bounded background suites.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const tests = fs.readdirSync(path.join(root, 'tests'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.startsWith('muse-background'))
  .flatMap(entry => fs.readdirSync(path.join(root, 'tests', entry.name))
    .filter(name => name.endsWith('.test.cjs')).map(name => path.join('tests', entry.name, name)));
if (!tests.length) throw Error('No background tests found');
const result = spawnSync(require('electron'), ['--test', ...tests], {
  cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
