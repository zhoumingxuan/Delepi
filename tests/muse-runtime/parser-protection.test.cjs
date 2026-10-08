const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { harness, final, assert } = require('../muse/harness.cjs');
const { WORK, newRun } = require('../muse/paths.cjs');
const { createLoader } = require('../muse/controlled-loader.cjs');

test('parser publishes exact internal protocol refs and cleanup preserves them', async (t) => {
  const h = harness(t);
  const workspaceDir = path.join(h.root, 'final');
  const summary = path.join(workspaceDir, 'actual-summary.md');
  const deliverable = path.join(workspaceDir, 'actual-plan.md');
  const cleanupInfo = path.join(workspaceDir, 'actual-cleanable.json');
  const temporary = path.join(workspaceDir, 'scratch.txt');
  fs.writeFileSync(summary, 'synthetic summary');
  fs.writeFileSync(deliverable, 'synthetic plan');
  fs.writeFileSync(temporary, 'discardable synthetic scratch');
  fs.writeFileSync(cleanupInfo, JSON.stringify({ temporary_paths: [summary, deliverable, cleanupInfo, temporary] }));
  const parsed = await h.parser.parseExecutorStructuredPayload({
    raw: final(true, {
      summary_filename: 'actual-summary.md',
      deliverable_filename: 'actual-plan.md',
      cleanable_info_filename: 'actual-cleanable.json',
    }),
    deliveryType: '方案', finalOutputDir: workspaceDir, outputDir: path.join(h.root, 'output'),
  });
  assert.ok(parsed.payload);
  assert.deepEqual([...new Set(parsed.payload.protocolFilePaths)].sort(), [summary, deliverable, cleanupInfo].sort());
  const { cleanupTaskTemporaryPaths } = h.loader.load('src/main/modules/executor-agent/task-cleanup.ts');
  const cleaned = await cleanupTaskTemporaryPaths({
    workspaceDir, temporaryPaths: parsed.payload.temporaryPaths,
    protectedPaths: parsed.payload.protocolFilePaths,
  });
  assert.deepEqual(cleaned.removedPaths, [temporary]);
  assert.equal(cleaned.deferredPaths.length, 3);
  assert.equal(cleaned.failedPaths.length, 0);
  for (const protectedPath of [summary, deliverable, cleanupInfo]) assert.equal(fs.existsSync(protectedPath), true);
});

test('parser protocol refs include the actual copied deliverable path', async (t) => {
  const root = newRun();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceDir = path.join(root, 'final');
  const outputDir = path.join(root, 'output');
  fs.writeFileSync(path.join(workspaceDir, 'summary.md'), 'synthetic summary');
  fs.writeFileSync(path.join(workspaceDir, 'deliverable.json'), 'synthetic document');
  const mocks = {
    electron: { app: { isPackaged: true, getPath: () => root } },
    [path.join(WORK, 'src/main/utils/index.ts')]: { isRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) },
    [path.join(WORK, 'src/main/utils/storage-output.ts')]: {
      copyFileToOutputDir: async (source, targetDir) => {
        assert.ok(source.startsWith(root + path.sep));
        assert.equal(targetDir, outputDir);
        const target = path.join(targetDir, path.basename(source));
        await fs.promises.copyFile(source, target);
        return target;
      },
    },
  };
  const loader = createLoader({ root, mocks });
  const parser = loader.load('src/main/modules/executor-agent/executor-structured-payload.ts');
  const parsed = await parser.parseExecutorStructuredPayload({
    raw: final(), deliveryType: '方案', finalOutputDir: workspaceDir,
    outputDir,
  });
  assert.ok(parsed.payload);
  const copied = parsed.payload.result['方案文档路径'];
  assert.equal(copied, path.join(outputDir, 'deliverable.json'));
  assert.equal(fs.readFileSync(copied, 'utf8'), 'synthetic document');
  assert.ok(parsed.payload.protocolFilePaths.includes(copied));
  assert.ok(parsed.payload.protocolFilePaths.includes(path.join(workspaceDir, 'summary.md')));
});
