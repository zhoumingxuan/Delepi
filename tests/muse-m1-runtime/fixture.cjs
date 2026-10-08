'use strict';
const fs=require('node:fs');const path=require('node:path');const Module=require('node:module');
const esbuild=require('esbuild');const Database=require('better-sqlite3');
const WORK=path.resolve(__dirname,'../..');
const allowed=path.join(WORK,'isolated-runs');
function bundle(file, extra={}) {
  const result=esbuild.buildSync({entryPoints:[path.join(WORK,file)],bundle:true,platform:'node',format:'cjs',write:false,
    external:['better-sqlite3'],plugins:undefined});
  const loaded=new Module(path.join(WORK,'isolated-runs','fixture-module.cjs'),module);loaded.paths=module.paths;
  loaded._compile(result.outputFiles[0].text,loaded.filename);return {...loaded.exports,...extra};
}
let exportsPromise;
async function runtimeExports() {
  return exportsPromise??=esbuild.build({stdin:{contents:'export * from "./src/main/modules/tasks/task-service"; export * from "./src/main/db/migrations/runtime-schema";',resolveDir:WORK},
    bundle:true,platform:'node',format:'cjs',write:false,external:['better-sqlite3'],plugins:[{name:'isolate-sqlite-singleton',setup(build){
      build.onResolve({filter:/sqlite-adapter$/},()=>({path:'never-production-db',namespace:'fixture'}));
      build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export function getDb(){throw new Error("Production userData is forbidden in fixture");}',loader:'js'}));
    }}]}).then(result=>{
      const filename=path.join(WORK,'isolated-runs','runtime-fixture.cjs');
      const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=module.paths;
      loaded._compile(result.outputFiles[0].text,loaded.filename);return loaded.exports;
    });
}
async function fixture(t, options={}) {
  fs.mkdirSync(allowed,{recursive:true});const root=fs.mkdtempSync(path.join(allowed,'m1-runtime-'));
  if(!fs.realpathSync(root).startsWith(fs.realpathSync(allowed)+path.sep))throw Error('Fixture path escaped');
  const db=new Database(path.join(root,'runtime.sqlite'));const api=await runtimeExports();
  db.exec(api.RUNTIME_SCHEMA_SQL);let n=0;
  const service=api.createTaskService(db,{ownerId:'owner-fixture',uuid:()=>`id-${++n}`,now:()=>`2030-01-02T03:04:${String(n%60).padStart(2,'0')}.000Z`,...options});
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,db,api,service};
}
module.exports={fixture,runtimeExports,WORK};
