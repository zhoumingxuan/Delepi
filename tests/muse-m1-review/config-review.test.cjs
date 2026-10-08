'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const actualIo = require('node:fs/promises');
const { fixture } = require('../muse-m1-ui-config/fixture.cjs');

for (const fault of ['partial-write', 'flush', 'rename']) {
  test(`configuration export preserves the selected old file after ${fault} failure`, async t => {
    const f = await fixture(t), filename = path.join(f.root, 'selected-old.json');
    const previous = '{"user-config":"must survive"}';
    fs.writeFileSync(filename, previous, { mode: 0o640 });
    f.state.saveResult = { canceled: false, filePath: filename };
    const id = f.api.configManager.getSettings().activeProfileId;
    f.state.fileIo = {
      ...actualIo,
      async open(name, flags, ...args) {
        const handle = await actualIo.open(name, flags, ...args);
        if (flags !== 'wx' && flags !== 'w') return handle;
        return {
          async writeFile(...writeArgs) {
            if (fault !== 'partial-write') return handle.writeFile(...writeArgs);
            await handle.writeFile('{"incomplete":', { encoding: 'utf8' });
            throw Object.assign(new Error('fixture disk full after partial write'), { code: 'ENOSPC' });
          },
          async sync() {
            if (fault === 'flush') await handle.close();
            return handle.sync(); // A real closed-descriptor failure, before publication.
          },
          close: () => handle.close(),
          chmod: (...chmodArgs) => handle.chmod(...chmodArgs),
        };
      },
      rename: (from, to) => actualIo.rename(from, fault === 'rename' ? path.join(f.root, 'missing-directory', path.basename(to)) : to),
    };
    assert.equal((await f.api.exportProfile(f.mainWindow, id, false)).ok, false);
    assert.equal(fs.readFileSync(filename, 'utf8'), previous);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith('.delepi-profile-')), []);
  });
}

test('configuration export refuses a symbolic link without modifying its target', async t => {
  const f = await fixture(t), target = path.join(f.root, 'keep.json'), selected = path.join(f.root, 'link.json');
  fs.writeFileSync(target, 'unrelated existing content', { mode: 0o644 }); fs.symlinkSync(target, selected);
  f.state.saveResult = { canceled: false, filePath: selected };
  const id = f.api.configManager.getSettings().activeProfileId;
  assert.deepEqual(await f.api.exportProfile(f.mainWindow, id, false), { ok: false, error: '所选目标不是普通文件，请选择新的 JSON 文件名' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'unrelated existing content');
  assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  assert.equal(fs.lstatSync(selected).isSymbolicLink(), true);
});

test('configuration export preserves a destination edited while the file dialog operation stages bytes', async t => {
  const f = await fixture(t), filename = path.join(f.root, 'concurrent.json');
  fs.writeFileSync(filename, 'previous'); f.state.saveResult = { canceled: false, filePath: filename };
  f.state.fileIo = { ...actualIo, async open(name, flags, ...args) {
    const handle = await actualIo.open(name, flags, ...args);
    if (flags !== 'wx') return handle;
    return { writeFile: (...writeArgs) => handle.writeFile(...writeArgs), close: () => handle.close(), async sync() {
      await handle.sync(); fs.writeFileSync(filename, 'concurrent newer user configuration');
    } };
  } };
  const id = f.api.configManager.getSettings().activeProfileId;
  assert.equal((await f.api.exportProfile(f.mainWindow, id, false)).ok, false);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'concurrent newer user configuration');
  assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith('.delepi-profile-')), []);
});

test('configuration profile export cannot leak unknown persisted extension fields', async t => {
  const f = await fixture(t), settings = f.api.configManager.getSettings();
  const profiles = settings.modelProfiles.map(profile => ({ ...profile, experimentalApiKey: 'unknown-fixture-secret', vendorMetadata: { token: 'nested-fixture-secret' } }));
  f.api.configManager.commitSettings({ modelProfiles: profiles });
  for (const includeSecrets of [false, true]) {
    const exported = f.api.configProfileService.exportProfile(settings.activeProfileId, includeSecrets);
    assert.equal(exported.json.includes('unknown-fixture-secret'), false);
    assert.equal(exported.json.includes('nested-fixture-secret'), false);
    assert.equal(Object.hasOwn(JSON.parse(exported.json).profile, 'experimentalApiKey'), false);
  }
  assert.equal(f.api.configManager.getSettings().modelProfiles[0].experimentalApiKey, 'unknown-fixture-secret');
  assert.equal(JSON.parse(f.db.prepare('SELECT value_json FROM settings WHERE key=?').get('modelProfiles').value_json)[0].experimentalApiKey, 'unknown-fixture-secret');
});

test('native window menu exposes the standard close role on macOS', async t => {
  const f = await fixture(t); f.api.registerNativeMenu(() => f.mainWindow);
  assert.ok(f.state.menus[0].find(item => item.label === '窗口').submenu.some(item => item.role === 'close'));
  assert.equal(f.state.calls.length, 0); assert.equal(f.mainWindow.sends.length, 0);
});

for (const [key, malformed] of [
  ['mainModelBaseUrl', { endpoint: 'https://example.invalid/v1', token: 'nested-invalid-fixture-secret' }],
  ['executorModelBaseUrl', ['nested-invalid-fixture-secret']],
  ['mainModelName', { token: 'nested-invalid-fixture-secret' }],
  ['visionLlmModel', ['nested-invalid-fixture-secret']],
  ['mainModelMultimodal', { token: 'nested-invalid-fixture-secret' }],
  ['mainModelMultimodal', ['nested-invalid-fixture-secret']],
  ['mainModelApiKey', { token: 'nested-invalid-fixture-secret' }],
  ['name', { token: 'nested-invalid-fixture-secret' }],
  ['name', ['nested-invalid-fixture-secret']],
]) {
  test(`profile export rejects malformed persisted ${key} (${Array.isArray(malformed) ? 'array' : 'object'}) without modifying legacy data`, async t => {
    const f = await fixture(t), settings = f.api.configManager.getSettings();
    const profiles = settings.modelProfiles.map(profile => ({ ...profile, [key]: malformed, vendorMetadata: { keep: 'preserved-metadata' } }));
    f.db.prepare('UPDATE settings SET value_json=? WHERE key=?').run(JSON.stringify(profiles), 'modelProfiles');
    f.api.configManager.reload();
    const before = f.snapshot(), memory = JSON.stringify(f.api.configManager.getSettings());
    for (const includeSecrets of [false, true]) {
      assert.throws(() => f.api.configProfileService.exportProfile(settings.activeProfileId, includeSecrets), error => {
        assert.equal(error.message.includes('nested-invalid-fixture-secret'), false);
        return /无效/.test(error.message);
      });
      f.state.confirmation = 1;
      const filename = path.join(f.root, 'must-not-change.json');
      fs.writeFileSync(filename, 'existing configuration'); f.state.saveResult = { canceled: false, filePath: filename };
      assert.equal((await f.api.exportProfile(f.mainWindow, settings.activeProfileId, includeSecrets)).ok, false);
      assert.equal(fs.readFileSync(filename, 'utf8'), 'existing configuration');
      assert.equal(f.state.dialogs.some(dialog => dialog.kind === 'save'), false);
    }
    assert.deepEqual(f.snapshot(), before);
    assert.equal(JSON.stringify(f.api.configManager.getSettings()), memory);
  });
}

test('profile export permits absent optional legacy fields and leaves stored metadata unchanged', async t => {
  const f = await fixture(t), settings = f.api.configManager.getSettings();
  const profiles = settings.modelProfiles.map(profile => {
    const copied = { ...profile, vendorMetadata: { keep: 'preserved-metadata' } };
    for (const key of ['mainThinkingLevel', 'executorThinkingLevel', 'mainModelMultimodal']) delete copied[key];
    return copied;
  });
  f.db.prepare('UPDATE settings SET value_json=? WHERE key=?').run(JSON.stringify(profiles), 'modelProfiles');
  f.api.configManager.reload(); const before = f.snapshot();
  for (const includeSecrets of [false, true]) {
    const exported = JSON.parse(f.api.configProfileService.exportProfile(settings.activeProfileId, includeSecrets).json);
    assert.equal(exported.profile.name, profiles[0].name);
    for (const key of ['mainThinkingLevel', 'executorThinkingLevel', 'mainModelMultimodal', 'vendorMetadata']) assert.equal(Object.hasOwn(exported.profile, key), false);
  }
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.api.configManager.getSettings().modelProfiles, profiles);
});
