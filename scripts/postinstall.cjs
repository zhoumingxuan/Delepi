#!/usr/bin/env node
/*
 * postinstall.cjs - Cross-platform wrapper for fix-electron-binary.ps1
 *
 * npm automatically runs "postinstall" after "npm install". This wrapper:
 *   - On Windows (process.platform === 'win32'):
 *       spawn powershell.exe with the bundled PowerShell script
 *   - On macOS / Linux:
 *       skip the PowerShell script (npm install's own postinstall already
 *       invokes @electron/get install.js; on non-Windows, @electron/get
 *       uses different binary paths and is normally self-sufficient once
 *       the mirror is configured via .npmrc).
 *
 * Exit codes propagate from the PowerShell script:
 *   0 = success / no action needed
 *   1 = fatal error
 *   2 = auto-repaired, user attention recommended
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPT_DIR = __dirname;
const PS1 = path.join(SCRIPT_DIR, 'fix-electron-binary.ps1');

function log(msg) {
  process.stdout.write('[postinstall] ' + msg + '\n');
}

if (process.platform === 'win32') {
  if (!fs.existsSync(PS1)) {
    log('FATAL: PowerShell script not found: ' + PS1);
    process.exit(1);
  }
  log('Windows detected, invoking fix-electron-binary.ps1 ...');
  const r = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', PS1
  ], { stdio: 'inherit' });
  if (r.error) {
    log('FATAL: spawn failed: ' + r.error.message);
    process.exit(1);
  }
  if (typeof r.status === 'number') {
    process.exit(r.status);
  }
  process.exit(0);
} else {
  log('Non-Windows platform (' + process.platform + '); skipping fix-electron-binary.ps1');
  log('  Note: .npmrc electron_mirror still applies to npm-time electron downloads.');
  process.exit(0);
}
