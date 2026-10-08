 'use strict';
// No global require hook. Unknown imports fail closed. Only listed real TS modules execute in VM.
const fs=require('node:fs'); const path=require('node:path'); const vm=require('node:vm');
const {WORK,checked,inside}=require('./paths.cjs');
const REAL=[
 'src/main/modules/main-agent/main-agent.ts','src/main/modules/main-agent/running-assistant-message-map.ts',
 'src/main/modules/executor-agent/executor-agent.ts','src/main/modules/executor-agent/executor-task-record-store.ts',
 'src/main/modules/executor-agent/executor-structured-payload.ts','src/main/modules/executor-agent/executor-execution-log.ts',
 'src/main/modules/executor-agent/task-cleanup.ts',
 'src/main/modules/llm/adapters/protocol-adapter.ts',
 'src/main/modules/llm/adapters/chat-completions-adapter.ts',
 'src/main/tools/script-tool-protocol.ts','src/main/tools/script-tool.ts',
 'src/main/modules/executor-agent/runtime-assistant-message.ts','src/main/tools/result.ts',
 ...['index','agent','errors','events','paths','tools'].map(x=>'src/main/constants/'+x+'.ts')
];
function createLoader({root,mocks,DateClass=Date,timers}) {
 checked(root,path.join(WORK,'isolated-runs'));
 const tsDir=checked(path.join(WORK,'node_modules/typescript'));
 const lock=JSON.parse(fs.readFileSync(checked(path.join(WORK,'package-lock.json')),'utf8'));
 const tp=JSON.parse(fs.readFileSync(checked(path.join(tsDir,'package.json')),'utf8'));
 if (lock.packages['node_modules/typescript'].version!=='5.9.3'||tp.version!=='5.9.3') throw Error('Need application-locked TypeScript 5.9.3 in WORK; never global/old dependencies');
 const ts=require(checked(path.join(tsDir,'lib/typescript.js'))); const cache=new Map();
 const guarded={};
 for(const method of ['mkdir','rm','readFile','writeFile','lstat','realpath','readdir']) guarded[method]=async (p,...rest)=>{
   checked(p,root,{missing:method!=='readFile'});
   return require('node:fs/promises')[method](p,...rest);
 };
 const safeProcess=Object.freeze({pid:process.pid,platform:'darwin',arch:'arm64',resourcesPath:root,cwd:()=>root,env:Object.freeze({})});
 const context=vm.createContext({console,JSON,Date:DateClass,Error,SyntaxError,TypeError,DOMException,AbortController,AbortSignal,URL,Buffer,crypto:require('node:crypto').webcrypto,process:safeProcess,
   setTimeout:timers?.setTimeout||setTimeout,clearTimeout:timers?.clearTimeout||clearTimeout,queueMicrotask});
 function canonical(from,spec) {
   if(!spec.startsWith('.')) return spec;
   const p=path.resolve(path.dirname(from),spec);
   if(!inside(WORK,p)) throw Error('Import escape: '+spec);
   for(const suffix of ['.ts','/index.ts','']) { const c=p+suffix; if(REAL.includes(path.relative(WORK,c))||Object.hasOwn(mocks,c)) return c; }
   return p;
 }
 function load(file) {
   file=checked(path.resolve(WORK,file));
   if(cache.has(file))return cache.get(file).exports;
   if(!REAL.includes(path.relative(WORK,file)))throw Error('Real module not allowlisted: '+file);
   const raw=fs.readFileSync(file,'utf8');
   const output=ts.transpileModule(raw,{fileName:file,reportDiagnostics:true,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});
   const errors=(output.diagnostics||[]).filter(x=>x.category===ts.DiagnosticCategory.Error);
   if(errors.length)throw Error(ts.formatDiagnosticsWithColorAndContext(errors,{getCurrentDirectory:()=>WORK,getCanonicalFileName:x=>x,getNewLine:()=> '\n'}));
   const mod={exports:{}};cache.set(file,mod);
   const localRequire=spec=>{
     const key=canonical(file,spec);
     if(Object.hasOwn(mocks,key)) return mocks[key];
     if(spec==='node:path')return path;
     if(spec==='node:fs/promises')return guarded;
     if(REAL.includes(path.relative(WORK,key)))return load(key);
     throw Error('Unmocked import blocked BEFORE loading: '+spec+' from '+file);
   };
   const fn=new vm.Script('(function(require,module,exports,__filename,__dirname){\n'+output.outputText+'\n})',{filename:file}).runInContext(context,{timeout:5000});
   fn(localRequire,mod,mod.exports,file,path.dirname(file)); return mod.exports;
 }
 return {load,ts,cache};
}
module.exports={createLoader,REAL};
