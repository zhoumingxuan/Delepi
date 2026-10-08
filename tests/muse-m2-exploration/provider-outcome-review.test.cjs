'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./fixture.cjs');

test('a provider-truncated report settles the complete public pass as failed with no artifact or automatic retry', async t => {
  const f = await fixture(t, { routes: {
    '/public': (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Public source fixture'); },
    '/v1/responses': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'message', status: 'incomplete', content: [{ type: 'output_text', text: 'A cut-off report' }] }],
        usage: { input_tokens: 12, output_tokens: 2048 } }));
    },
  } });
  const stopApprovals = f.approveAll(); t.after(stopApprovals);
  const run = f.start(f.plan('responses')); await f.exploration.waitForRun(run.runId);
  const final = f.exploration.listExplorations()[0];
  assert.equal(final.state, 'failed'); assert.equal(final.stopReason, 'MODEL_RESPONSE_INCOMPLETE');
  assert.equal(final.sourceCount, 1); assert.equal(final.artifactId, undefined);
  assert.equal(f.server.requests.filter(request => request.path === '/v1/responses').length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n, 0);
  const artifactRoot = path.join(f.root, 'public-artifacts');
  assert.equal(fs.existsSync(artifactRoot) ? fs.readdirSync(artifactRoot).length : 0, 0);
  const account = f.ledger.listAccounts().find(value => value.scope === 'global');
  assert.equal(account.used.modelRequests, 1); assert.equal(account.used.tokenUnits, 2060);
  assert.equal(account.reserved.tokenUnits, 0);
});
