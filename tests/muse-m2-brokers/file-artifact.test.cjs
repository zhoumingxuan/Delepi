'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadSource, databaseFixture, sha } = require('./fixture.cjs');

async function fixture(t, hooks) {
  const entries = [
    'src/main/db/migrations/runtime-schema.ts', 'src/main/db/migrations/autonomy-schema.ts',
    'src/main/db/migrations/broker-storage-schema.ts', 'src/main/modules/artifacts/artifact-schema.ts',
    'src/main/modules/tasks/task-service.ts', 'src/main/modules/goals/goal-service.ts',
    'src/main/modules/permissions/authority.ts', 'src/main/modules/budget/ledger.ts',
    'src/main/modules/budget/contracts.ts', 'src/main/modules/brokers/file-broker.ts',
    'src/main/modules/brokers/artifact-broker.ts',
    'src/main/modules/brokers/session.ts', 'src/main/modules/brokers/concurrency.ts', 'src/main/modules/budget/run-clock.ts',
  ];
  const api = await Promise.all(entries.map(entry => loadSource(entry, { fsHooks: hooks })));
  const { root, db } = databaseFixture(t, api[0].RUNTIME_SCHEMA_SQL + api[1].AUTONOMY_SCHEMA_SQL
    + api[2].BROKER_STORAGE_SCHEMA_SQL + api[3].ARTIFACT_SCHEMA_SQL);
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL)');
  let id = 0; const uuid = () => `synthetic-${++id}`;
  const tasks = api[4].createTaskService(db, { ownerId: 'file-fixture-owner', uuid });
  const goals = api[5].createGoalService(db, { taskService: tasks, uuid, config: { getSettings: () => ({
    mainModelBaseUrl: 'https://model.example.com/v1', mainModelName: 'synthetic', mainModelApiKey: 'synthetic-unused-key',
  }) } });
  const goal = goals.create({ title: 'Synthetic public topic', topic: 'Public documents only', sourceUrls: ['https://example.com/doc'],
    destinationId: goals.listDestinations()[0].id, expectedOutput: 'Summary', stopConditions: 'One source', limits: api[5].DEFAULT_EXPLORATION_LIMITS });
  const context = tasks.beginRun('synthetic-conversation'); goals.bindRun(context, goal.id, goal.revision);
  const ledger = api[7].createBudgetLedger(db, { caps: api[8].DEFAULT_PUBLIC_BUDGET_CAPS, uuid });
  const authority = api[6].createPermissionAuthority(db, { taskService: tasks, budget: ledger, resolveDestination: goals.resolveDestination, uuid });
  t.after(() => authority.dispose());
  const controller = new AbortController();
  const clock = api[13].createRunClock({ activeMilliseconds: goal.limits.activeMilliseconds,
    deadlineAt: db.prepare('SELECT deadline_at FROM m2_run_scopes WHERE run_id=?').get(context.runId).deadline_at });
  const concurrency = api[12].createBrokerConcurrency(goal.limits.concurrency);
  const session = api[11].createBrokerSession({ context, signal: controller.signal, branchId: 'synthetic-branch', clock, concurrency, callerId: 1,
    authority: { ...authority, previewAction(context, action, caller) {
      const preview = authority.previewAction(context, action, caller);
      const receipt = authority.decideApproval(preview.id, preview.revision, 'once', 1);
      session.lastGrantId = receipt.grantId; session.lastAction = action;
      return preview;
    } },
  });
  t.after(() => { session.close(); clock.dispose(); });
  const publicRoot = path.join(root, 'public-snapshots'), artifactRoot = path.join(root, 'public-artifacts');
  const files = api[9].createFileBroker(db, { publicRoot, uuid });
  const artifacts = api[10].createArtifactBroker(db, { artifactRoot, uuid });
  const resources = goals.get(goal.id).resources;
  const source = resources.find(r => r.kind === 'public_url'), anchor = resources.find(r => r.kind === 'artifact');
  async function snapshot(body = 'Synthetic public document') {
    const bytes = Buffer.from(body);
    const op = await session.prepare({ capability: 'fetch.public', resourceRef: source.id, resourceVersion: `1:${source.contentHash}`,
      summary: 'Synthetic fetch fixture', units: { modelRequests: 0, fetchRequests: 1, downloadBytes: bytes.length, storageBytes: bytes.length, tokenUnits: 0 } });
    session.markStarted(op.leaseId);
    const resource = await files.registerSnapshot(session, source.id, bytes, 'text/plain; charset=utf-8', source.url, op.leaseId);
    session.settle(op.leaseId, 'completed', { known: { fetchRequests: 1, downloadBytes: bytes.length, storageBytes: bytes.length } });
    return resource;
  }
  const snapshotPath = ref => db.prepare('SELECT file_path FROM m2_resources WHERE id=?').get(ref).file_path;
  return { root, db, goals, goal, context, source, anchor, ledger, authority, session, controller, publicRoot, artifactRoot, files, artifacts, snapshot, snapshotPath, fileApi: api[9] };
}
const code = expected => error => error.code === expected;

test('FileBroker registers real immutable snapshot identity, reads scoped UTF-8, and refuses forged documents', async t => {
  const f = await fixture(t), resource = await f.snapshot('公开资料 UTF-8');
  const file = f.snapshotPath(resource.id), stat = fs.lstatSync(file), parent = fs.lstatSync(f.publicRoot);
  const identity = f.db.prepare('SELECT * FROM m2_public_file_identity WHERE resource_id=?').get(resource.id);
  assert.equal(identity.file_ino, stat.ino); assert.equal(identity.file_dev, stat.dev); assert.equal(identity.parent_ino, parent.ino);
  assert.equal(stat.mode & 0o777, 0o600); assert.equal(parent.mode & 0o777, 0o700);
  assert.equal(resource.contentHash, sha(Buffer.from('公开资料 UTF-8'))); assert.equal('file_path' in resource, false);
  const document = await f.files.read(f.session, resource.id);
  assert.equal(document.text, '公开资料 UTF-8'); f.files.verifyDocument(f.session, document);
  assert.throws(() => f.files.verifyDocument(f.session, { ...document, text: 'private replacement' }), code('PUBLIC_DOCUMENT_NOT_MINTED'));
  assert.equal(Object.isFrozen(document), true); assert.equal(Object.isFrozen(document.resource), true);
  const run = f.ledger.listAccounts(f.context).find(a => a.scope === 'run');
  assert.equal(run.used.downloadBytes, Buffer.byteLength(document.text)); assert.equal(run.used.storageBytes, Buffer.byteLength(document.text));
  assert.deepEqual(f.db.prepare('SELECT state,result_kind FROM m2_operations ORDER BY created_at,id').all(), [
    { state: 'settled', result_kind: 'completed' }, { state: 'settled', result_kind: 'completed' },
  ]);
});

test('FileBroker rejects raw paths, foreign refs, and missing durable identity before admission or file I/O', async t => {
  const f = await fixture(t), resource = await f.snapshot(); const prior = f.db.prepare('SELECT COUNT(*) n FROM m2_operations').get().n;
  await assert.rejects(f.files.read(f.session, path.join(f.root, 'private.txt')), /INVALID_REQUEST/);
  await assert.rejects(f.files.read(f.session, 'foreign-snapshot'), code('PUBLIC_RESOURCE_MISMATCH'));
  f.db.prepare('DELETE FROM m2_public_file_identity WHERE resource_id=?').run(resource.id);
  await assert.rejects(f.files.read(f.session, resource.id), code('PUBLIC_FILE_IDENTITY_MISSING'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_operations').get().n, prior);
});

test('FileBroker refuses replacement inode even when bytes and hash are identical', async t => {
  const f = await fixture(t), resource = await f.snapshot(), filename = f.snapshotPath(resource.id);
  const bytes = fs.readFileSync(filename); fs.renameSync(filename, filename + '.previous'); fs.writeFileSync(filename, bytes, { mode: 0o600 });
  await assert.rejects(f.files.read(f.session, resource.id), code('PUBLIC_FILE_IDENTITY_CHANGED'));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_operations WHERE state='settled' AND result_kind='failed'").get().n, 1);
  assert.equal(fs.existsSync(filename + '.previous'), true);
});

test('FileBroker refuses parent-directory replacement and symlink targets', async t => {
  const f = await fixture(t), resource = await f.snapshot(), filename = f.snapshotPath(resource.id), bytes = fs.readFileSync(filename);
  fs.renameSync(f.publicRoot, f.publicRoot + '.previous'); fs.mkdirSync(f.publicRoot, { mode: 0o700 }); fs.writeFileSync(filename, bytes);
  await assert.rejects(f.files.read(f.session, resource.id), code('PUBLIC_FILE_IDENTITY_CHANGED'));
  fs.unlinkSync(filename); fs.symlinkSync(path.join(f.publicRoot + '.previous', path.basename(filename)), filename);
  await assert.rejects(f.files.read(f.session, resource.id), code('PUBLIC_FILE_READ_FAILED'));
});

test('FileBroker refuses in-place hash changes without charging local reads as network downloads', async t => {
  const f = await fixture(t), resource = await f.snapshot('original'), filename = f.snapshotPath(resource.id);
  fs.writeFileSync(filename, 'modified');
  await assert.rejects(f.files.read(f.session, resource.id), code('PUBLIC_FILE_IDENTITY_CHANGED'));
  assert.equal(f.ledger.listAccounts(f.context).find(a => a.scope === 'run').used.downloadBytes, 8);
});

test('FileBroker rechecks the lease before descriptor reads; revocation consumes no unread bytes', async t => {
  const f = await fixture(t), resource = await f.snapshot('x'.repeat(130000)); let checks = 0;
  const original = f.session.assertLease;
  f.session.assertLease = id => {
    if (++checks === 3) f.authority.revokeGrant(f.session.lastGrantId, 2);
    return original(id);
  };
  await assert.rejects(f.files.read(f.session, resource.id), code('CANCELLED'));
  assert.equal(f.ledger.listAccounts(f.context).find(a => a.scope === 'run').used.downloadBytes, 130000);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_grants WHERE state='revoked'").get().n, 1);
});

test('SnapshotStore requires the started matching fetch lease and its storage reservation', async t => {
  const f = await fixture(t), bytes = Buffer.from('synthetic');
  const op = await f.session.prepare({ capability: 'fetch.public', resourceRef: f.source.id, resourceVersion: `1:${f.source.contentHash}`,
    summary: 'no storage reservation', units: { modelRequests: 0, fetchRequests: 1, downloadBytes: bytes.length, storageBytes: 0, tokenUnits: 0 } });
  f.session.markStarted(op.leaseId);
  await assert.rejects(f.files.registerSnapshot(f.session, f.source.id, bytes, 'text/plain', f.source.url, op.leaseId), code('PUBLIC_SNAPSHOT_LEASE_MISMATCH'));
  assert.equal(fs.existsSync(f.publicRoot), false);
});

test('SnapshotStore database fault rolls back both registration rows and preserves written bytes', async t => {
  const f = await fixture(t), bytes = Buffer.from('synthetic');
  const op = await f.session.prepare({ capability: 'fetch.public', resourceRef: f.source.id, resourceVersion: `1:${f.source.contentHash}`,
    summary: 'faulting snapshot fixture', units: { modelRequests: 0, fetchRequests: 1, downloadBytes: bytes.length, storageBytes: bytes.length, tokenUnits: 0 } });
  f.session.markStarted(op.leaseId);
  f.db.exec("CREATE TRIGGER refuse_identity BEFORE INSERT ON m2_public_file_identity BEGIN SELECT RAISE(ABORT,'synthetic identity failure'); END");
  await assert.rejects(f.files.registerSnapshot(f.session, f.source.id, bytes, 'text/plain', f.source.url, op.leaseId), error => {
    assert.equal(error.code, 'PUBLIC_SNAPSHOT_RECEIPT_UNKNOWN'); assert.equal(error.storageBytesWritten, bytes.length); assert.equal(error.wroteFile, true); return true;
  });
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_resources WHERE kind='public_snapshot'").get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_public_file_identity').get().n, 0);
  assert.equal(fs.readdirSync(f.publicRoot).length, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_operations WHERE state='started'").get().n, 1);
  assert.equal(f.ledger.listAccounts(f.context).find(a => a.scope === 'run').reserved.storageBytes, bytes.length);
  const journal = f.db.prepare('SELECT * FROM m2_public_write_journal').get();
  assert.equal(journal.state, 'review_required'); assert.equal(journal.expected_hash, sha(bytes));
  assert.equal(fs.readFileSync(journal.target_path).equals(bytes), true); assert.ok(journal.file_ino);
});

test('ArtifactBroker publishes new UTF-8 bytes with atomic public provenance and preserves three facts', async t => {
  const f = await fixture(t), resource = await f.snapshot();
  const record = await f.artifacts.publish(f.session, { anchorRef: f.anchor.id, text: '# Synthetic summary', sourceRefs: [resource.id] });
  assert.equal(record.saveState, 'saved'); assert.equal(record.validationState, 'pending'); assert.equal(record.acceptanceState, 'unreviewed');
  assert.equal('path' in record, false); assert.equal('sourcePath' in record, false);
  const scope = f.db.prepare('SELECT * FROM m2_artifact_scopes WHERE artifact_id=?').get(record.id);
  assert.equal(scope.goal_id, f.goal.id); assert.equal(scope.data_scope_id, f.goal.dataScopeId); assert.equal(scope.goal_revision, f.goal.revision);
  assert.deepEqual(JSON.parse(scope.source_refs_json), [resource.id]);
  const row = f.db.prepare('SELECT * FROM artifacts WHERE id=?').get(record.id);
  assert.equal(path.dirname(row.path), f.artifactRoot); assert.equal(fs.readFileSync(row.path, 'utf8'), '# Synthetic summary');
  assert.equal(f.session.lastAction.payloadHash, sha(Buffer.from('# Synthetic summary')));
  assert.equal(f.ledger.listAccounts(f.context).find(a => a.scope === 'run').used.storageBytes, resource.sizeBytes + Buffer.byteLength('# Synthetic summary'));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM artifact_publish_journal WHERE phase='registered'").get().n, 1);
});

test('ArtifactBroker rejects foreign provenance and real file resource as output anchor before writing', async t => {
  const f = await fixture(t), resource = await f.snapshot();
  await assert.rejects(f.artifacts.publish(f.session, { anchorRef: f.anchor.id, text: 'summary', sourceRefs: ['private-id'] }), code('PUBLIC_PROVENANCE_INVALID'));
  await assert.rejects(f.artifacts.publish(f.session, { anchorRef: resource.id, text: 'summary', sourceRefs: [resource.id] }), code('PUBLIC_OUTPUT_SCOPE_INVALID'));
  assert.equal(fs.existsSync(f.artifactRoot), false);
});

test('ArtifactBroker provenance write failure preserves bytes, rolls back save journal and retains unknown operation', async t => {
  const f = await fixture(t), resource = await f.snapshot();
  f.db.exec("CREATE TRIGGER refuse_scope BEFORE INSERT ON m2_artifact_scopes BEGIN SELECT RAISE(ABORT,'synthetic scope failure'); END");
  await assert.rejects(f.artifacts.publish(f.session, { anchorRef: f.anchor.id, text: 'summary', sourceRefs: [resource.id] }), code('PUBLIC_ARTIFACT_RECEIPT_UNKNOWN'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM artifacts').get().n, 0); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM artifact_publish_journal').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_artifact_scopes').get().n, 0);
  assert.equal(fs.readdirSync(f.artifactRoot).length, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_operations WHERE state='outcome_unknown'").get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_public_write_journal WHERE state='review_required'").get().n, 1);
});

test('ArtifactBroker settlement failure does not return fake success or erase committed artifact provenance', async t => {
  const f = await fixture(t), resource = await f.snapshot();
  f.db.exec("CREATE TRIGGER refuse_usage BEFORE INSERT ON m2_budget_usage_entries BEGIN SELECT RAISE(ABORT,'synthetic usage failure'); END");
  await assert.rejects(f.artifacts.publish(f.session, { anchorRef: f.anchor.id, text: 'summary', sourceRefs: [resource.id] }), code('OPERATION_RECEIPT_UNKNOWN'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM artifacts').get().n, 1); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_artifact_scopes').get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_operations WHERE state='outcome_unknown'").get().n, 1);
  assert.equal(f.ledger.listAccounts(f.context).find(a => a.scope === 'run').reserved.storageBytes, 7);
});

test('FileBroker preserves a UTF-8 BOM so the model text hash matches the registered public bytes', async t => {
  const f = await fixture(t), resource = await f.snapshot('\uFEFFpublic text');
  const document = await f.files.read(f.session, resource.id);
  assert.equal(document.text.charCodeAt(0), 0xFEFF); assert.equal(sha(Buffer.from(document.text)), resource.contentHash);
});

test('SnapshotStore refuses binary UTF-8, unsupported MIME and changed final URL before disk writes', async t => {
  const f = await fixture(t), op = await f.session.prepare({ capability: 'fetch.public', resourceRef: f.source.id, resourceVersion: `1:${f.source.contentHash}`,
    summary: 'Synthetic reject fixture', units: { modelRequests: 0, fetchRequests: 1, downloadBytes: 10, storageBytes: 10, tokenUnits: 0 } });
  f.session.markStarted(op.leaseId);
  await assert.rejects(f.files.registerSnapshot(f.session, f.source.id, Buffer.from([0xff]), 'text/plain', f.source.url, op.leaseId), code('PUBLIC_DOCUMENT_ENCODING_INVALID'));
  await assert.rejects(f.files.registerSnapshot(f.session, f.source.id, Buffer.from('text'), 'application/octet-stream', f.source.url, op.leaseId), code('PUBLIC_SNAPSHOT_INPUT_INVALID'));
  await assert.rejects(f.files.registerSnapshot(f.session, f.source.id, Buffer.from('text'), 'text/plain', 'https://example.com/other', op.leaseId), code('PUBLIC_SNAPSHOT_INPUT_INVALID'));
  assert.equal(fs.existsSync(f.publicRoot), false); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_public_write_journal').get().n, 0);
});

test('Public write crash review checks persisted ownership without replaying, registering or deleting bytes', async t => {
  const f = await fixture(t), resource = await f.snapshot();
  f.db.exec("CREATE TRIGGER refuse_scope BEFORE INSERT ON m2_artifact_scopes BEGIN SELECT RAISE(ABORT,'synthetic crash boundary'); END");
  await assert.rejects(f.artifacts.publish(f.session, { anchorRef: f.anchor.id, text: 'review bytes', sourceRefs: [resource.id] }));
  const journal = f.db.prepare("SELECT * FROM m2_public_write_journal WHERE state='review_required'").get();
  const count = f.db.prepare('SELECT COUNT(*) n FROM m2_operations').get().n, inode = fs.lstatSync(journal.target_path).ino;
  f.authority.reconcileInterrupted();
  const result = await f.fileApi.reconcilePublicWrites(f.db, { publicRoots: [f.publicRoot, f.artifactRoot] });
  assert.deepEqual(result, { reviewRequired: 1, integrityConfirmed: 1, missing: 0, unconfirmed: 0 });
  assert.equal(fs.lstatSync(journal.target_path).ino, inode); assert.equal(fs.readFileSync(journal.target_path, 'utf8'), 'review bytes');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM artifacts').get().n, 0); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_operations').get().n, count);
  f.db.prepare('UPDATE m2_public_write_journal SET target_path=? WHERE operation_id=?').run(path.join(f.root, 'private-not-readable.txt'), journal.operation_id);
  assert.deepEqual(await f.fileApi.reconcilePublicWrites(f.db, { publicRoots: [f.publicRoot, f.artifactRoot] }), { reviewRequired: 1, integrityConfirmed: 0, missing: 0, unconfirmed: 1 });
});

test('Snapshot read settlement failure withholds the document and preserves operation unknown', async t => {
  const f = await fixture(t), resource = await f.snapshot();
  f.db.exec("CREATE TRIGGER refuse_receipt BEFORE UPDATE ON m2_operations WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'synthetic read receipt failure'); END");
  await assert.rejects(f.files.read(f.session, resource.id), code('OPERATION_RECEIPT_UNKNOWN'));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_operations WHERE state='outcome_unknown'").get().n, 1);
  assert.equal(fs.existsSync(f.snapshotPath(resource.id)), true);
});

test('Snapshot descriptor close failure retains actual stored byte evidence for the Fetch receipt', async t => {
  let faulted = false;
  const f = await fixture(t, { afterClose(target) { if (!faulted && String(target).endsWith('.txt')) { faulted = true; throw Error('synthetic close fault'); } } });
  const bytes = Buffer.from('stored despite close failure');
  const op = await f.session.prepare({ capability: 'fetch.public', resourceRef: f.source.id, resourceVersion: `1:${f.source.contentHash}`,
    summary: 'Synthetic close fixture', units: { modelRequests: 0, fetchRequests: 1, downloadBytes: bytes.length, storageBytes: bytes.length, tokenUnits: 0 } });
  f.session.markStarted(op.leaseId);
  await assert.rejects(f.files.registerSnapshot(f.session, f.source.id, bytes, 'text/plain', f.source.url, op.leaseId), error => {
    assert.equal(error.code, 'PUBLIC_FILE_CLOSE_FAILED'); assert.equal(error.storageBytesWritten, bytes.length); assert.equal(error.wroteFile, true); return true;
  });
  const journal = f.db.prepare('SELECT * FROM m2_public_write_journal').get();
  assert.equal(journal.state, 'review_required'); assert.equal(fs.readFileSync(journal.target_path).equals(bytes), true);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_resources WHERE kind='public_snapshot'").get().n, 0);
});

test('Artifact descriptor close failure preserves bytes and produces operation unknown', async t => {
  let faulted = false;
  const f = await fixture(t, { afterClose(target) { if (!faulted && String(target).endsWith('.md')) { faulted = true; throw Error('synthetic close fault'); } } });
  const resource = await f.snapshot();
  await assert.rejects(f.artifacts.publish(f.session, { anchorRef: f.anchor.id, text: 'stored', sourceRefs: [resource.id] }), code('PUBLIC_FILE_CLOSE_FAILED'));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_operations WHERE state='outcome_unknown'").get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_public_write_journal WHERE state='review_required'").get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM artifacts').get().n, 0);
  assert.equal(fs.readdirSync(f.artifactRoot).length, 1);
});

test('ArtifactBroker refuses an identical-byte inode replacement between write and registration', async t => {
  let replaced = false;
  const f = await fixture(t, { afterClose(target) {
    if (!replaced && String(target).endsWith('.md')) {
      replaced = true; const body = fs.readFileSync(target); fs.renameSync(target, target + '.owned'); fs.writeFileSync(target, body, { mode: 0o600 });
    }
  } });
  const resource = await f.snapshot();
  await assert.rejects(f.artifacts.publish(f.session, { anchorRef: f.anchor.id, text: 'same bytes', sourceRefs: [resource.id] }), code('PUBLIC_ARTIFACT_CHANGED'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM artifacts').get().n, 0); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_artifact_scopes').get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_operations WHERE state='outcome_unknown'").get().n, 1);
  assert.equal(fs.readdirSync(f.artifactRoot).length, 2);
});

test('SnapshotStore rejects an identical-byte inode replacement after close before it claims a registered snapshot', async t => {
  let replaced = false;
  const f = await fixture(t, { afterClose(target) {
    if (!replaced && String(target).endsWith('.txt')) {
      replaced = true; const body = fs.readFileSync(target); fs.renameSync(target, target + '.owned'); fs.writeFileSync(target, body, { mode: 0o600 });
    }
  } });
  await assert.rejects(f.snapshot('same public bytes'), code('PUBLIC_SNAPSHOT_RECEIPT_UNKNOWN'));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_resources WHERE kind='public_snapshot'").get().n, 0);
  assert.equal(f.db.prepare("SELECT state FROM m2_public_write_journal").get().state, 'review_required');
  assert.equal(fs.readdirSync(f.publicRoot).length, 2);
});

test('SnapshotStore rejects an in-place content change after close before public registration', async t => {
  let changed = false;
  const f = await fixture(t, { afterClose(target) {
    if (!changed && String(target).endsWith('.txt')) { changed = true; fs.writeFileSync(target, 'modified'); }
  } });
  await assert.rejects(f.snapshot('original'), code('PUBLIC_SNAPSHOT_RECEIPT_UNKNOWN'));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM m2_resources WHERE kind='public_snapshot'").get().n, 0);
  assert.equal(f.db.prepare("SELECT state FROM m2_public_write_journal").get().state, 'review_required');
});
