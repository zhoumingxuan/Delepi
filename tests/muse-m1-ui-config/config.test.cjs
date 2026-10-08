'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./fixture.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const importText = JSON.stringify({ name: '导入测试', mainModelName: 'fixture-model', mainModelBaseUrl: 'https://user:password@example.invalid/api?token=fixture-url-secret', mainModelApiKey: 'fixture-api-secret', mainThinkingLevel: '' });

test('middle-key SQLite failure rolls back all keys, revision, active profile, and memory', async t => {
  const f = await fixture(t), before = f.snapshot(), memory = clone(f.api.configManager.getSettings());
  f.db.exec("CREATE TRIGGER refuse_key BEFORE INSERT ON settings WHEN NEW.key='mainModelApiKey' BEGIN SELECT RAISE(ABORT,'fixture write fault'); END");
  assert.throws(() => f.api.configProfileService.saveSettings({ mainModelName: 'partial', mainModelApiKey: 'new-key' }), /fixture write fault/);
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.api.configManager.getSettings(), memory);
});

test('revision-write failure rolls back already written config and profile changes', async t => {
  const f = await fixture(t), before = f.snapshot(), memory = clone(f.api.configManager.getSettings());
  f.db.exec("CREATE TRIGGER refuse_revision BEFORE INSERT ON settings WHEN NEW.key='_muse_config_revision' BEGIN SELECT RAISE(ABORT,'fixture revision fault'); END");
  assert.throws(() => f.api.configProfileService.saveSettings({ mainModelName: 'partial', mainThinkingLevel: '' }), /fixture revision fault/);
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.api.configManager.getSettings(), memory);
});

test('profile switching is atomic and preserves empty provider-default thinking after reload', async t => {
  const f = await fixture(t), service = f.api.configProfileService, manager = f.api.configManager;
  const original = clone(manager.getSettings());
  const profile = { id: 'profile-target', name: 'target' };
  for (const key of f.api.PROFILE_CONFIG_KEYS) profile[key] = typeof original[key] === 'boolean' ? !original[key] : 'fixture-' + key;
  profile.mainThinkingLevel = ''; profile.executorThinkingLevel = '';
  manager.commitSettings({ modelProfiles: [...original.modelProfiles, profile] });
  const before = f.snapshot(), memory = clone(manager.getSettings());
  f.db.exec("CREATE TRIGGER refuse_switch BEFORE INSERT ON settings WHEN NEW.key='executorModelName' BEGIN SELECT RAISE(ABORT,'fixture switch fault'); END");
  assert.throws(() => service.switchProfile(profile.id), /fixture switch fault/);
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(manager.getSettings(), memory);
  f.db.exec('DROP TRIGGER refuse_switch');
  service.switchProfile(profile.id);
  for (const key of f.api.PROFILE_CONFIG_KEYS) assert.equal(manager.getSettings()[key], profile[key]);
  assert.equal(manager.getSettings().activeProfileId, profile.id);
  manager.reload(); assert.equal(manager.getSettings().mainThinkingLevel, ''); assert.equal(manager.getSettings().executorThinkingLevel, '');
});

test('model edit updates the active profile in the same commit and respects snapshot divergence', async t => {
  const f = await fixture(t), service = f.api.configProfileService, manager = f.api.configManager;
  const revision = manager.getRevision();
  service.saveSettings({ mainModelName: 'model-next', mainThinkingLevel: '' }, revision);
  assert.equal(manager.getRevision(), revision + 1);
  const active = manager.getSettings().modelProfiles.find(p => p.id === manager.getSettings().activeProfileId);
  assert.equal(active.mainModelName, 'model-next'); assert.equal(active.mainThinkingLevel, '');
  manager.commitSettings({ mainModelName: 'outside-profile' });
  service.saveSettings({ mainModelName: 'next-outside' });
  assert.equal(manager.getSettings().mainModelName, 'next-outside');
  assert.equal(manager.getSettings().modelProfiles.find(p => p.id === active.id).mainModelName, 'model-next');
});

test('invalid setting batches and stale revisions leave persisted and in-memory state intact', async t => {
  const f = await fixture(t), before = f.snapshot(), memory = clone(f.api.configManager.getSettings());
  for (const patch of [{ mainModelName: 'x', activeProfileId: 'injected' }, { mainThinkingLevel: 'unsupported' }, { mainModelMultimodal: 'true' }, { arbitraryKey: 'x' }, {}]) {
    assert.throws(() => f.api.configProfileService.saveSettings(patch));
  }
  assert.throws(() => f.api.configProfileService.saveSettings({ mainModelName: 'stale' }, 0), error => error.code === 'REVISION_CONFLICT');
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.api.configManager.getSettings(), memory);
});

test('deleting the active profile and applying the replacement config roll back together', async t => {
  const f = await fixture(t), service = f.api.configProfileService, manager = f.api.configManager;
  service.saveProfile('replacement', true);
  const activeId = manager.getSettings().activeProfileId, before = f.snapshot(), memory = clone(manager.getSettings());
  f.db.exec("CREATE TRIGGER refuse_delete BEFORE INSERT ON settings WHEN NEW.key='activeProfileId' BEGIN SELECT RAISE(ABORT,'fixture delete fault'); END");
  assert.throws(() => service.deleteProfile(activeId), /fixture delete fault/);
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(manager.getSettings(), memory);
  f.db.exec('DROP TRIGGER refuse_delete'); service.deleteProfile(activeId);
  assert.equal(manager.getSettings().modelProfiles.length, 1);
  assert.equal(manager.getSettings().activeProfileId, manager.getSettings().modelProfiles[0].id);
});

test('import preview is secret-free and captures the file rather than trusting confirmation data', async t => {
  const f = await fixture(t), service = f.api.configProfileService, manager = f.api.configManager;
  const before = f.snapshot(), active = manager.getSettings().activeProfileId;
  const preview = service.previewImport(importText, 11), serialized = JSON.stringify(preview);
  assert.equal(preview.containsSecrets, true);
  for (const hidden of ['fixture-api-secret', 'fixture-url-secret', 'password', 'user:']) assert.equal(serialized.includes(hidden), false);
  assert.equal(preview.fields.find(p => p.key === 'mainThinkingLevel').value, '不设置');
  assert.deepEqual(f.snapshot(), before);
  service.commitImport(preview.token, 11, preview.revision);
  assert.equal(manager.getSettings().activeProfileId, active);
  const imported = manager.getSettings().modelProfiles.find(p => p.name === preview.name);
  assert.equal(imported.mainModelApiKey, 'fixture-api-secret'); assert.equal(imported.mainThinkingLevel, '');
  assert.notEqual(imported.id, 'injected');
});

test('import commit binds owner, token and preview revision; stale config cannot overwrite', async t => {
  const f = await fixture(t), service = f.api.configProfileService;
  const preview = service.previewImport(importText, 11), before = f.snapshot();
  assert.throws(() => service.commitImport(preview.token, 12, preview.revision));
  assert.throws(() => service.commitImport(preview.token, 11, preview.revision + 1));
  assert.deepEqual(f.snapshot(), before);
  service.saveSettings({ mainModelName: 'new-current' }); const afterEdit = f.snapshot();
  assert.throws(() => service.commitImport(preview.token, 11, preview.revision), error => error.code === 'REVISION_CONFLICT');
  assert.deepEqual(f.snapshot(), afterEdit);
});

test('import cancel, idempotent commit, name collision, invalid schema and size are bounded', async t => {
  const f = await fixture(t), service = f.api.configProfileService;
  const canceled = service.previewImport(importText, 1); service.cancelImport(canceled.token, 2);
  service.cancelImport(canceled.token, 1); assert.throws(() => service.commitImport(canceled.token, 1, canceled.revision));
  const preview = service.previewImport(importText, 1), committed = service.commitImport(preview.token, 1, preview.revision), after = f.snapshot();
  assert.deepEqual(service.commitImport(preview.token, 1, preview.revision), committed);
  assert.throws(() => service.commitImport(preview.token, 1, preview.revision + 1)); assert.deepEqual(f.snapshot(), after);
  const duplicate = service.previewImport(importText, 1); assert.notEqual(duplicate.name, preview.name); assert.equal(duplicate.warnings.some(w => w.includes('不覆盖')), true);
  for (const raw of ['[]', '{', JSON.stringify({ format: 'delepi-model-profile', version: 2, profile: { mainModelName: 'x' } }), JSON.stringify({ unrelated: true })]) assert.throws(() => service.previewImport(raw, 1));
  assert.throws(() => service.previewImport(' '.repeat(1024 * 1024 + 1), 1), /1 MB/);
  const envelope = service.previewImport(JSON.stringify({ format: 'delepi-model-profile', version: 1, profile: { mainModelName: 'valid', mainThinkingLevel: 'invalid' } }), 1);
  assert.equal(envelope.warnings.some(w => w.includes('mainThinkingLevel')), true);
});

test('default exported JSON omits all secret properties; explicit export preserves values', async t => {
  const f = await fixture(t), service = f.api.configProfileService;
  service.saveSettings({ mainModelApiKey: 'main-fixture-secret', executorModelApiKey: 'executor-fixture-secret', visionLlmApiKey: 'vision-fixture-secret' });
  const id = f.api.configManager.getSettings().activeProfileId;
  const safe = service.exportProfile(id), parsed = JSON.parse(safe.json);
  for (const key of f.api.PROFILE_SECRET_KEYS) assert.equal(Object.hasOwn(parsed.profile, key), false);
  assert.equal(safe.json.includes('fixture-secret'), false); assert.equal(safe.containsSecrets, false);
  const explicit = service.exportProfile(id, true); assert.equal(explicit.containsSecrets, true);
  assert.equal(JSON.parse(explicit.json).profile.mainModelApiKey, 'main-fixture-secret');
});

test('default export strips URL authentication, query and fragment secrets in every provider', async t => {
  const f = await fixture(t), service = f.api.configProfileService;
  service.saveSettings({ mainModelBaseUrl: 'https://fixture-user:fixture-password@example.invalid/v1?api_key=fixture-query#fixture-fragment', executorModelBaseUrl: 'https://executor.invalid/v1?token=fixture-executor-secret', visionLlmBaseUrl: 'not-a-url-with-fixture-secret' });
  const id = f.api.configManager.getSettings().activeProfileId, safe = service.exportProfile(id), profile = JSON.parse(safe.json).profile;
  assert.equal(profile.mainModelBaseUrl, 'https://example.invalid/v1');
  assert.equal(profile.executorModelBaseUrl, 'https://executor.invalid/v1'); assert.equal(profile.visionLlmBaseUrl, '');
  for (const secret of ['fixture-user', 'fixture-password', 'fixture-query', 'fixture-fragment', 'fixture-executor-secret', 'not-a-url-with-fixture-secret']) assert.equal(safe.json.includes(secret), false);
  const explicit = JSON.parse(service.exportProfile(id, true).json).profile;
  assert.equal(explicit.mainModelBaseUrl.includes('fixture-password'), true); assert.equal(explicit.executorModelBaseUrl.includes('fixture-executor-secret'), true);
});

test('native import reads the selected bounded file and confirmation retains the preview snapshot', async t => {
  const f = await fixture(t), filename = path.join(f.root, 'selected.json');
  fs.writeFileSync(filename, importText);
  f.state.openResult = { canceled: false, filePaths: [filename] };
  const response = await f.api.previewProfileImport(f.mainWindow, 1);
  assert.equal(response.ok, true); fs.writeFileSync(filename, JSON.stringify({ mainModelName: 'changed-after-preview' }));
  const committed = f.api.commitProfileImport(response.preview.token, 1, response.preview.revision);
  assert.equal(committed.ok, true);
  assert.equal(f.api.configManager.getSettings().modelProfiles.find(p => p.name === committed.profileName).mainModelName, 'fixture-model');
  fs.writeFileSync(filename, ' '.repeat(1024 * 1024 + 1));
  assert.equal((await f.api.previewProfileImport(f.mainWindow, 1)).ok, false);
});

test('native export defaults to secret-free, uses private file mode, and cancels explicit keys by default', async t => {
  const f = await fixture(t), filename = path.join(f.root, 'export.json');
  fs.writeFileSync(filename, 'old', { mode: 0o644 });
  f.api.configProfileService.saveSettings({ mainModelApiKey: 'private-fixture-key' });
  const id = f.api.configManager.getSettings().activeProfileId;
  f.state.saveResult = { canceled: false, filePath: filename };
  assert.equal((await f.api.exportProfile(f.mainWindow, id, false)).ok, true);
  assert.equal(fs.readFileSync(filename, 'utf8').includes('private-fixture-key'), false);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  const before = fs.readFileSync(filename, 'utf8');
  assert.deepEqual(await f.api.exportProfile(f.mainWindow, id, true), { ok: false, canceled: true });
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  f.state.confirmation = 1; assert.equal((await f.api.exportProfile(f.mainWindow, id, true)).containsSecrets, true);
  assert.equal(fs.readFileSync(filename, 'utf8').includes('private-fixture-key'), true);
});
