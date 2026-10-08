const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { harness, stream, final, assert } = require('../muse/harness.cjs');

for (const [label, reason] of [
  ['string', 'synthetic primitive cancellation'],
  ['frozen Error', Object.freeze(new Error('synthetic frozen cancellation'))],
  ['frozen object', Object.freeze({ kind: 'synthetic cancellation' })],
]) {
  test(`executor preserves ${label} abort reason when attaching an error log`, async (t) => {
    const controller = new AbortController();
    const h = harness(t, { executorTurns: [() => {
      controller.abort(reason);
      return stream([], final());
    }] });
    let rejected = false;
    try { await h.runExecutor({ signal: controller.signal }); }
    catch (error) { rejected = true; assert.strictEqual(error, reason); }
    assert.equal(rejected, true);
    assert.equal(h.parserCalls.length, 0);
    assert.equal(h.adapters[0].closed, true);
    assert.equal(fs.existsSync(path.join(h.root, 'final', 'executor_messages.json')), true);
  });
}

test('cancellation while serializing the final execution log cannot return success', async (t) => {
  const controller = new AbortController();
  const reason = new Error('synthetic log-write cancellation');
  const h = harness(t, { executorTurns: [stream([], final())] });
  const pending = h.runExecutor({ signal: controller.signal });
  assert.equal(h.logs.length, 1);
  h.logs[0].toJSON = function () {
    delete this.toJSON;
    controller.abort(reason);
    return this;
  };
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(h.adapters[0].closed, true);
  assert.ok(h.logs[0].errors.includes(reason.message));
  const saved = JSON.parse(fs.readFileSync(path.join(h.root, 'final', 'executor_messages.json'), 'utf8'));
  assert.ok(saved.errors.includes(reason.message));
});
