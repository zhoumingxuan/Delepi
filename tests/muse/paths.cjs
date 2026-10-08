'use strict';
const fs = require('node:fs');
const path = require('node:path');
const WORK = path.resolve(__dirname, '../..');
const RUNS = path.join(WORK, 'isolated-runs');

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep)
    && relative !== '..' && !path.isAbsolute(relative));
}
function checked(target, parent = WORK, { missing = false } = {}) {
  const absolute = path.resolve(target);
  if (!inside(parent, absolute)) throw Error('Fixture path escape: ' + absolute);
  let existing = absolute;
  while (!fs.existsSync(existing)) {
    if (!missing) throw Error('Missing fixture path: ' + absolute);
    existing = path.dirname(existing);
  }
  if (!inside(fs.realpathSync(parent), fs.realpathSync(existing))) {
    throw Error('Fixture symlink escape: ' + absolute);
  }
  return absolute;
}
function newRun() {
  fs.mkdirSync(RUNS, { recursive: true });
  const root = fs.mkdtempSync(path.join(RUNS, 'm0-'));
  for (const folder of ['final', 'output']) fs.mkdirSync(path.join(root, folder));
  return root;
}
module.exports = { WORK, RUNS, inside, checked, newRun };
