'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('../muse-m2-exploration/fixture.cjs');
const {loadSource}=require('../muse-m2-brokers/fixture.cjs');
let source;
async function hookedBootstrap(afterClose) {
  const Module=require('node:module'),esbuild=require('esbuild');
  const build=await esbuild.build({entryPoints:[path.resolve(__dirname,'../../src/main/modules/background/installation-bootstrap.ts')],
    bundle:true,write:false,platform:'node',format:'cjs',external:['better-sqlite3','bootstrap-review-hooks'],plugins:[{name:'actual-fs-permission-race',setup(build){
      build.onResolve({filter:/^node:fs\/promises$/},args=>args.namespace==='hook'?{path:args.path,external:true}:{path:'bootstrap-fs',namespace:'hook'});
      build.onLoad({filter:/bootstrap-fs/,namespace:'hook'},()=>({loader:'js',contents:
        'const fs=require("node:fs/promises"),hooks=require("bootstrap-review-hooks"); export const lstat=fs.lstat,realpath=fs.realpath,rename=fs.rename,unlink=fs.unlink; export async function open(...args){const file=await fs.open(...args),close=file.close.bind(file);file.close=async()=>{await close();await hooks.afterClose(args[0]);};return file;}'}));
    }}]});
  const mod=new Module(path.resolve(__dirname,'../../isolated-runs/bootstrap-review-module.cjs'),module);mod.paths=module.paths;
  const native=mod.require.bind(mod);mod.require=name=>name==='bootstrap-review-hooks'?{afterClose}:native(name);
  mod._compile(build.outputFiles[0].text,mod.id);return mod.exports;
}
async function setup(t,options={}) {
  const f=await fixture(t),api=await(source??=Promise.all(['src/main/db/migrations/background-schema.ts','src/main/modules/background/scheduler.ts',
    'src/main/modules/background/installation-bootstrap.ts'].map(loadSource)).then(values=>Object.assign({},...values)));
  f.db.exec(api.BACKGROUND_SCHEMA_SQL);
  const scheduler=api.createBackgroundScheduler(f.db,{goals:f.goals,authority:f.authority,exploration:f.exploration,taskService:f.tasks,foregroundBusy:()=>false});
  t.after(()=>scheduler.dispose());
  const directory=path.join(f.root,'muse'),requestPath=path.join(directory,'background-enablement-request.json');
  fs.mkdirSync(directory,{mode:options.directoryMode??0o700});fs.chmodSync(directory,options.directoryMode??0o700);
  const now=Date.now(),request={schemaVersion:1,requestId:'trusted-bootstrap-review',preset:'excel-data-quality-v1',
    createdAt:new Date(now).toISOString(),expiresAt:new Date(now+86400000).toISOString(),protocol:'chat-completions'};
  fs.writeFileSync(requestPath,JSON.stringify(request),{mode:options.fileMode??0o600});fs.chmodSync(requestPath,options.fileMode??0o600);
  return {...f,api,directory,requestPath,scheduler,consume:()=>api.consumeBackgroundEnablementRequest(f.db,{goals:f.goals,scheduler},f.root)};
}

for(const options of [{directoryMode:0o777},{directoryMode:0o770},{fileMode:0o666},{fileMode:0o660}])test(`bootstrap refuses other-user write permission ${JSON.stringify(options)} before any Goal/rule/schedule/receipt`,async t=>{
  const f=await setup(t,options),goals=f.goals.list().length;
  await assert.rejects(f.consume(),error=>error.code==='BACKGROUND_REQUEST_INVALID');
  assert.equal(f.goals.list().length,goals);assert.equal(f.authority.listRules().length,0);
  assert.equal(f.scheduler.list().length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM muse_background_enablement_receipts').get().n,0);
  assert.equal(fs.existsSync(f.requestPath),true);assert.equal(f.server.requests.length,0);
});

test('same-user read-only 0644 request in protected directory remains compatible and preserves production-style settings',async t=>{
  const f=await setup(t,{directoryMode:0o755,fileMode:0o644});
  const before=f.db.prepare('SELECT * FROM settings').all(),receipt=await f.consume();
  assert.equal(receipt.preset,'excel-data-quality-v1');assert.equal(receipt.protocol,'chat-completions');
  assert.equal(f.scheduler.list().length,1);assert.equal(f.authority.listRules().length,1);assert.equal(fs.existsSync(f.requestPath),false);
  assert.deepEqual(f.db.prepare('SELECT * FROM settings').all(),before);assert.equal(f.server.requests.length,0);
});

for(const target of ['directory','request'])test(`bootstrap rechecks ${target} write permission changed after the actual file read before committing authorization`,async t=>{
  const f=await setup(t);let changed=false;
  const api=await hookedBootstrap(file=>{
    if(file===f.requestPath&&!changed){changed=true;fs.chmodSync(target==='directory'?f.directory:f.requestPath,0o777);}
  });
  await assert.rejects(api.consumeBackgroundEnablementRequest(f.db,{goals:f.goals,scheduler:f.scheduler},f.root),error=>error.code==='BACKGROUND_REQUEST_CHANGED');
  assert.equal(changed,true);assert.equal(f.goals.list().length,1);assert.equal(f.authority.listRules().length,0);assert.equal(f.scheduler.list().length,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM muse_background_enablement_receipts').get().n,0);
});
