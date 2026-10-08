'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runtimeFixture } = require('./runtime-fixture.cjs');
const code = expected => error => error.code === expected;
const all = f => f.ledger.listAccounts();

test('ledger hooks require the Authority transaction and reject unsafe/missing counters', async t => {
  const f = await runtimeFixture(t);
  assert.throws(() => f.ledger.reserveInTransaction('outside-tx', f.action, f.context), code('BUDGET_TRANSACTION_REQUIRED'));
  for (const units of [{}, { ...f.action.units, fetchRequests: -1 }, { ...f.action.units, tokenUnits: 0.5 }, { ...f.action.units, storageBytes: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => f.db.transaction(() => f.ledger.reserveInTransaction('bad', { ...f.action, units }, f.context))(), code('INVALID_BUDGET_AMOUNTS'));
  }
  assert.equal(all(f).length, 0);
});

test('all-account reservation is atomic and concurrent attempts cannot oversell one account', async t => {
  const f = await runtimeFixture(t);
  const tiny = { ...f.caps, global: { ...f.caps.global, fetchRequests: 1 } };
  const ledger = f.api.createBudgetLedger(f.db, { caps: tiny, now: f.now });
  const reserve = id => f.db.transaction(() => ledger.reserveInTransaction(id, f.action, f.context))();
  const result = await Promise.allSettled([Promise.resolve().then(() => reserve('op-one')), Promise.resolve().then(() => reserve('op-two'))]);
  assert.equal(result.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(result.find(value => value.status === 'rejected').reason.code, 'BUDGET_EXHAUSTED');
  const accounts = ledger.listAccounts(); assert.equal(accounts.length, 4);
  assert.ok(accounts.every(value => value.reserved.fetchRequests === 1));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_budget_reservations').get().n, 4);
});

for (const table of ['m2_budget_accounts', 'm2_budget_reservations', 'm2_budget_usage_entries']) {
  test(`native ${table} faults roll back the entire affected ledger transaction`, async t => {
    const f = await runtimeFixture(t);
    const reserve = () => f.db.transaction(() => f.ledger.reserveInTransaction('fault-operation', f.action, f.context))();
    if (table === 'm2_budget_usage_entries') {
      reserve(); const before = JSON.stringify(all(f));
      f.db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic ledger fault'); END`);
      assert.throws(() => f.db.transaction(() => f.ledger.settleInTransaction('fault-operation', 'unknown'))(), /synthetic ledger fault/);
      assert.equal(JSON.stringify(all(f)), before);
      assert.ok(f.db.prepare('SELECT state FROM m2_budget_reservations').all().every(value => value.state === 'reserved'));
    } else {
      f.db.exec(`CREATE TRIGGER fail_reserve BEFORE ${table === 'm2_budget_accounts' ? 'UPDATE' : 'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic ledger fault'); END`);
      assert.throws(reserve, /synthetic ledger fault/);
      assert.equal(all(f).length, 0); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM m2_budget_reservations').get().n, 0);
    }
  });
}

test('reserve and settlement receipts are idempotent but different owners or outcomes conflict', async t => {
  const f = await runtimeFixture(t);
  const reserve = context => f.db.transaction(() => f.ledger.reserveInTransaction('stable-op', f.action, context))();
  reserve(f.context); const before = JSON.stringify(all(f)); reserve(f.context); assert.equal(JSON.stringify(all(f)), before);
  assert.throws(() => reserve({ ...f.context, attemptId: 'other-attempt' }), code('BUDGET_RECEIPT_CONFLICT'));
  const settle = () => f.db.transaction(() => f.ledger.settleInTransaction('stable-op', 'completed', { known: { fetchRequests: 1, downloadBytes: 15, storageBytes: 0, tokenUnits: 0, modelRequests: 0 } }))();
  settle(); const after = JSON.stringify(all(f)); settle(); assert.equal(JSON.stringify(all(f)), after);
  assert.throws(() => f.db.transaction(() => f.ledger.settleInTransaction('stable-op', 'not_started'))(), code('BUDGET_RECEIPT_CONFLICT'));
  assert.ok(all(f).every(value => value.used.fetchRequests === 1 && value.used.downloadBytes === 15 && value.reserved.downloadBytes === 0));
});

test('started cancellation spends its actual request and missing token use stays unknown across restart', async t => {
  const f = await runtimeFixture(t); f.authorizeRule();
  const action = { ...f.action, units: { ...f.action.units, tokenUnits: 100 } };
  const lease = f.authority.prepare(f.context, action); f.authority.markStarted(lease.leaseId, f.context);
  f.authority.settle(lease.leaseId, f.context, 'cancelled', { known: { downloadBytes: 10, storageBytes: 0 } });
  assert.ok(all(f).every(value => value.used.fetchRequests === 1 && value.reserved.tokenUnits === 100 && value.reserved.downloadBytes === 0));
  const replacement = f.api.createBudgetLedger(f.db, { caps: f.caps, now: f.now });
  assert.deepEqual(replacement.listAccounts(), all(f));
  assert.ok(f.db.prepare('SELECT state FROM m2_budget_reservations').all().every(value => value.state === 'unknown'));
});

test('startup reconciliation joins journal and ledger atomically and retains unknown reservations', async t => {
  const f = await runtimeFixture(t); f.authorizeRule();
  const lease = f.authority.prepare(f.context, f.action); f.authority.markStarted(lease.leaseId, f.context);
  const facts = f.authority.reconcileInterrupted(); assert.equal(facts.operations, 1);
  assert.ok(all(f).every(value => value.used.fetchRequests === 1 && value.reserved.downloadBytes === 1000));
  assert.equal(f.db.prepare('SELECT state FROM m2_operations WHERE id=?').get(lease.operationId).state, 'outcome_unknown');
  assert.ok(f.db.prepare('SELECT state FROM m2_budget_reservations').all().every(value => value.state === 'unknown'));
});

test('UTC midnight establishes only the new day account and never resets cumulative or old unknown use', async t => {
  const f = await runtimeFixture(t);
  f.db.transaction(() => f.ledger.reserveInTransaction('day-one', f.action, f.context))();
  f.db.transaction(() => f.ledger.settleInTransaction('day-one', 'unknown'))();
  f.advance(86400000);
  f.db.transaction(() => f.ledger.reserveInTransaction('day-two', f.action, f.context))();
  const accounts = all(f), days = accounts.filter(value => value.scope === 'day');
  assert.equal(days.length, 2); assert.ok(days.every(value => value.timezone === 'UTC' && Date.parse(value.windowEnd) - Date.parse(value.windowStart) === 86400000));
  assert.equal(accounts.find(value => value.scope === 'global').reserved.fetchRequests, 2);
  assert.equal(days[0].reserved.fetchRequests, 1); assert.equal(days[1].reserved.fetchRequests, 1);
});

test('known byte overrun is recorded rather than erased and closes future admission', async t => {
  const f = await runtimeFixture(t);
  const ledger = f.api.createBudgetLedger(f.db, { caps: { ...f.caps, global: { ...f.caps.global, downloadBytes: 1000 } }, now: f.now });
  f.db.transaction(() => ledger.reserveInTransaction('overrun', f.action, f.context))();
  f.db.transaction(() => ledger.settleInTransaction('overrun', 'failed', { known: { fetchRequests: 1, downloadBytes: 1100, modelRequests: 0, storageBytes: 0, tokenUnits: 0 } }))();
  assert.equal(ledger.listAccounts().find(value => value.scope === 'global').used.downloadBytes, 1100);
  assert.throws(() => f.db.transaction(() => ledger.reserveInTransaction('next', f.action, f.context))(), code('BUDGET_EXHAUSTED'));
});
