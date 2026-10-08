'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const { antdFixture } = require('./ui-controls.cjs');
const WORK = path.resolve(__dirname, '../..');
test('real React background controls enforce scope confirmation, live CAS, pause, terminal stop and learning rollback', async t => {
  const allowed = path.join(WORK, 'isolated-runs'); fs.mkdirSync(allowed, { recursive: true });
  const root = fs.mkdtempSync(path.join(allowed, 'background-ui-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await esbuild.build({ entryPoints: [path.join(__dirname, 'drawer-browser-entry.tsx')], bundle: true, platform: 'browser', format: 'iife', outfile: path.join(root, 'fixture.js'), define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'ui-fixture-controls', setup(build) {
    build.onResolve({ filter: /^antd$/ }, () => ({ path: 'antd-fixture', namespace: 'fixture' }));
    build.onResolve({ filter: /^@ant-design\/icons$/ }, () => ({ path: 'icons-fixture', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'antd-fixture' ? antdFixture : 'export const PlusOutlined=()=>null,ReloadOutlined=()=>null,SafetyCertificateOutlined=()=>null;', loader: 'tsx', resolveDir: WORK }));
  } }] });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body><script src="fixture.js"></script></body></html>');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_DISABLE_SANDBOX;
  const result = spawnSync(process.execPath, [path.join(__dirname, 'browser-main.cjs'), root], { cwd: WORK, env, encoding: 'utf8', timeout: 30000 });
  const reportFile = path.join(root, 'results.json'), report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : { error: result.stderr || String(result.error) };
  assert.equal(result.status, 0, report.error); assert.equal(report.ok, true, report.error); assert.equal(report.results.length, 10);
  for (const scenario of report.results) t.diagnostic(scenario);
});
