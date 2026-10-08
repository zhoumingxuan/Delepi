'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fixture, plain } = require('./fixture.cjs');
const sha = (body) => crypto.createHash('sha256').update(body).digest('hex');

test('A01 actual copy/journal/native SQLite保存事实与可信Run关联，三态独立', async (t) => {
  const f = fixture(t); const source = f.write('source/report.md', 'verified bytes');
  const storage = f.load('src/main/utils/storage-output.ts');
  const target = await storage.copyFileToOutputDir(source, path.join(f.root, 'output'), { artifactOrigin: f.origin });
  assert.equal(fs.readFileSync(target, 'utf8'), 'verified bytes');
  assert.equal(fs.readFileSync(source, 'utf8'), 'verified bytes');
  const { items } = await f.service.listArtifacts();
  assert.equal(items.length, 1); const artifact = items[0];
  assert.equal(artifact.runId, 'R'); assert.equal(artifact.attemptId, 'A');
  assert.equal(artifact.contentHash, sha('verified bytes')); assert.equal(artifact.saveState, 'saved');
  assert.equal(artifact.validationState, 'pending'); assert.equal(artifact.acceptanceState, 'unreviewed');
  assert.equal(artifact.needsReview, false); assert.ok(!('path' in artifact)); assert.ok(!('sourcePath' in artifact));
  const journal = f.db.prepare('SELECT * FROM artifact_publish_journal').get();
  assert.equal(journal.phase, 'registered'); assert.equal(journal.file_ino, fs.statSync(target).ino);
  assert.equal(fs.existsSync(journal.staging_path), false);
  const events = f.db.prepare('SELECT kind,details_json FROM activity_events').all();
  assert.equal(events[0].kind, 'artifact.saved'); assert.ok(!events[0].details_json.includes(source));
  const protectedPaths = f.service.getProtectedTaskPaths();
  assert.ok(protectedPaths.includes(source)); assert.ok(protectedPaths.includes(target)); assert.ok(protectedPaths.includes(journal.staging_path));
});

test('A02 复制失败不saved、不返回原路径冒充已保存；解析器真实报告交付错误', async (t) => {
  let denyCopies = true;
  const f = fixture(t, { before({ method }) { if (method === 'copyFile' && denyCopies) throw Object.assign(new Error('fixture copy denied'), { code: 'EPERM' }); } });
  const source = f.write('final/plan.md', '# synthetic plan'); f.write('final/summary.md', 'summary');
  const parser = f.load('src/main/modules/executor-agent/executor-structured-payload.ts');
  const result = await parser.parseExecutorStructuredPayload({ raw: JSON.stringify({ success: true, warnings: [], errors: [],
    summary_filename: 'summary.md', deliverable_filename: 'plan.md' }), deliveryType: '方案', finalOutputDir: path.dirname(source),
    outputDir: path.join(f.root, 'output'), artifactOrigin: f.origin });
  assert.equal(result.payload, null); assert.match(result.error, /fixture copy denied/);
  assert.equal((await f.service.listArtifacts()).items[0].saveState, 'failed');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM activity_events WHERE kind='artifact.saved'").get().n, 0);
  assert.equal(fs.readFileSync(source, 'utf8'), '# synthetic plan');
  denyCopies = false;
});

test('A03 原子journal事务失败发生在写文件前，真实SQLite rollback无孤儿记录', async (t) => {
  const f = fixture(t); const source = f.write('source/report.md');
  f.db.exec("CREATE TRIGGER deny_intent BEFORE INSERT ON artifact_publish_journal BEGIN SELECT RAISE(ABORT,'fixture intent failure'); END;");
  await assert.rejects(f.service.publishArtifactFile(source, path.join(f.root, 'output'), { artifactOrigin: f.origin }), /fixture intent failure/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM artifacts').get().n, 0);
  assert.equal(f.writes.filter((x) => x.method === 'copyFile' || x.method === 'link').length, 0);
  assert.ok(fs.existsSync(source));
});

test('A04 文件已publish但SQLite保存失败：重启按inode/hash对账登记，不重复制或覆盖源', async (t) => {
  const f = fixture(t); const source = f.write('source/report.md', 'recovery bytes');
  f.db.exec("CREATE TRIGGER deny_saved BEFORE UPDATE ON artifacts WHEN NEW.save_state='saved' BEGIN SELECT RAISE(ABORT,'fixture save failure'); END;");
  await assert.rejects(f.service.publishArtifactFile(source, path.join(f.root, 'output'), { artifactOrigin: f.origin }), /fixture save failure/);
  const journal = f.db.prepare('SELECT * FROM artifact_publish_journal').get();
  assert.equal(fs.readFileSync(journal.target_path, 'utf8'), 'recovery bytes');
  assert.ok(fs.existsSync(journal.staging_path));
  assert.equal((await f.service.listArtifacts()).items[0].saveState, 'staging');
  f.db.exec('DROP TRIGGER deny_saved'); f.db.prepare("UPDATE task_attempts SET state='interrupted' WHERE id='A'").run();
  const copies = f.writes.filter((x) => x.method === 'copyFile').length;
  const restarted = f.restart(); const receipt = await restarted.reconcileArtifactPublications();
  assert.equal(receipt.saved, 1); assert.equal(receipt.needsReview, 1);
  const item = (await restarted.listArtifacts()).items[0];
  assert.equal(item.saveState, 'saved'); assert.equal(item.needsReview, true); assert.equal(item.validationState, 'pending');
  assert.equal(item.acceptanceState, 'unreviewed'); assert.equal(fs.existsSync(journal.staging_path), false);
  assert.equal(f.writes.filter((x) => x.method === 'copyFile').length, copies);
  assert.equal(fs.readFileSync(source, 'utf8'), 'recovery bytes');
});

test('A05 取消后已发布文件仍为saved待核实；取消不撤回字节、不接受成果', async (t) => {
  const abort = new AbortController();
  const f = fixture(t, { after({ method }) { if (method === 'link') abort.abort(new Error('fixture cancelled')); } });
  const source = f.write('source/report.md', 'written before cancellation');
  await assert.rejects(f.service.publishArtifactFile(source, path.join(f.root, 'output'), { artifactOrigin: f.origin, signal: abort.signal }), /fixture cancelled/);
  const item = (await f.service.listArtifacts()).items[0]; const journal = f.db.prepare('SELECT * FROM artifact_publish_journal').get();
  assert.equal(item.saveState, 'saved'); assert.equal(item.needsReview, true);
  assert.equal(item.acceptanceState, 'unreviewed'); assert.equal(fs.readFileSync(journal.target_path, 'utf8'), 'written before cancellation');
  assert.equal(journal.phase, 'registered');
});

test('A06 owner/generation/关联伪造和terminal晚到publish均拒绝，没有新副作用', async (t) => {
  const f = fixture(t); const source = f.write('source/report.md');
  for (const origin of [{ ...f.origin, ownerId: 'other' }, { ...f.origin, generation: 2 }, { ...f.origin, conversationId: 'other' }, { ...f.origin, attemptId: 'other' }]) {
    await assert.rejects(f.service.publishArtifactFile(source, path.join(f.root, 'output'), { artifactOrigin: origin }), /ARTIFACT_ORIGIN_INVALID/);
  }
  f.db.prepare("UPDATE task_attempts SET state='completed' WHERE id='A'").run();
  await assert.rejects(f.service.publishArtifactFile(source, path.join(f.root, 'output'), { artifactOrigin: f.origin }), /ARTIFACT_ORIGIN_NOT_RUNNING/);
  assert.equal(f.writes.length, 0); assert.equal((await f.service.listArtifacts()).items.length, 0);
});

test('A07 接受是独立用户CAS/幂等动作；错误修订拒绝、missing成果可拒绝', async (t) => {
  const f = fixture(t); const source = f.write('source/report.md');
  const target = await f.service.publishArtifactFile(source, path.join(f.root, 'output'), { artifactOrigin: f.origin });
  const item = (await f.service.listArtifacts()).items[0];
  await assert.rejects(f.service.acceptArtifact({ artifactId: item.id, accepted: true, expectedRevision: item.revision - 1, requestId: 'stale' }), /STALE_REVISION/);
  const request = { artifactId: item.id, accepted: true, expectedRevision: item.revision, requestId: 'accept-1' };
  const accepted = await f.service.acceptArtifact(request); const replay = await f.service.acceptArtifact(request);
  assert.deepEqual(plain(replay), plain(accepted)); assert.equal(accepted.validationState, 'pending');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM activity_events WHERE kind='artifact.accepted'").get().n, 1);
  await assert.rejects(f.service.acceptArtifact({ ...request, accepted: false }), /ARTIFACT_REQUEST_CONFLICT/);
  fs.unlinkSync(target); await assert.rejects(f.service.openArtifact(item.id), /ENOENT/);
  const missing = await f.service.getArtifact(item.id); assert.equal(missing.saveState, 'missing');
  const rejected = await f.service.acceptArtifact({ artifactId: item.id, expectedRevision: missing.revision, accepted: false, requestId: 'reject-missing' });
  assert.equal(rejected.saveState, 'missing'); assert.equal(rejected.acceptanceState, 'rejected'); assert.equal(rejected.validationState, 'pending');
});

test('A08 同hash不同inode替换、内容篡改或symlink均拒绝open并隔离', async (t) => {
  for (const mutation of ['inode', 'hash', 'symlink']) {
    const f = fixture(t); const source = f.write('source/report.md', 'original bytes');
    const target = await f.service.publishArtifactFile(source, path.join(f.root, 'output'), { artifactOrigin: f.origin });
    const item = (await f.service.listArtifacts()).items[0];
    if (mutation === 'inode') { fs.renameSync(target, target + '.old'); fs.writeFileSync(target, 'original bytes'); }
    if (mutation === 'hash') fs.writeFileSync(target, 'tampered bytes');
    if (mutation === 'symlink') { fs.unlinkSync(target); fs.symlinkSync(source, target); }
    await assert.rejects(f.service.openArtifact(item.id), /ARTIFACT_(IDENTITY_CHANGED|HASH_CHANGED|SYMLINK_DENIED)/);
    assert.equal((await f.service.getArtifact(item.id)).saveState, 'quarantined'); assert.equal(f.windows.length, 0);
    await f.service.reconcileArtifactPublications(); assert.equal((await f.service.getArtifact(item.id)).saveState, 'quarantined');
  }
});

test('A09 HTML真实API只用核验字节建独立无preload窗口，host回调拒请求/导航/弹窗/下载/权限', async (t) => {
  const f = fixture(t); const source = f.write('source/demo.html', '<script>fetch("https://external.invalid")</script><img src="file:///private/secret"><h1>fixture</h1>');
  await f.service.publishArtifactFile(source, path.join(f.root, 'output'), { artifactOrigin: f.origin });
  const item = (await f.service.listArtifacts()).items[0]; await f.service.openArtifact(item.id);
  const window = f.windows[0]; const preferences = window.options.webPreferences;
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true);
  assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.javascript, false); assert.ok(!preferences.preload);
  assert.ok(window.url.startsWith('data:text/html;')); assert.equal(window.shown, true);
  for (const url of ['https://external.invalid', 'file:///private/secret', 'data:text/html,unregistered']) {
    let decision; window.session.request({ url }, (value) => { decision = value; }); assert.equal(decision.cancel, true);
  }
  let ownDecision; window.session.request({ url: window.url }, (value) => { ownDecision = value; }); assert.equal(ownDecision.cancel, false);
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    let prevented = false; window.events[name]({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  }
  assert.equal(window.popup().action, 'deny'); assert.equal(window.session.permissionCheck(), false);
  let permission; window.session.permissionRequest(null, 'camera', (value) => { permission = value; }); assert.equal(permission, false);
  let downloadPrevented = false; window.session['will-download']({ preventDefault() { downloadPrevented = true; } }); assert.equal(downloadPrevented, true);
  assert.equal(f.opened.length, 0);
});

test('A10 用户open只允许登记ID和受限外部文档；可执行文件不会OS打开', async (t) => {
  const f = fixture(t); const document = f.write('source/sheet.xlsx');
  await f.service.publishArtifactFile(document, path.join(f.root, 'output'), { artifactOrigin: f.origin });
  let item = (await f.service.listArtifacts()).items[0]; await f.service.openArtifact(item.id); assert.equal(f.opened.length, 1);
  const binary = f.write('source/tool.command', 'do not execute');
  await f.service.publishArtifactFile(binary, path.join(f.root, 'output'), { artifactOrigin: f.origin });
  item = (await f.service.listArtifacts()).items.find((a) => a.title === 'tool.command');
  await assert.rejects(f.service.openArtifact(item.id), /ARTIFACT_PREVIEW_UNSUPPORTED/);
  await assert.rejects(f.service.openArtifact('file://' + binary), /ARTIFACT_NOT_FOUND/);
  assert.equal(f.opened.length, 1);
});

test('A11 旧成果显式分批索引只扫可信output，原bytes/mtime不改、无Run或验证历史', async (t) => {
  const f = fixture(t); const original = f.write('userData/bin/output/2026/10/old.md', 'legacy bytes');
  const oldStat = fs.statSync(original); const outside = f.write('outside/no-index.md');
  f.write('userData/bin/output/2026/10/executable.command'); f.write('userData/bin/output/2026/10/unsupported.bin');
  fs.symlinkSync(outside, path.join(path.dirname(original), 'outside-link.md'));
  let cursor; let scanned = 0; let indexed = 0; let skipped = 0;
  for (let i = 0; i < 20; i++) {
    const receipt = await f.service.indexLegacyArtifacts({ cursor, limit: 2 });
    assert.ok(receipt.scanned <= 2); scanned += receipt.scanned; indexed += receipt.indexed; skipped += receipt.skipped;
    if (receipt.done) break; cursor = receipt.nextCursor;
  }
  assert.ok(scanned >= 6); assert.equal(indexed, 1); assert.equal(skipped, 3);
  const items = (await f.service.listArtifacts()).items; assert.equal(items.length, 1);
  assert.equal(items[0].runId, undefined); assert.equal(items[0].attemptId, undefined);
  assert.equal(items[0].validationState, 'pending'); assert.equal(items[0].acceptanceState, 'unreviewed'); assert.equal(items[0].needsReview, true);
  assert.equal(fs.readFileSync(original, 'utf8'), 'legacy bytes'); assert.equal(fs.statSync(original).mtimeMs, oldStat.mtimeMs);
  assert.equal(f.writes.filter((w) => ['copyFile', 'link', 'unlink'].includes(w.method)).length, 0);
  await assert.rejects(f.service.indexLegacyArtifacts({ cursor: '../../outside' }), /ARTIFACT_INDEX_CURSOR_EXPIRED/);
  await f.service.indexLegacyArtifacts(); assert.equal((await f.service.listArtifacts()).items.length, 1);
});

test('A12 并发同名发布不覆盖，list游标无漏，唤醒异常不遮蔽提交事实', async (t) => {
  const f = fixture(t); const first = f.write('one/same.md', 'one'); const second = f.write('two/same.md', 'two');
  f.service.setArtifactWakeListener(() => { throw new Error('fixture observer failure'); });
  const settled = await Promise.allSettled([f.service.publishArtifactFile(first, path.join(f.root, 'output'), { artifactOrigin: f.origin }),
    f.service.publishArtifactFile(second, path.join(f.root, 'output'), { artifactOrigin: f.origin })]);
  const targets = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  assert.ok(targets.length >= 1); assert.equal(new Set(targets).size, targets.length);
  assert.ok(targets.every((p) => ['one', 'two'].includes(fs.readFileSync(p, 'utf8'))));
  const page1 = await f.service.listArtifacts({ limit: 1 }); const page2 = await f.service.listArtifacts({ limit: 1, cursor: page1.nextCursor });
  assert.equal(page1.items.length, 1); assert.equal(page2.items.length, 1); assert.notEqual(page1.items[0].id, page2.items[0].id);
  assert.equal(fs.readFileSync(first, 'utf8'), 'one'); assert.equal(fs.readFileSync(second, 'utf8'), 'two');
});

test('A13 重启只清同inode的stage；被替换的stage保留，最终成果仍saved待核实', async (t) => {
  const f = fixture(t); const source = f.write('source/report.md', 'final content');
  f.db.exec("CREATE TRIGGER deny_saved BEFORE UPDATE ON artifacts WHEN NEW.save_state='saved' BEGIN SELECT RAISE(ABORT,'fixture registration failure'); END;");
  await assert.rejects(f.service.publishArtifactFile(source, path.join(f.root, 'output'), { artifactOrigin: f.origin }), /fixture registration failure/);
  const journal = f.db.prepare('SELECT * FROM artifact_publish_journal').get();
  fs.unlinkSync(journal.staging_path); fs.writeFileSync(journal.staging_path, 'unrelated replacement stage');
  f.db.exec('DROP TRIGGER deny_saved'); const restarted = f.restart();
  const receipt = await restarted.reconcileArtifactPublications();
  assert.equal(receipt.saved, 1); assert.equal(receipt.needsReview, 1);
  assert.equal(fs.readFileSync(journal.staging_path, 'utf8'), 'unrelated replacement stage');
  assert.equal(fs.readFileSync(journal.target_path, 'utf8'), 'final content');
  assert.equal((await restarted.listArtifacts()).items[0].saveState, 'saved');
});

test('A14 symlink source/output父链及非法scheme在创建目录或复制前拒绝', async (t) => {
  const f = fixture(t); const source = f.write('source/report.md');
  const linkedSource = path.join(f.root, 'linked-source.md'); fs.symlinkSync(source, linkedSource);
  await assert.rejects(f.service.publishArtifactFile(linkedSource, path.join(f.root, 'output'), { artifactOrigin: f.origin }), /ARTIFACT_SYMLINK_DENIED/);
  await assert.rejects(f.service.publishArtifactFile('file://' + source, path.join(f.root, 'output'), { artifactOrigin: f.origin }), /ARTIFACT_PATH_INVALID/);
  fs.mkdirSync(path.join(f.root, 'outside'));
  fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.root, 'linked-output'));
  await assert.rejects(f.service.publishArtifactFile(source, path.join(f.root, 'linked-output', 'new'), { artifactOrigin: f.origin }), /ARTIFACT_SYMLINK_DENIED/);
  assert.equal(fs.existsSync(path.join(f.root, 'outside', 'new')), false);
  assert.equal(f.writes.length, 0); assert.equal((await f.service.listArtifacts()).items.length, 0);
});
