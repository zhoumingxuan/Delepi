'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const Database=require('better-sqlite3');
require('../muse-m1-migration/loader.cjs').install();
const {applyMuseMigrations}=require('../../src/main/db/migrations/index.ts');

test('independent review: backup hash stream failure prevents DDL and keeps the exact legacy WAL data',async t=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'delepi-review-stream-fault-'));
  const db=new Database(path.join(dir,'legacy.sqlite'));db.pragma('journal_mode=WAL');
  t.after(async()=>{if(db.open)db.close();await fsp.rm(dir,{recursive:true,force:true});});
  const text='synthetic-stream-fault-data-'.repeat(8192);
  db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,payload_json TEXT)');
  db.prepare('INSERT INTO messages VALUES(?,?)').run('M',JSON.stringify({content:text}));
  const original=fs.createReadStream;let chunks=0;
  fs.createReadStream=(...args)=>{
    const stream=original(...args);
    return {async *[Symbol.asyncIterator](){
      try {for await(const chunk of stream){chunks++;yield chunk;throw new Error('synthetic backup stream read fault');}}
      finally {stream.destroy();}
    }};
  };
  try {
    await assert.rejects(applyMuseMigrations(db,{backupDir:path.join(dir,'backups')}),/synthetic backup stream read fault/);
  } finally {fs.createReadStream=original;}
  assert.equal(chunks,1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('schema_migrations','runs','artifacts')").get().n,0);
  assert.equal(JSON.parse(db.prepare('SELECT payload_json FROM messages').get().payload_json).content,text);
  const files=await fsp.readdir(path.join(dir,'backups'));
  assert.equal(files.length,1);assert.ok(files[0].endsWith('.sqlite3'));
  const backup=new Database(path.join(dir,'backups',files[0]),{readonly:true});
  try {assert.equal(JSON.parse(backup.prepare('SELECT payload_json FROM messages').get().payload_json).content,text);}
  finally {backup.close();}
});
