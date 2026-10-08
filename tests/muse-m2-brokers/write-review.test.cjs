'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const { runtimeFixture } = require('./runtime-fixture.cjs');
test('a descriptor-close failure after snapshot bytes were written retains storage occupancy and a review journal', async t => {
  const f = await runtimeFixture(t); f.authorizeRule(['fetch.public']);
  const bytes = Buffer.from('Synthetic bytes whose close receipt fails');
  const realOpen = fsPromises.open;
  fsPromises.open = async (...args) => {
    const handle = await realOpen(...args);
    if (!String(args[0]).startsWith(f.publicRoot + '/')) return handle;
    return new Proxy(handle, { get(target, key) {
      if (key === 'close') return async () => { await target.close(); throw Error('synthetic close receipt failure'); };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  t.after(() => { fsPromises.open = realOpen; });
  const broker = f.api.createFetchBroker(f.db, { transport: { async request(options) { options.beforeStart(); options.beforeConnect(); return { status: 200, headers: { 'content-type': 'text/plain' }, body: bytes, receivedBytes: bytes.length }; } }, registerSnapshot: (...args) => f.file.registerSnapshot(...args) });
  await assert.rejects(broker.fetch(f.session, 'resource-fixture'));
  fsPromises.open = realOpen;
  const runAccount = f.ledger.listAccounts(f.context).find(account => account.scope === 'run');
  const files = fs.readdirSync(f.publicRoot); assert.equal(files.length, 1); assert.equal(fs.readFileSync(f.publicRoot + '/' + files[0]).length, bytes.length);
  assert.ok(runAccount.used.storageBytes + runAccount.reserved.storageBytes >= bytes.length, 'Written bytes must remain spent or reserved despite descriptor close failure');
  const journal = f.db.prepare('SELECT state,size_bytes FROM m2_public_write_journal').get(); assert.equal(journal.state, 'review_required'); assert.equal(journal.size_bytes, bytes.length);
});
