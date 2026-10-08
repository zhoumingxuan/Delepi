'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, plain } = require('./fixture.cjs');

test('AR01 forced concurrent same-name publication saves both files without overwriting either', async (t) => {
  let arrivals = 0; let release;
  const bothSelected = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { async before({ method }) {
    if (method !== 'link') return;
    if (++arrivals === 2) release();
    if (arrivals <= 2) await bothSelected;
  } });
  const first = f.write('one/same.md', 'first result');
  const second = f.write('two/same.md', 'second result');
  const results = await Promise.allSettled([
    f.service.publishArtifactFile(first, path.join(f.root, 'output'), { artifactOrigin: f.origin }),
    f.service.publishArtifactFile(second, path.join(f.root, 'output'), { artifactOrigin: f.origin }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
  const targets = results.map((result) => result.value);
  assert.equal(new Set(targets).size, 2);
  assert.deepEqual(targets.map((target) => fs.readFileSync(target, 'utf8')).sort(), ['first result', 'second result']);
  const journals = f.db.prepare('SELECT * FROM artifact_publish_journal').all();
  assert.equal(journals.length, 2);
  assert.ok(journals.every((row) => row.phase === 'registered' && !fs.existsSync(row.staging_path)));
  assert.equal((await f.service.listArtifacts()).items.filter((item) => item.saveState === 'saved').length, 2);
  assert.equal(fs.readFileSync(first, 'utf8'), 'first result');
  assert.equal(fs.readFileSync(second, 'utf8'), 'second result');
});

test('AR02 committed acceptance retries return their original receipt without filesystem IO or mutations', async (t) => {
  let reads = 0;
  const f = fixture(t, { before({ method }) { if (method === 'open') reads++; } });
  const source = f.write('source/result.md', 'accepted content');
  const target = await f.service.publishArtifactFile(source, path.join(f.root, 'output'), { artifactOrigin: f.origin });
  const item = (await f.service.listArtifacts()).items[0];
  const request = { artifactId: item.id, accepted: true, expectedRevision: item.revision, requestId: 'review-accept-1' };
  const receipt = await f.service.acceptArtifact(request);
  fs.unlinkSync(target);
  const readsBefore = reads;
  assert.deepEqual(plain(await f.service.acceptArtifact(request)), plain(receipt));
  assert.equal(reads, readsBefore);
  assert.deepEqual(plain(await f.service.getArtifact(item.id)), plain(receipt));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM activity_events WHERE kind='artifact.accepted'").get().n, 1);
  await assert.rejects(f.service.acceptArtifact({ ...request, expectedRevision: request.expectedRevision + 1 }), /ARTIFACT_REQUEST_CONFLICT/);
  assert.equal(reads, readsBefore);
  // A new action still verifies the current file and records its disappearance.
  await assert.rejects(f.service.openArtifact(item.id), /ENOENT/);
  assert.equal((await f.service.getArtifact(item.id)).saveState, 'missing');
});

test('AR03 direct deliverables are inspected once while retaining the saved identity journal', async (t) => {
  let reads = 0;
  const f = fixture(t, { before({ method }) { if (method === 'open') reads++; } });
  const source = f.write('source/direct.md', 'direct result');
  const target = await f.service.publishArtifactFile(source, undefined, { artifactOrigin: f.origin });
  assert.equal(target, source);
  assert.equal(reads, 1);
  const item = (await f.service.listArtifacts()).items[0];
  assert.equal(item.saveState, 'saved');
  assert.equal(f.db.prepare('SELECT file_ino FROM artifact_publish_journal').get().file_ino, fs.statSync(source).ino);
  assert.equal(f.writes.length, 0);
});

test('AR04 stale acceptance fails before filesystem work and cannot change the artifact save state', async (t) => {
  let metadataReads = 0;
  const f = fixture(t, { before({ method }) { if (['lstat', 'open'].includes(method)) metadataReads++; } });
  const source = f.write('source/stale.md', 'result');
  const target = await f.service.publishArtifactFile(source, path.join(f.root, 'output'), { artifactOrigin: f.origin });
  const item = (await f.service.listArtifacts()).items[0];
  fs.unlinkSync(target);
  const readsBefore = metadataReads;
  await assert.rejects(f.service.acceptArtifact({ artifactId: item.id, accepted: true,
    expectedRevision: item.revision - 1, requestId: 'stale-with-missing-file' }), /STALE_REVISION/);
  assert.equal(metadataReads, readsBefore);
  assert.deepEqual(plain(await f.service.getArtifact(item.id)), plain(item));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM artifact_accept_requests').get().n, 0);
});

test('AR05 retarget transaction failure preserves the collision file, staged bytes and original journal reference', async (t) => {
  let collided = false;
  const f = fixture(t, { before({ method, args }) {
    if (method === 'link' && !collided) { collided = true; fs.writeFileSync(args[0], 'existing unrelated result'); }
  } });
  const source = f.write('source/collision.md', 'new result');
  f.db.exec("CREATE TRIGGER deny_retarget BEFORE UPDATE OF target_path ON artifact_publish_journal BEGIN SELECT RAISE(ABORT,'fixture retarget failure'); END;");
  await assert.rejects(f.service.publishArtifactFile(source, path.join(f.root, 'output'), { artifactOrigin: f.origin }), /fixture retarget failure/);
  const journal = f.db.prepare('SELECT * FROM artifact_publish_journal').get();
  const record = f.db.prepare('SELECT * FROM artifacts').get();
  assert.equal(journal.target_path, path.join(f.root, 'output/collision.md'));
  assert.equal(record.path, journal.target_path);
  assert.equal(fs.readFileSync(journal.target_path, 'utf8'), 'existing unrelated result');
  assert.equal(fs.readFileSync(journal.staging_path, 'utf8'), 'new result');
  assert.ok(f.service.getProtectedTaskPaths().includes(journal.staging_path));
  f.db.exec('DROP TRIGGER deny_retarget');
  const copies = f.writes.filter((row) => row.method === 'copyFile').length;
  await f.service.reconcileArtifactPublications();
  assert.equal((await f.service.getArtifact(record.id)).saveState, 'quarantined');
  assert.equal(fs.readFileSync(journal.target_path, 'utf8'), 'existing unrelated result');
  assert.equal(fs.readFileSync(journal.staging_path, 'utf8'), 'new result');
  assert.equal(f.writes.filter((row) => row.method === 'copyFile').length, copies);
});
