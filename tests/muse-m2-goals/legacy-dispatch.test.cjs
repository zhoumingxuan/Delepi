'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const esbuild=require('esbuild');const Module=require('node:module');const path=require('node:path');
const root=path.resolve(__dirname,'../..');
async function fixture(){
  const result=await esbuild.build({stdin:{contents:'export * from "./src/main/tools/executor-registry";export * from "./src/main/modules/permissions/legacy-admission";',resolveDir:root},
    bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'dispatch-fixture',setup(build){
      build.onResolve({filter:/executor-agent\/prompt$/},()=>({path:'tools',namespace:'fixture'}));
      build.onResolve({filter:/config-manager$/},()=>({path:'config',namespace:'fixture'}));
      build.onResolve({filter:/utils\/index$/},()=>({path:'utils',namespace:'fixture'}));
      build.onResolve({filter:/^\.\/result$/},()=>({path:'result',namespace:'fixture'}));
      build.onLoad({filter:/.*/,namespace:'fixture'},({path:p})=>({loader:'js',contents:p==='tools'?`export const EXECUTOR_TOOLS=Object.fromEntries(['run_shell','run_with_python','use_script_tool','inspect_media'].map(name=>[name,{config:{name},parameters:{},execute(input){globalThis.__m2Dispatches.push(name);return {success:true,input};}}]));`:p==='config'?'export const configManager={getSettings:()=>({visionEnabled:true})};':p==='result'?'export const buildSimpleToolResult=(result,id)=>({id,result});':'export const ensureErrorMessage=e=>e.message;'}));
    }}]});
  const filename=path.join(root,'isolated-runs','dispatch.cjs');const mod=new Module(filename,module);mod.filename=filename;mod.paths=module.paths;mod._compile(result.outputFiles[0].text,filename);return mod.exports;
}
test('actual legacy dispatch obeys runtime deny, public fence and cancellation before executing synthetic tool',async()=>{
  const api=await fixture();globalThis.__m2Dispatches=[];let denied=[];
  api.setLegacyPolicyReader(()=>({revision:1,deniedCapabilities:[],deniedLegacyTools:denied,warnings:[]}));
  await api.executeToolCall('run_shell','{}','first');assert.deepEqual(globalThis.__m2Dispatches,['run_shell']);
  denied=['shell'];assert.equal((await api.executeToolCall('run_shell','{}','second')).result.success,false);
  await api.executeToolCall('run_with_python','{}','third');assert.deepEqual(globalThis.__m2Dispatches,['run_shell','run_with_python']);
  denied=['localFiles'];for(const name of ['run_shell','run_with_python','use_script_tool','inspect_media'])assert.equal((await api.executeToolCall(name,'{}','blocked')).result.success,false);
  denied=[];assert.equal((await api.executeToolCall('run_shell','{"context":{"executionMode":"trusted"}}','public',{executionMode:'public'})).result.success,false);
  const controller=new AbortController();controller.abort();assert.equal((await api.executeToolCall('run_shell','{}','cancelled',{signal:controller.signal})).result.success,false);
  assert.equal(globalThis.__m2Dispatches.length,2);
  api.setLegacyPolicyReader(()=>{throw Error('synthetic storage failure')});assert.equal((await api.executeToolCall('run_shell','{}','failed')).result.success,false);
  delete globalThis.__m2Dispatches;
});
