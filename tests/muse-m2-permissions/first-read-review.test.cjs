'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixture.cjs');
const { runtimeFixture } = require('../muse-m2-brokers/runtime-fixture.cjs');
function firstReadFault(f) {
  const original = f.db.prepare.bind(f.db); let injected = false;
  f.db.prepare = sql => {
    if (!injected && sql === 'SELECT * FROM m2_approval_previews WHERE id=?') {
      injected = true; throw Error('synthetic first approval read fault');
    }
    return original(sql);
  };
  return () => { f.db.prepare = original; };
}

test('real BrokerSession seals its minted pending card when the first wait read fails and starts no operation', async t => {
  const f = await runtimeFixture(t); const preview = f.authority.previewAction.bind(f.authority);
  let card, restore;
  f.authority.previewAction = (...args) => { card = preview(...args); restore = firstReadFault(f); return card; };
  try { await assert.rejects(f.session.prepare(f.action), /synthetic first approval read fault/); }
  finally { restore?.(); }
  const final = f.authority.getApproval(card.id); assert.equal(final.state, 'revoked');
  assert.throws(() => f.authority.decideApproval(card.id, final.revision, 'once', 1), error => error.code === 'APPROVAL_NOT_PENDING');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM m2_operations').get().n, 0);
  assert.equal(f.ledger.listAccounts().length, 0); assert.equal(f.concurrency.active, 0);
  assert.equal(JSON.stringify(card).includes('context'), false);
});

test('owned first-read fault preserves the original error and blocks a card even when its seal write fails', async t => {
  const f = await fixture(t), card = f.preview();
  f.db.exec("CREATE TRIGGER fail_first_read_seal BEFORE UPDATE ON m2_approval_previews BEGIN SELECT RAISE(ABORT,'synthetic card seal failure'); END");
  const restore = firstReadFault(f);
  try { await assert.rejects(f.authority.waitForDecision(card.id, undefined, { preview: card, context: f.context }), /synthetic first approval read fault/); }
  finally { restore(); }
  assert.equal(f.db.prepare('SELECT state FROM m2_approval_previews WHERE id=?').get(card.id).state, 'pending');
  assert.equal(f.authority.getApproval(card.id).state, 'revoked');
  f.db.exec('DROP TRIGGER fail_first_read_seal');
  assert.throws(() => f.authority.decideApproval(card.id, card.revision, 'once', 1), error => error.code === 'APPROVAL_NOT_PENDING');
});

for (const kind of ['id-only', 'clone', 'foreign-conversation', 'foreign-task', 'foreign-parent', 'foreign-delegate']) {
  test(`first-read fault from ${kind} cannot revoke a different trusted pending card`, async t => {
    const f = await fixture(t), card = f.preview();
    const changes = { 'foreign-conversation': { conversationId: 'foreign' }, 'foreign-task': { taskId: 'foreign' },
      'foreign-parent': { parentAttemptId: 'foreign' }, 'foreign-delegate': { delegateCallId: 'foreign' } };
    const proof = kind === 'id-only' ? undefined : { preview: kind === 'clone' ? { ...card } : card, context: { ...f.context, ...changes[kind] } };
    const restore = firstReadFault(f);
    try { await assert.rejects(f.authority.waitForDecision(card.id, undefined, proof), /synthetic first approval read fault/); }
    finally { restore(); }
    assert.equal(f.authority.getApproval(card.id).state, 'pending');
    assert.equal(f.authority.decideApproval(card.id, card.revision, 'once', 1).state, 'approved');
  });
}

test('a minted proof for another card cannot seal the requested card', async t => {
  const f = await fixture(t), card = f.preview();
  const other = f.authority.previewAction(f.context, { ...f.action, summary: 'Other card' }, 1);
  assert.notEqual(card.id, other.id);
  const restore = firstReadFault(f);
  try { await assert.rejects(f.authority.waitForDecision(other.id, undefined, { preview: card, context: f.context }), /synthetic first approval read fault/); }
  finally { restore(); }
  assert.equal(f.authority.getApproval(card.id).state, 'pending'); assert.equal(f.authority.getApproval(other.id).state, 'pending');
});

test('disposed authority clears unused minted proofs so an old object cannot block a card on a read fault', async t => {
  const f = await fixture(t), card = f.preview(); f.authority.dispose();
  const restore = firstReadFault(f);
  try { await assert.rejects(f.authority.waitForDecision(card.id, undefined, { preview: card, context: f.context }), /synthetic first approval read fault/); }
  finally { restore(); }
  assert.equal(f.authority.getApproval(card.id).state, 'pending');
});
