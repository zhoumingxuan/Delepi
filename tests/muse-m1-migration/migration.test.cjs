const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
require('./loader.cjs').install();
const {applyMuseMigrations,MUSE_MIGRATIONS} = require('../../src/main/db/migrations/index.ts');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'delepi-m1-migration-'));
  const db = new Database(path.join(dir, 'legacy.sqlite3'));
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT,is_running INTEGER);
    CREATE TABLE messages(id TEXT PRIMARY KEY,payload_json TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value_json TEXT);
    INSERT INTO conversations VALUES('synthetic','测试',0);
    INSERT INTO messages VALUES('synthetic-message','{"content":"fixture only"}');
    INSERT INTO settings VALUES('mainThinkingLevel','""');`);
  t.after(async () => {if(db.open) db.close();await fs.rm(dir, {recursive:true,force:true});});
  return {db,dir,backupDir:path.join(dir,'backups')};
}
function legacy(db) {
  return ['conversations','messages','settings'].map(n => db.prepare(`SELECT * FROM ${n}`).all());
}
test('incremental migration preserves legacy values, backs up committed WAL and retries idempotently',async t=>{
  const f=await fixture(t);const before=legacy(f.db);
  const receipts=await applyMuseMigrations(f.db,f);
  assert.equal(receipts.length,MUSE_MIGRATIONS.length);
  assert.deepEqual(legacy(f.db),before);
  const backup=new Database(receipts[0].backupPath,{readonly:true});
  assert.deepEqual(legacy(backup),before);
  assert.equal(backup.prepare("SELECT 1 FROM sqlite_master WHERE name='runs'").get(),undefined);
  backup.close();
  assert.deepEqual(await applyMuseMigrations(f.db,f),[]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n,MUSE_MIGRATIONS.length);
  assert.equal((await fs.stat(receipts[0].backupPath)).mode & 0o777,0o600);
  assert.equal((await fs.stat(f.backupDir)).mode & 0o777,0o700);
  const text=await fs.readFile(receipts[0].backupPath+'.receipt.json','utf8');
  assert.ok(!text.includes('fixture only'));
});
test('fault after DDL rolls back every new table and permits restart migration',async t=>{
  const f=await fixture(t);const before=legacy(f.db);
  await assert.rejects(applyMuseMigrations(f.db,{...f,afterDdl(){throw Error('injected ddl failure');}}),/injected/);
  assert.deepEqual(legacy(f.db),before);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('runs','schema_migrations','artifacts')").all().length,0);
  await applyMuseMigrations(f.db,f);
  assert.ok(f.db.prepare("SELECT name FROM sqlite_master WHERE name='runs'").get());
});
test('future version or changed checksum fails closed without touching old data',async t=>{
  const f=await fixture(t);await applyMuseMigrations(f.db,f);
  const before=legacy(f.db);
  f.db.prepare("UPDATE schema_migrations SET checksum='changed'").run();
  await assert.rejects(applyMuseMigrations(f.db,f),/MISMATCH/);
  assert.deepEqual(legacy(f.db),before);
});
test('backup failure does not create migration structures or begin mutation',async t=>{
  const f=await fixture(t);const bad=path.join(f.dir,'not-a-directory');await fs.writeFile(bad,'fixture');
  await assert.rejects(applyMuseMigrations(f.db,{backupDir:bad}));
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get(),undefined);
});
test('migration activity events reject updates and deletes',async t=>{
  const f=await fixture(t);await applyMuseMigrations(f.db,f);
  f.db.prepare("INSERT INTO activity_events(run_id,conversation_id,kind,details_json,occurred_at,committed_at) VALUES('r','c','synthetic','{}','t','t')").run();
  assert.throws(()=>f.db.prepare("UPDATE activity_events SET kind='altered'").run(),/immutable/);
  assert.throws(()=>f.db.prepare('DELETE FROM activity_events').run(),/immutable/);
});
test('startup cleanup preserves every persisted failed/cancelled/completed workspace without legacy log references',async t=>{
  const f=await fixture(t);await applyMuseMigrations(f.db,f);
  const {listPersistentTaskWorkspacePaths}=require('../../src/main/modules/tasks/workspace-protection.ts');
  const {cleanupTaskTemporaryPaths}=require('../../src/main/modules/executor-agent/task-cleanup.ts');
  const conversations=await fs.realpath(f.dir);const root=path.join(conversations,'conversations');
  const tasks=path.join(root,'synthetic','tasks');await fs.mkdir(tasks,{recursive:true});
  const at='2030-01-01T00:00:00.000Z';
  f.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)').run('r','synthetic','root','o',1,'completed',1,at,at,at);
  const states=['failed','cancelled','completed','interrupted'];
  for(let i=0;i<205;i++) {
    const id=`delegate-${i}`;
    f.db.prepare('INSERT INTO task_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'r',id,null,id,'o',1,states[i%states.length],at,at,'fixture');
    await fs.mkdir(path.join(tasks,id));await fs.writeFile(path.join(tasks,id,'executor_messages.json'),'synthetic error evidence');
  }
  const orphan=path.join(tasks,'unreferenced');await fs.mkdir(orphan);await fs.writeFile(path.join(orphan,'tmp'),'temporary');
  const protectedPaths=listPersistentTaskWorkspacePaths(f.db,root);
  assert.equal(protectedPaths.length,205);
  const result=await cleanupTaskTemporaryPaths({workspaceDir:tasks,temporaryPaths:(await fs.readdir(tasks)).map(n=>path.join(tasks,n)),protectedPaths});
  assert.deepEqual(result.removedPaths,[orphan]);
  assert.equal((await fs.readdir(tasks)).length,205);
  f.db.prepare("UPDATE task_attempts SET delegate_call_id='../escape' WHERE id='delegate-0'").run();
  assert.throws(()=>listPersistentTaskWorkspacePaths(f.db,root),/REFERENCE_INVALID/);
});
