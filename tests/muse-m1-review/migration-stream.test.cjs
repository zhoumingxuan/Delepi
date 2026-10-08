'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {createHash}=require('node:crypto');const Database=require('better-sqlite3');
require('../muse-m1-migration/loader.cjs').install();
const {applyMuseMigrations}=require('../../src/main/db/migrations/index.ts');

test('review: multi-chunk legacy WAL backup keeps exact bytes and checksum with streaming hashing',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'delepi-review-stream-'));
  const db=new Database(path.join(dir,'legacy.sqlite'));db.pragma('journal_mode = WAL');
  t.after(async()=>{if(db.open)db.close();await fs.rm(dir,{recursive:true,force:true});});
  const text='synthetic-private-text-'.repeat(65536);
  db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,payload_json TEXT);');
  db.prepare('INSERT INTO messages VALUES(?,?)').run('fixture',JSON.stringify({content:text}));
  const [receipt]=await applyMuseMigrations(db,{backupDir:path.join(dir,'backups')});
  const bytes=await fs.readFile(receipt.backupPath);assert.ok(bytes.length>1024*1024);
  assert.equal(receipt.backupSha256,createHash('sha256').update(bytes).digest('hex'));
  const backup=new Database(receipt.backupPath,{readonly:true});
  try{assert.equal(JSON.parse(backup.prepare('SELECT payload_json FROM messages').get().payload_json).content,text);}
  finally{backup.close();}
  assert.equal(JSON.parse(db.prepare('SELECT payload_json FROM messages').get().payload_json).content,text);
  assert.equal((await fs.stat(receipt.backupPath)).mode&0o777,0o600);
  const report=await fs.readFile(receipt.backupPath+'.receipt.json','utf8');assert.equal(report.includes('synthetic-private-text'),false);
});
