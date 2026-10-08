'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const {fixture}=require('../muse-m1-artifact/fixture.cjs');
test('public artifact provenance commits with actual M1 registration and rolls back together without deleting bytes',async t=>{
  const f=fixture(t);f.db.exec('CREATE TABLE synthetic_provenance(id TEXT PRIMARY KEY);');
  const source=f.write('public/report.md','synthetic public report');
  await assert.rejects(f.service.registerExistingArtifact(source,{artifactOrigin:f.origin,onRegisteredInTransaction(record){
    assert.equal(f.db.inTransaction,true);f.db.prepare('INSERT INTO synthetic_provenance VALUES(?)').run(record.id);throw Error('synthetic provenance failure');
  }}),/provenance failure/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM artifact_publish_journal').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM synthetic_provenance').get().n,0);
  assert.equal(fs.readFileSync(source,'utf8'),'synthetic public report');
  const result=await f.service.registerExistingArtifact(source,{artifactOrigin:f.origin,onRegisteredInTransaction(record){
    assert.equal(f.db.inTransaction,true);f.db.prepare('INSERT INTO synthetic_provenance VALUES(?)').run(record.id);
  }});
  assert.equal(result.saveState,'saved');assert.equal(result.validationState,'pending');assert.equal(result.acceptanceState,'unreviewed');
  assert.equal(f.db.prepare('SELECT id FROM synthetic_provenance').get().id,result.id);
});
test('async provenance hooks cannot publish a saved artifact or commit immediate side records',async t=>{
  const f=fixture(t);f.db.exec('CREATE TABLE synthetic_provenance(id TEXT PRIMARY KEY);');const source=f.write('public/report.md','synthetic');
  await assert.rejects(f.service.registerExistingArtifact(source,{artifactOrigin:f.origin,onRegisteredInTransaction(record){
    f.db.prepare('INSERT INTO synthetic_provenance VALUES(?)').run(record.id);return Promise.resolve();
  }}),/ASYNC_FORBIDDEN/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM synthetic_provenance').get().n,0);
  assert.ok(fs.existsSync(source));
});
