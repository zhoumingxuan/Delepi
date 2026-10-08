// Native SQLite uses the application's Electron ABI; synthetic browser tests launch their own isolated child.
const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const tests=fs.readdirSync(path.join(root,'tests'),{withFileTypes:true}).filter(e=>e.isDirectory()&&e.name.startsWith('muse-m2'))
  .flatMap(e=>fs.readdirSync(path.join(root,'tests',e.name)).filter(n=>n.endsWith('.test.cjs')).map(n=>path.join('tests',e.name,n)));
if(!tests.length)throw Error('No M2 tests found');
const result=spawnSync(require('electron'),['--test',...tests],{cwd:root,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'inherit'});
if(result.error)throw result.error;process.exitCode=result.status??1;
