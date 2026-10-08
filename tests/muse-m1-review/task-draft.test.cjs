'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');const esbuild=require('esbuild');
const WORK=path.resolve(__dirname,'../..');
const antd=`import React from 'react';
export const App={useApp:()=>({message:{info:()=>{}}})};
export const Button=({children,onClick,disabled,...props})=><button aria-label={props['aria-label']} onClick={onClick} disabled={disabled}>{children}</button>;
export const Input={TextArea:({value,onChange,onKeyDown,disabled,placeholder})=><textarea value={value} onChange={onChange} onKeyDown={onKeyDown} disabled={disabled} placeholder={placeholder}/>};
export const Tag=({children})=><span>{children}</span>;
export const Typography={Text:({children})=><span>{children}</span>};
export const theme={useToken:()=>({token:{}})};`;

test('independent real React task drawer review: late send acceptance preserves task identity and newer draft',async t=>{
  const allowed=path.join(WORK,'isolated-runs');fs.mkdirSync(allowed,{recursive:true});const root=fs.mkdtempSync(path.join(allowed,'m1-review-task-draft-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  await esbuild.build({entryPoints:[path.join(__dirname,'task-draft-browser-entry.tsx')],bundle:true,platform:'browser',format:'iife',outfile:path.join(root,'fixture.js'),define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'isolated-presentational-controls',setup(build){
    build.onResolve({filter:/^antd$/},()=>({path:'antd',namespace:'fixture'}));
    build.onResolve({filter:/^@ant-design\/icons$/},()=>({path:'icons',namespace:'fixture'}));
    build.onResolve({filter:/^\.\/RichMarkdown$/},()=>({path:'markdown',namespace:'fixture'}));
    build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='antd'?antd:args.path==='icons'?'export const ArrowUpOutlined=()=>null,CheckCircleFilled=()=>null,CloseCircleFilled=()=>null,CloseOutlined=()=>null,LoadingOutlined=()=>null,ProfileOutlined=()=>null,ToolOutlined=()=>null;':'export const RichMarkdown=()=>null;',loader:'tsx',resolveDir:WORK}));
  }}]});
  fs.writeFileSync(path.join(root,'index.html'),'<!doctype html><html><body><script src="fixture.js"></script></body></html>');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_DISABLE_SANDBOX;
  const result=spawnSync(process.execPath,[path.join(WORK,'tests/muse-m1-ui-config/settings-browser-main.cjs'),root,'__runMuseDrawerScenarios'],{cwd:WORK,env,encoding:'utf8',timeout:30000});
  const reportPath=path.join(root,'results.json');const report=fs.existsSync(reportPath)?JSON.parse(fs.readFileSync(reportPath,'utf8')):{error:result.stderr||String(result.error)};
  assert.equal(result.status,0,report.error);assert.equal(report.ok,true,report.error);assert.equal(report.results.length,2);
});
