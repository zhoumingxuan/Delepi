'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { WORK, newRun, checked } = require('./paths.cjs');
const { createLoader } = require('./controlled-loader.cjs');

function fixture(t) {
  const root = newRun();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scriptsDir = path.join(root, 'userData', 'script-tools');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const guardedFs = {};
  for (const method of ['existsSync', 'mkdirSync']) guardedFs[method] = (target, ...args) => {
    checked(target, root, { missing: true });
    return fs[method](target, ...args);
  };
  const guardedPromises = {};
  for (const method of ['readFile', 'readdir', 'stat']) guardedPromises[method] = async (target, ...args) => {
    checked(target, root);
    return fsp[method](target, ...args);
  };
  const mocks = {
    'node:fs': guardedFs,
    'node:fs/promises': guardedPromises,
    'node:os': { tmpdir: () => root },
    'node:child_process': { spawn: () => { throw new Error('Experience fixture forbids all child processes'); } },
    'js-yaml': require(checked(path.join(WORK, 'node_modules', 'js-yaml'))),
    electron: { app: { isPackaged: true, getPath: (name) => path.join(root, name) } },
    [path.join(WORK, 'src/main/modules/config/config-manager.ts')]: {
      configManager: { getSettings: () => { throw new Error('Experience view must not use model or Python settings'); } },
    },
    [path.join(WORK, 'src/main/modules/python/index.ts')]: {
      pythonManager: { getPythonPath: () => { throw new Error('Experience view must not launch Python'); } },
    },
    [path.join(WORK, 'src/main/utils/index.ts')]: { ensureErrorMessage: (error) => String(error.message || error) },
  };
  const loader = createLoader({ root, mocks });
  const { scanScriptToolsDir } = loader.load('src/main/tools/script-tool-protocol.ts');
  const { scriptTool } = loader.load('src/main/tools/script-tool.ts');
  function addTool(name, protocolOverride) {
    const directory = path.join(scriptsDir, name);
    fs.mkdirSync(directory);
    const protocol = protocolOverride ?? [
      `name: ${name}`, `title: ${name}`, 'description: synthetic fixture',
      'inputSchema:', '  type: object', '  properties:', '    fixture:', '      type: string',
      'timeout_seconds: 30', 'applicable_conditions: synthetic fixture only',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(directory, 'protocol.yaml'), protocol);
    fs.writeFileSync(path.join(directory, 'main.py'), '# synthetic fixture, never executed\n');
    return { directory, protocol };
  }
  function snapshot() {
    const hashes = {};
    for (const directory of fs.readdirSync(scriptsDir).sort()) {
      for (const filename of fs.readdirSync(path.join(scriptsDir, directory)).sort()) {
        const relative = path.join(directory, filename);
        hashes[relative] = crypto.createHash('sha256').update(fs.readFileSync(path.join(scriptsDir, relative))).digest('hex');
      }
    }
    return hashes;
  }
  return { root, scriptsDir, scan: scanScriptToolsDir, view: (input = {}) => scriptTool({ action: '查看协议', ...input }, { runDir: root }), addTool, snapshot };
}

test('S01 真空库查看协议成功且不创建首批活动工具', async (t) => {
  const f = fixture(t);
  const result = await f.view();
  assert.equal(result.success, true);
  assert.equal(result.data.tools.length, 0);
  assert.match(result.message, /当前任务可继续正常执行/);
  assert.match(result.message, /待验证的维护建议/);
  assert.deepEqual(fs.readdirSync(f.scriptsDir), []);
});

test('S02 33个真实旧工具仅返回32项；源码/协议逐文件hash全部不变', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 33; i++) f.addTool('old_' + String(i).padStart(2, '0'));
  const before = f.snapshot();
  const entries = await f.scan();
  assert.equal(entries.filter((entry) => entry.ok).length, 32);
  const result = await f.view();
  assert.equal(result.success, true);
  assert.equal(result.data.tools.length, 32);
  assert.equal(fs.readdirSync(f.scriptsDir).length, 33);
  assert.deepEqual(f.snapshot(), before);
});

test('S03 旧工具协议原样可查看；无效协议目录保留并报告具体错误', async (t) => {
  const f = fixture(t);
  const valid = f.addTool('old_valid');
  f.addTool('invalid_fields', 'name: invalid_fields\ninputSchema:\n  type: object\nrevision: unrecognized\n');
  f.addTool('invalid_yaml', 'name: [unterminated\n');
  const before = f.snapshot();
  const single = await f.view({ tool_name: 'old_valid' });
  assert.equal(single.success, true);
  assert.equal(single.data.protocol_text, valid.protocol);
  assert.equal(single.data.protocol.name, 'old_valid');
  const result = await f.view();
  assert.equal(result.success, true);
  assert.equal(result.data.tools.length, 1);
  assert.equal(result.data.invalid_tools.length, 2);
  assert.ok(result.data.invalid_tools.every((tool) => tool.code === 'PROTOCOL_INVALID'));
  assert.ok(result.data.invalid_tools.some((tool) => /revision/.test(tool.error)));
  assert.deepEqual(f.snapshot(), before);
});
