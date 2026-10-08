'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { newRun, checked } = require('./paths.cjs');
const { createLoader } = require('./controlled-loader.cjs');

const SOURCE = 'src/main/modules/executor-agent/task-cleanup.ts';
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture(t, hooks = {}) {
  const root = newRun();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const removals = [];
  const calls = new Map();
  const operations = {};
  for (const method of ['lstat', 'realpath', 'readdir', 'rm']) {
    operations[method] = async (target, ...args) => {
      checked(target, root, { missing: true });
      const key = method + ':' + target;
      const count = (calls.get(key) || 0) + 1;
      calls.set(key, count);
      await hooks.before?.({ method, target, count, root });
      if (method === 'rm') removals.push(target);
      const result = await fsp[method](target, ...args);
      await hooks.after?.({ method, target, count, result, root });
      return result;
    };
  }
  const loader = createLoader({ root, mocks: { 'node:fs/promises': operations } });
  const { cleanupTaskTemporaryPaths } = loader.load(SOURCE);
  const workspace = path.join(root, 'final');
  function write(relative, body = 'synthetic fixture') {
    const target = path.join(root, relative);
    checked(target, root, { missing: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    return target;
  }
  return { root, workspace, write, removals, cleanup: cleanupTaskTemporaryPaths };
}

function hashTree(root) {
  const hashes = {};
  function visit(target) {
    const stat = fs.lstatSync(target);
    const relative = path.relative(root, target);
    if (stat.isSymbolicLink()) hashes[relative] = 'link:' + fs.readlinkSync(target);
    else if (stat.isDirectory()) {
      hashes[relative] = 'directory';
      for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name));
    } else hashes[relative] = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  }
  visit(root);
  return hashes;
}

test('C01 userData内任务workspace正常清临时，持久库/inputs/交付物hash保留', async (t) => {
  const f = fixture(t);
  const userData = path.join(f.root, 'userData');
  const workspace = path.join(userData, 'bin', 'conversations', 'C', 'tasks', 'T');
  fs.mkdirSync(workspace, { recursive: true });
  const protectedPaths = [
    f.write('userData/script-tools/old/main.py', 'old experience'),
    f.write('userData/custom-skills/old/template.md', 'custom workflow'),
    f.write('userData/builtin-skill-overrides/old.md', 'builtin override'),
    f.write('userData/dyn-tools/old/main.py', 'dynamic tool'),
    f.write('userData/python-runtime/bin/python3', 'runtime fixture'),
    f.write('userData/data/delepi.db', 'chat database fixture'),
    f.write('userData/config.json', 'settings fixture'),
    f.write('userData/bin/conversations/C/uploads/input.txt', 'uploaded fixture'),
    f.write('userData/bin/output/result.txt', 'delivered copy'),
    f.write('userData/bin/conversations/C/tasks/T/summary.md', 'summary'),
    f.write('userData/bin/conversations/C/tasks/T/deliverable.md', 'delivered source'),
  ];
  const temporary = f.write('userData/bin/conversations/C/tasks/T/tmp/generated.txt');
  const protectedHashes = Object.fromEntries(protectedPaths.map((p) => [p, fs.readFileSync(p, 'utf8')]));
  const result = await f.cleanup({ workspaceDir: workspace, temporaryPaths: [path.dirname(temporary), ...protectedPaths, userData], protectedPaths });
  assert.deepEqual(plain(result.removedPaths), [path.dirname(temporary)]);
  assert.equal(result.failedPaths.length, 0);
  assert.equal(result.deferredPaths.length, protectedPaths.length + 1);
  for (const [target, body] of Object.entries(protectedHashes)) assert.equal(fs.readFileSync(target, 'utf8'), body);
  assert.ok(fs.statSync(workspace).isDirectory());
});

test('C02 workspace根/祖先/其他任务/外部普通临时/前缀相似目录全部延后', async (t) => {
  const f = fixture(t);
  const paths = [f.workspace, f.root, f.write('other-task/temp.txt'), f.write('final-other/temp.txt'), f.write('outside.txt')];
  paths.push(path.join(f.workspace, '..', 'outside.txt'));
  const before = hashTree(f.root);
  const result = await f.cleanup({ workspaceDir: f.workspace, temporaryPaths: paths, protectedPaths: [] });
  assert.equal(result.removedPaths.length, 0);
  assert.equal(result.failedPaths.length, 0);
  assert.equal(result.deferredPaths.length, paths.length - 1); // duplicate normalized outside.txt
  assert.equal(result.deferredPaths[0].reason, 'workspace_root');
  assert.ok(result.deferredPaths.slice(1).every((p) => p.reason === 'outside_workspace'));
  assert.deepEqual(hashTree(f.root), before);
  assert.equal(f.removals.length, 0);
});

test('C03 protected根、后代、含保护对象的祖先均保留，普通兄弟可清', async (t) => {
  const f = fixture(t);
  const input = f.write('final/inputs/user.txt', 'input');
  const delivered = f.write('final/artifacts/nested/result.md', 'delivery');
  const temporary = f.write('final/tmp/trash.txt');
  const paths = [input, path.dirname(input), delivered, path.dirname(delivered), path.join(f.workspace, 'artifacts'), temporary];
  const result = await f.cleanup({ workspaceDir: f.workspace, temporaryPaths: paths, protectedPaths: [path.dirname(input), delivered] });
  assert.deepEqual(plain(result.removedPaths), [temporary]);
  assert.ok(result.deferredPaths.every((p) => p.reason === 'protected_path'));
  assert.equal(fs.readFileSync(input, 'utf8'), 'input');
  assert.equal(fs.readFileSync(delivered, 'utf8'), 'delivery');
});

test('C04 仅可信workspace后代可删，嵌套目录、空目录、..开头普通名称可清', async (t) => {
  const f = fixture(t);
  const nested = f.write('final/nested/a/b.txt');
  const dots = f.write('final/..cache/临时.txt');
  const empty = path.join(f.workspace, 'empty');
  fs.mkdirSync(empty);
  const result = await f.cleanup({ workspaceDir: f.workspace, temporaryPaths: [path.dirname(path.dirname(nested)), dots, empty], protectedPaths: [] });
  assert.equal(result.removedPaths.length, 3);
  assert.equal(result.deferredPaths.length, 0);
  assert.equal(result.failedPaths.length, 0);
  assert.ok(fs.existsSync(f.workspace));
});

test('C05 target及其workspace内父链symlink逃逸均拒绝，不删除外部或内部目标', async (t) => {
  const f = fixture(t);
  const external = f.write('external/keep.txt', 'external protected');
  const internal = f.write('final/keep.txt', 'internal kept');
  fs.symlinkSync(external, path.join(f.workspace, 'file-link'));
  fs.symlinkSync(path.dirname(external), path.join(f.workspace, 'dir-link'));
  fs.symlinkSync(internal, path.join(f.workspace, 'internal-link'));
  const before = hashTree(f.root);
  const result = await f.cleanup({ workspaceDir: f.workspace, temporaryPaths: [path.join(f.workspace, 'file-link'), path.join(f.workspace, 'dir-link', 'keep.txt'), path.join(f.workspace, 'internal-link')], protectedPaths: [] });
  assert.ok(result.deferredPaths.every((p) => p.reason === 'symlink'));
  assert.equal(result.removedPaths.length, 0);
  assert.deepEqual(hashTree(f.root), before);
  assert.equal(f.removals.length, 0);
});

test('C06 要删除的目录子树有symlink时保留整棵树', async (t) => {
  const f = fixture(t);
  const external = f.write('outside/keep.txt', 'outside');
  f.write('final/tmp/ordinary.txt');
  fs.symlinkSync(path.dirname(external), path.join(f.workspace, 'tmp', 'link'));
  const before = hashTree(f.root);
  const result = await f.cleanup({ workspaceDir: f.workspace, temporaryPaths: [path.join(f.workspace, 'tmp')], protectedPaths: [] });
  assert.equal(result.deferredPaths[0].reason, 'symlink');
  assert.deepEqual(hashTree(f.root), before);
  assert.equal(f.removals.length, 0);
});

test('C07 workspace缺失、relative、文件或自身symlink不能产生清理授权', async (t) => {
  const f = fixture(t);
  const temporary = f.write('final/temp.txt');
  const file = f.write('not-workspace');
  const linked = path.join(f.root, 'linked-workspace');
  fs.symlinkSync(f.workspace, linked);
  for (const workspaceDir of [undefined, '', 'final', path.join(f.root, 'missing'), file, linked]) {
    const result = await f.cleanup({ workspaceDir, temporaryPaths: [temporary], protectedPaths: [] });
    assert.equal(result.deferredPaths[0].reason, 'workspace_unavailable');
    assert.ok(fs.existsSync(temporary));
  }
  assert.equal(f.removals.length, 0);
});

test('C08 protected symlink别名按真实目标保护；不存在的可选根也保护祖先', async (t) => {
  const f = fixture(t);
  const kept = f.write('final/kept/data.txt');
  const alias = path.join(f.root, 'protected-alias');
  fs.symlinkSync(path.dirname(kept), alias);
  const container = f.write('final/future-library-container/temp.txt');
  const temporary = f.write('final/ordinary.txt');
  const result = await f.cleanup({ workspaceDir: f.workspace,
    temporaryPaths: [path.dirname(kept), path.dirname(container), temporary],
    protectedPaths: [alias, path.join(path.dirname(container), 'future-library'), path.join(f.root, 'not-created-yet')] });
  assert.deepEqual(plain(result.removedPaths), [temporary]);
  assert.ok(result.deferredPaths.every((p) => p.reason === 'protected_path'));
  assert.ok(fs.existsSync(kept));
  assert.ok(fs.existsSync(container));
});

test('C09 无法确认protected ref或坏链接时整批延后，不能宽松回退', async (t) => {
  const f = fixture(t);
  const temporary = f.write('final/temp.txt');
  const broken = path.join(f.root, 'broken');
  fs.symlinkSync(path.join(f.root, 'missing-target'), broken);
  for (const protectedPaths of [['relative'], [broken]]) {
    const result = await f.cleanup({ workspaceDir: f.workspace, temporaryPaths: [temporary], protectedPaths });
    assert.equal(result.deferredPaths[0].reason, 'protection_unresolved');
    assert.ok(fs.existsSync(temporary));
  }
  assert.equal(f.removals.length, 0);
});

test('C10 非绝对/空/无效/不存在/无法解析路径延后', async (t) => {
  let inaccessible;
  const f = fixture(t, { before({ method, target }) {
    if (method === 'lstat' && target === inaccessible) throw Object.assign(new Error('synthetic access error'), { code: 'EACCES' });
  } });
  inaccessible = f.write('final/inaccessible.txt');
  const result = await f.cleanup({ workspaceDir: f.workspace, temporaryPaths: ['', 'relative.txt', '/invalid\0path', path.join(f.workspace, 'missing'), inaccessible], protectedPaths: [] });
  assert.deepEqual(plain(result.deferredPaths.map((p) => p.reason)), ['invalid_path', 'invalid_path', 'invalid_path', 'path_unresolved', 'path_unresolved']);
  assert.equal(f.removals.length, 0);
  assert.ok(fs.existsSync(inaccessible));
});

test('C11 检查阶段目标换symlink或inode必须延后，真实目标未删', async (t) => {
  for (const replacement of ['symlink', 'inode']) {
    let target;
    const f = fixture(t, { before({ method, target: current, count, root }) {
      if (method === 'lstat' && current === target && count === 3) {
        fs.renameSync(target, path.join(root, 'original-held'));
        if (replacement === 'symlink') fs.symlinkSync(path.join(root, 'outside', 'keep.txt'), target);
        else fs.writeFileSync(target, 'replacement identity');
      }
    } });
    target = f.write('final/temp.txt', 'original');
    const external = f.write('outside/keep.txt', 'outside');
    const result = await f.cleanup({ workspaceDir: f.workspace, temporaryPaths: [target], protectedPaths: [] });
    assert.equal(result.deferredPaths[0].reason, replacement === 'symlink' ? 'symlink' : 'identity_changed');
    assert.equal(f.removals.length, 0);
    assert.equal(fs.readFileSync(external, 'utf8'), 'outside');
    assert.equal(fs.readFileSync(path.join(f.root, 'original-held'), 'utf8'), 'original');
  }
});

test('C12 检查阶段父链换symlink及workspace换inode都捕获，不宣称检查后竞态隔离', async (t) => {
  let parent;
  const f = fixture(t, { before({ method, target, count, root }) {
    if (method === 'lstat' && target === parent && count === 2) {
      fs.renameSync(parent, path.join(root, 'parent-held'));
      fs.symlinkSync(path.join(root, 'outside'), parent);
    }
  } });
  const temporary = f.write('final/tmp/temp.txt', 'original');
  parent = path.dirname(temporary);
  const outside = f.write('outside/temp.txt', 'outside');
  const result = await f.cleanup({ workspaceDir: f.workspace, temporaryPaths: [temporary], protectedPaths: [] });
  assert.equal(result.deferredPaths[0].reason, 'symlink');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  assert.equal(f.removals.length, 0);

  let workspace;
  const g = fixture(t, { before({ method, target, count, root }) {
    if (method === 'lstat' && target === workspace && count === 5) {
      fs.renameSync(workspace, path.join(root, 'workspace-held'));
      fs.mkdirSync(workspace);
      fs.writeFileSync(path.join(workspace, 'temp.txt'), 'new workspace');
    }
  } });
  workspace = g.workspace;
  const temp = g.write('final/temp.txt', 'original');
  const changed = await g.cleanup({ workspaceDir: workspace, temporaryPaths: [temp], protectedPaths: [] });
  assert.equal(changed.deferredPaths[0].reason, 'identity_changed');
  assert.equal(g.removals.length, 0);
  assert.equal(fs.readFileSync(path.join(g.root, 'workspace-held', 'temp.txt'), 'utf8'), 'original');
});

test('C13 子树检查时内容变化或保护ref目标变化延后', async (t) => {
  let directory;
  const f = fixture(t, { before({ method, target, count }) {
    if (method === 'readdir' && target === directory && count === 2) fs.writeFileSync(path.join(directory, 'added.txt'), 'new file');
  } });
  directory = path.dirname(f.write('final/tmp/original.txt'));
  const result = await f.cleanup({ workspaceDir: f.workspace, temporaryPaths: [directory], protectedPaths: [] });
  assert.equal(result.deferredPaths[0].reason, 'identity_changed');
  assert.equal(f.removals.length, 0);
  assert.ok(fs.existsSync(path.join(directory, 'added.txt')));

  let alias, target;
  const g = fixture(t, { before({ method, target: current, count }) {
    if (method === 'realpath' && current === alias && count === 2) {
      fs.unlinkSync(alias);
      fs.symlinkSync(target, alias);
    }
  } });
  target = g.write('final/temp.txt');
  const initiallyProtected = g.write('outside/original.txt');
  alias = path.join(g.root, 'alias');
  fs.symlinkSync(initiallyProtected, alias);
  const movedProtection = await g.cleanup({ workspaceDir: g.workspace, temporaryPaths: [target], protectedPaths: [alias] });
  assert.equal(movedProtection.deferredPaths[0].reason, 'identity_changed');
  assert.equal(g.removals.length, 0);
  assert.ok(fs.existsSync(target));
});

test('C14 rm失败如实报告failed；重叠目标顺序处理并去重', async (t) => {
  let denied;
  const f = fixture(t, { before({ method, target }) {
    if (method === 'rm' && target === denied) throw Object.assign(new Error('synthetic rm failure'), { code: 'EPERM' });
  } });
  denied = f.write('final/denied.txt');
  const child = f.write('final/temporary/child.txt');
  const result = await f.cleanup({ workspaceDir: f.workspace,
    temporaryPaths: [denied, child, child, path.dirname(child)], protectedPaths: [] });
  assert.deepEqual(plain(result.failedPaths), [{ path: denied, reason: 'delete_failed' }]);
  assert.deepEqual(plain(result.removedPaths), [child, path.dirname(child)]);
  assert.equal(result.deferredPaths.length, 0);
  assert.ok(fs.existsSync(denied));
});
