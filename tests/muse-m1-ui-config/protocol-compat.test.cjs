'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixture.cjs');

const clone = value => JSON.parse(JSON.stringify(value));
function legacyProfile(settings, id = 'legacy-profile') {
  const profile = { ...settings.modelProfiles[0], id, name: 'legacy' };
  delete profile.mainModelProtocol;
  delete profile.executorModelProtocol;
  return profile;
}

test('a fresh database defaults both protocols to cc and preserves them after reopening', async t => {
  const f = await fixture(t), manager = f.api.configManager;
  assert.equal(manager.getSettings().mainModelProtocol, 'cc');
  assert.equal(manager.getSettings().executorModelProtocol, 'cc');
  const before = f.snapshot(), revision = manager.getRevision();
  manager.reload();
  assert.equal(manager.getSettings().mainModelProtocol, 'cc');
  assert.equal(manager.getSettings().executorModelProtocol, 'cc');
  assert.deepEqual(f.snapshot(), before);
  assert.equal(manager.getRevision(), revision);
});

test('an existing database with absent protocol keys retains probing without rewriting configuration', async t => {
  const f = await fixture(t), manager = f.api.configManager;
  const legacy = legacyProfile(manager.getSettings());
  manager.commitSettings({ modelProfiles: [legacy], activeProfileId: legacy.id, mainModelName: 'keep-model', mainModelApiKey: 'keep-private-key' });
  f.db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run('mainModelProtocol', 'executorModelProtocol');
  const before = f.snapshot(), revision = manager.getRevision();
  manager.reload();
  assert.equal(manager.getSettings().mainModelProtocol, undefined);
  assert.equal(manager.getSettings().executorModelProtocol, undefined);
  assert.equal(manager.getSettings().mainModelName, 'keep-model');
  assert.equal(manager.getSettings().mainModelApiKey, 'keep-private-key');
  assert.deepEqual(manager.getSettings().modelProfiles, [legacy]);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(manager.getRevision(), revision);
  manager.reload();
  assert.deepEqual(f.snapshot(), before);
  assert.equal(manager.getSettings().mainModelProtocol, undefined);
  assert.equal(manager.getSettings().executorModelProtocol, undefined);
});

test('an existing explicit protocol stays unchanged while only its missing counterpart probes', async t => {
  const f = await fixture(t), manager = f.api.configManager;
  manager.commitSettings({ mainModelProtocol: 'responses' });
  f.db.prepare('DELETE FROM settings WHERE key=?').run('executorModelProtocol');
  const before = f.snapshot();
  manager.reload();
  assert.equal(manager.getSettings().mainModelProtocol, 'responses');
  assert.equal(manager.getSettings().executorModelProtocol, undefined);
  assert.deepEqual(f.snapshot(), before);
});

test('legacy active profile records both protocol edits atomically, preserving unrelated fields', async t => {
  const f = await fixture(t), manager = f.api.configManager, service = f.api.configProfileService;
  const legacy = legacyProfile(manager.getSettings());
  manager.commitSettings({ modelProfiles: [legacy], activeProfileId: legacy.id, mainModelApiKey: 'keep-private-key' });
  const beforeRevision = manager.getRevision();
  service.saveSettings({ mainModelProtocol: 'responses', executorModelProtocol: 'cc' }, beforeRevision);
  assert.equal(manager.getRevision(), beforeRevision + 1);
  const saved = manager.getSettings().modelProfiles[0];
  assert.equal(saved.mainModelProtocol, 'responses');
  assert.equal(saved.executorModelProtocol, 'cc');
  assert.equal(manager.getSettings().mainModelApiKey, 'keep-private-key');
  assert.equal(saved.mainModelName, legacy.mainModelName);
  manager.reload();
  assert.equal(manager.getSettings().mainModelProtocol, 'responses');
  assert.equal(manager.getSettings().modelProfiles[0].mainModelProtocol, 'responses');
});

test('switching a legacy profile resets absent protocols to cc rather than inheriting responses', async t => {
  const f = await fixture(t), manager = f.api.configManager, service = f.api.configProfileService;
  const legacy = legacyProfile(manager.getSettings());
  legacy.vendorMetadata = { keep: 'untouched' };
  manager.commitSettings({ modelProfiles: [...manager.getSettings().modelProfiles, legacy], mainModelProtocol: 'responses', executorModelProtocol: 'responses' });
  const beforeRevision = manager.getRevision();
  service.switchProfile(legacy.id, beforeRevision);
  assert.equal(manager.getRevision(), beforeRevision + 1);
  assert.equal(manager.getSettings().mainModelProtocol, 'cc');
  assert.equal(manager.getSettings().executorModelProtocol, 'cc');
  assert.deepEqual(manager.getSettings().modelProfiles.find(profile => profile.id === legacy.id), legacy);
  manager.reload();
  assert.equal(manager.getSettings().mainModelProtocol, 'cc');
  assert.equal(manager.getSettings().executorModelProtocol, 'cc');
});

test('deleting the active profile applies legacy protocol fallback in one rollback-safe transaction', async t => {
  const f = await fixture(t), manager = f.api.configManager, service = f.api.configProfileService;
  const legacy = legacyProfile(manager.getSettings()), currentId = manager.getSettings().activeProfileId;
  manager.commitSettings({ modelProfiles: [...manager.getSettings().modelProfiles, legacy], mainModelProtocol: 'responses', executorModelProtocol: 'responses' });
  const before = f.snapshot(), memory = clone(manager.getSettings());
  f.db.exec("CREATE TRIGGER refuse_protocol BEFORE INSERT ON settings WHEN NEW.key='executorModelProtocol' BEGIN SELECT RAISE(ABORT,'fixture protocol write fault'); END");
  assert.throws(() => service.deleteProfile(currentId), /fixture protocol write fault/);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(manager.getSettings(), memory);
  f.db.exec('DROP TRIGGER refuse_protocol');
  service.deleteProfile(currentId);
  assert.equal(manager.getSettings().activeProfileId, legacy.id);
  assert.equal(manager.getSettings().mainModelProtocol, 'cc');
  assert.equal(manager.getSettings().executorModelProtocol, 'cc');
});

test('profile snapshots and blank profiles retain independently selected protocols', async t => {
  const f = await fixture(t), manager = f.api.configManager, service = f.api.configProfileService;
  service.saveSettings({ mainModelProtocol: 'responses', executorModelProtocol: 'cc' });
  service.saveProfile('snapshot');
  const snapshot = manager.getSettings().modelProfiles.find(profile => profile.name === 'snapshot');
  assert.equal(snapshot.mainModelProtocol, 'responses');
  assert.equal(snapshot.executorModelProtocol, 'cc');
  service.saveProfile('blank', true);
  const blank = manager.getSettings().modelProfiles.find(profile => profile.name === 'blank');
  assert.equal(blank.mainModelProtocol, 'cc');
  assert.equal(blank.executorModelProtocol, 'cc');
});

test('protocol import and export roundtrip keeps preview, secrets and active-profile protections', async t => {
  const f = await fixture(t), manager = f.api.configManager, service = f.api.configProfileService;
  service.saveSettings({ mainModelProtocol: 'responses', executorModelProtocol: 'cc', mainModelApiKey: 'fixture-secret' });
  const activeId = manager.getSettings().activeProfileId;
  const exported = service.exportProfile(activeId);
  assert.equal(exported.json.includes('fixture-secret'), false);
  assert.equal(JSON.parse(exported.json).profile.mainModelProtocol, 'responses');
  const before = f.snapshot(), preview = service.previewImport(exported.json, 31);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(preview.fields.find(field => field.key === 'mainModelProtocol').value, 'responses');
  assert.equal(preview.fields.find(field => field.key === 'executorModelProtocol').value, 'cc');
  service.commitImport(preview.token, 31, preview.revision);
  assert.equal(manager.getSettings().activeProfileId, activeId);
  const imported = manager.getSettings().modelProfiles.find(profile => profile.name === preview.name);
  assert.equal(imported.mainModelProtocol, 'responses');
  assert.equal(imported.executorModelProtocol, 'cc');
  assert.equal(imported.mainModelApiKey, '');
});

test('invalid protocol saves are rejected while legacy and invalid imports use cc defaults', async t => {
  const f = await fixture(t), manager = f.api.configManager, service = f.api.configProfileService;
  const before = f.snapshot(), memory = clone(manager.getSettings());
  for (const key of ['mainModelProtocol', 'executorModelProtocol']) {
    for (const value of ['', 'auto', 'chat-completions', null, {}]) {
      assert.throws(() => service.saveSettings({ [key]: value }));
    }
  }
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(manager.getSettings(), memory);
  for (const source of [{ mainModelName: 'old-profile' }, { mainModelName: 'invalid-protocol', mainModelProtocol: 'auto', executorModelProtocol: '' }]) {
    const preview = service.previewImport(JSON.stringify(source), 31);
    assert.equal(preview.fields.find(field => field.key === 'mainModelProtocol').value, 'cc');
    assert.equal(preview.fields.find(field => field.key === 'executorModelProtocol').value, 'cc');
    if (source.mainModelProtocol) assert.equal(preview.warnings.filter(warning => warning.includes('ModelProtocol')).length, 2);
  }
});
