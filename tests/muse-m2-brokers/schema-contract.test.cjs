'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const {loadSource,databaseFixture}=require('./fixture.cjs');
const zero={modelRequests:0,fetchRequests:0,downloadBytes:0,storageBytes:0,tokenUnits:0};

test('budget schema rejects missing, fractional, negative and unsafe amount counters',async t=>{
  const {BUDGET_SCHEMA_SQL}=await loadSource('src/main/modules/budget/schema.ts');
  const {db}=databaseFixture(t,BUDGET_SCHEMA_SQL);
  const insert=db.prepare('INSERT INTO m2_budget_accounts(id,scope,scope_ref,window_key,limits_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  insert.run('valid','global','public','lifetime',JSON.stringify(zero),'t','t');
  for(const bad of [{},{...zero,modelRequests:-1},{...zero,fetchRequests:0.5},
    {...zero,downloadBytes:9007199254740992},{...zero,tokenUnits:'10'},null,[]])
    assert.throws(()=>insert.run('invalid','global','invalid','lifetime',JSON.stringify(bad),'t','t'),/CHECK/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM m2_budget_accounts').get().n,1);
});

test('budget reservations are unique per operation/account and usage records cannot be rewritten',async t=>{
  const {BUDGET_SCHEMA_SQL}=await loadSource('src/main/modules/budget/schema.ts');
  const {db}=databaseFixture(t,BUDGET_SCHEMA_SQL);const amounts=JSON.stringify(zero);
  db.prepare('INSERT INTO m2_budget_accounts(id,scope,scope_ref,window_key,limits_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('account','global','public','lifetime',amounts,'t','t');
  const reserve=db.prepare('INSERT INTO m2_budget_reservations(operation_id,account_id,owner_id,run_id,attempt_id,generation,amount_json,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
  reserve.run('op','account','owner','run','attempt',1,amounts,'reserved','t');
  assert.throws(()=>reserve.run('op','account','owner','run','attempt',1,amounts,'reserved','t'),/UNIQUE/);
  db.prepare('INSERT INTO m2_budget_usage_entries(operation_id,account_id,kind,amount_json,recorded_at) VALUES(?,?,?,?,?)').run('op','account','spent',amounts,'t');
  assert.throws(()=>db.prepare("UPDATE m2_budget_usage_entries SET kind='released'").run(),/immutable/);
  assert.throws(()=>db.prepare('DELETE FROM m2_budget_usage_entries').run(),/immutable/);
});

test('independent v2 migration preserves v1 receipt and legacy bytes with idempotent retry',async t=>{
  const migration=await loadSource('src/main/db/migrations/index.ts');
  const {AUTONOMY_SCHEMA_SQL}=await loadSource('src/main/db/migrations/autonomy-schema.ts');
  const {db,root}=databaseFixture(t,"CREATE TABLE messages(id TEXT PRIMARY KEY,payload_json TEXT);INSERT INTO messages VALUES('synthetic','{\"content\":\"private fixture only\"}');");
  const options={backupDir:path.join(root,'backups'),migrations:[migration.MUSE_MIGRATIONS[0]]};
  await migration.applyMuseMigrations(db,options);
  const before=db.prepare('SELECT * FROM schema_migrations').all();
  const legacy=db.prepare('SELECT * FROM messages').all();
  options.migrations.push({version:2,name:'muse-m2-public-autonomy',sql:AUTONOMY_SCHEMA_SQL});
  const receipts=await migration.applyMuseMigrations(db,options);
  assert.equal(receipts.length,1);assert.equal(receipts[0].schemaVersion,2);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version=1').all(),before);
  assert.deepEqual(db.prepare('SELECT * FROM messages').all(),legacy);
  assert.deepEqual(await migration.applyMuseMigrations(db,options),[]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n,2);
});

test('independent v2 migration refuses a preexisting incompatible table instead of adopting it',async t=>{
  const migration=await loadSource('src/main/db/migrations/index.ts');
  const {AUTONOMY_SCHEMA_SQL}=await loadSource('src/main/db/migrations/autonomy-schema.ts');
  const {db,root}=databaseFixture(t,'CREATE TABLE conversations(id TEXT PRIMARY KEY);');
  const migrations=[migration.MUSE_MIGRATIONS[0]];
  await migration.applyMuseMigrations(db,{backupDir:path.join(root,'backups'),migrations});
  db.exec('CREATE TABLE m2_goals(incompatible TEXT);');
  migrations.push({version:2,name:'muse-m2-public-autonomy',sql:AUTONOMY_SCHEMA_SQL});
  await assert.rejects(migration.applyMuseMigrations(db,{backupDir:path.join(root,'backups'),migrations}));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=2').get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='m2_budget_accounts'").get().n,0);
  assert.deepEqual(db.prepare('PRAGMA table_info(m2_goals)').all().map(row=>row.name),['incompatible']);
});
