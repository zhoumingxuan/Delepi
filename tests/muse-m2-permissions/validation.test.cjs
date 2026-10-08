'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');
const work = path.resolve(__dirname, '../..');
const compiled = esbuild.buildSync({ stdin: { contents: 'export * from "./src/main/modules/permissions/permission-validation"; export * from "./src/main/modules/permissions/legacy-policy";', resolveDir: work }, bundle: true, platform: 'node', format: 'cjs', write: false });
const filename = path.join(work, 'isolated-runs', 'validation.cjs');
const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = module.paths; loaded._compile(compiled.outputFiles[0].text, filename);
const api = loaded.exports;

test('approval hashes bind values but tolerate only irrelevant JSON key order', () => {
  assert.equal(api.permissionHash({ scope: ['resource-a', 'resource-b'], args: { x: 1, y: 2 } }), api.permissionHash({ args: { y: 2, x: 1 }, scope: ['resource-a', 'resource-b'] }));
  const old = api.permissionHash({ destination: 'model-a', resource: { hash: 'original', version: 1 }, mode: 'public' });
  for (const changed of [{ destination: 'model-b', resource: { hash: 'original', version: 1 }, mode: 'public' }, { destination: 'model-a', resource: { hash: 'new', version: 1 }, mode: 'public' }, { destination: 'model-a', resource: { hash: 'original', version: 2 }, mode: 'public' }]) assert.notEqual(api.permissionHash(changed), old);
});

test('hostile and ambiguous approval inputs cannot be hashed or serialized as trusted intent', () => {
  const cycle = {}; cycle.x = cycle;
  for (const raw of [cycle, { x: undefined }, { x: NaN }, { x: Infinity }, { x: () => true }, new Date(), JSON.parse('{"__proto__":{"privileged":true}}'), { x: 'synthetic-secret'.repeat(64000) }, { x: new Array(201).fill('x') }]) assert.throws(() => api.permissionHash(raw), error => error.code === 'INVALID_REQUEST' && !error.message.includes('synthetic-secret'));
  for (const raw of ['../../path', '/tmp/file', 'bad:owner', '', 'x'.repeat(129)]) assert.throws(() => api.permissionId(raw));
  for (const raw of ['2026-02-30T00:00:00.000Z', '2026-10-07', '2026-10-07T00:00:00Z']) assert.throws(() => api.permissionDate(raw));
});

test('missing and broad old switches only preserve trusted compatibility, never mint public permissions', () => {
  for (const raw of [undefined, { version: 1 }, { version: 1, tools: { shell: true }, os: { screen: { useEnabled: true } } }]) {
    const projected = api.normalizeLegacyDeny(raw);
    assert.equal(projected.denyAll, false); assert.deepEqual(projected.deniedToolGroups, []);
    assert.equal(Object.hasOwn(projected, 'grant'), false); assert.equal(Object.hasOwn(projected, 'publicEnabled'), false);
  }
});

test('old false or malformed policies close affected capabilities without widening unrelated flags', () => {
  for (const raw of [null, [], { version: 2 }]) assert.equal(api.normalizeLegacyDeny(raw).denyAll, true);
  const projected = api.normalizeLegacyDeny({ version: 1, assistantRequestsEnabled: false, tools: { shell: false, python: 'true' }, os: { screen: { useEnabled: false, requestEnabled: true }, camera: ['malformed'] } });
  assert.equal(projected.assistantRequestsDenied, true);
  assert.deepEqual(projected.deniedToolGroups, ['shell', 'python']);
  assert.ok(projected.deniedOSUse.includes('screen')); assert.ok(projected.deniedOSUse.includes('camera'));
  assert.equal(projected.deniedOSRequests.includes('screen'), false); assert.ok(projected.deniedOSRequests.includes('camera'));
});
