'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');const esbuild=require('esbuild');
const {WORK}=require('./fixture.cjs');

test('real React hook and production preload keep message IDs stable across lost receipts and trust only actual task settlement',async t=>{
  const allowed=path.join(WORK,'isolated-runs');fs.mkdirSync(allowed,{recursive:true});
  const root=fs.mkdtempSync(path.join(allowed,'m1-runtime-hook-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  await Promise.all([
    esbuild.build({entryPoints:[path.join(__dirname,'hook-browser-entry.tsx')],bundle:true,platform:'browser',format:'iife',outfile:path.join(root,'fixture.js'),define:{'process.env.NODE_ENV':'"production"'}}),
    esbuild.build({entryPoints:[path.join(WORK,'src/preload/preload.ts')],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:path.join(root,'production-preload.cjs')})
  ]);
  fs.writeFileSync(path.join(root,'preload.cjs'),'require("./production-preload.cjs"); const {contextBridge,ipcRenderer}=require("electron"); contextBridge.exposeInMainWorld("runtimeFixture",{step:params=>ipcRenderer.invoke("fixture:runtime-step",params)});');
  fs.writeFileSync(path.join(root,'index.html'),'<!doctype html><html><body><script src="fixture.js"></script></body></html>');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_DISABLE_SANDBOX;
  const result=spawnSync(process.execPath,[path.join(__dirname,'hook-browser-main.cjs'),root],{cwd:WORK,env,encoding:'utf8',timeout:30000});
  const reportPath=path.join(root,'results.json');const report=fs.existsSync(reportPath)?JSON.parse(fs.readFileSync(reportPath,'utf8')):{error:result.stderr||String(result.error)};
  assert.equal(result.status,0,report.error);assert.equal(report.ok,true,report.error);assert.equal(report.results.length,7);
});
