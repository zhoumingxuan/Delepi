'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const WORK = path.resolve(__dirname, '../..');

test('real React hook serializes config reads/writes, ignores stale GET and preserves queued drafts after failure', async t => {
  const allowed = path.join(WORK, 'isolated-runs'); fs.mkdirSync(allowed, { recursive: true });
  const root = fs.mkdtempSync(path.join(allowed, 'm1-settings-hook-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await esbuild.build({ entryPoints: [path.join(__dirname, 'settings-browser-entry.tsx')], bundle: true, platform: 'browser', format: 'iife', outfile: path.join(root, 'fixture.js'), define: { 'process.env.NODE_ENV': '"production"' } });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body><script src="fixture.js"></script></body></html>');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_DISABLE_SANDBOX;
  const result = spawnSync(process.execPath, [path.join(__dirname, 'settings-browser-main.cjs'), root], { cwd: WORK, env, encoding: 'utf8', timeout: 30000 });
  const reportPath = path.join(root, 'results.json');
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : { error: result.stderr || String(result.error) };
  assert.equal(result.status, 0, report.error); assert.equal(report.ok, true, report.error); assert.equal(report.results.length, 2);
});
