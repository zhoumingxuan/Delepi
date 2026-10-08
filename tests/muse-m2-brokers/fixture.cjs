'use strict';
// No singleton, app path, provider key or production database is allowed in these fixtures.
const fs=require('node:fs');const path=require('node:path');const https=require('node:https');
const tls=require('node:tls');const Module=require('node:module');const esbuild=require('esbuild');
const Database=require('better-sqlite3');const {createHash}=require('node:crypto');
const WORK=path.resolve(__dirname,'../..');
const FIXTURES=path.join(__dirname,'fixtures');
const SYNTHETIC_PUBLIC_ADDRESS='93.184.216.34';

async function loadSource(entryPoint, options = {}) {
  const filename=path.resolve(WORK,entryPoint);
  if(!filename.startsWith(path.join(WORK,'src')+path.sep))throw Error('Fixture source must stay in repository');
  const result=await esbuild.build({entryPoints:[filename],bundle:true,platform:'node',format:'cjs',write:false,
    external:['better-sqlite3','m2-fixture-hooks'],plugins:[{name:'no-production-singletons',setup(build){
      if(options.fsHooks) {
        build.onResolve({filter:/^node:fs\/promises$/},args=>args.namespace==='fixture'?{path:args.path,external:true}:{path:'synthetic-fs-hooks',namespace:'fixture'});
        build.onLoad({filter:/synthetic-fs-hooks/,namespace:'fixture'},()=>({contents:
          'const fs=require("node:fs/promises"),hooks=require("m2-fixture-hooks"); export const lstat=fs.lstat,mkdir=fs.mkdir,realpath=fs.realpath,copyFile=fs.copyFile,link=fs.link,unlink=fs.unlink,opendir=fs.opendir,readFile=fs.readFile; export async function open(target,...args){const handle=await fs.open(target,...args);const close=handle.close.bind(handle);handle.close=async()=>{await close();await hooks.afterClose?.(target);};return handle;}',loader:'js'}));
      }
      build.onResolve({filter:/sqlite-adapter$/},()=>({path:'forbidden-production-db',namespace:'fixture'}));
      build.onLoad({filter:/forbidden-production-db/,namespace:'fixture'},()=>({contents:'export function getDb(){throw Error("Production database is forbidden in M2 fixture");}',loader:'js'}));
      build.onResolve({filter:/^electron$/},()=>({path:'forbidden-electron-paths',namespace:'fixture'}));
      build.onLoad({filter:/forbidden-electron-paths/,namespace:'fixture'},()=>({contents:'export const app={getPath(){throw Error("Production app paths are forbidden in M2 fixture");}}; export class BrowserWindow{constructor(){throw Error("Production GUI is forbidden in M2 fixture");}} export const shell={openPath(){throw Error("Production file opening is forbidden in M2 fixture");}};',loader:'js'}));
      build.onResolve({filter:/storage-paths$/},()=>({path:'forbidden-storage-paths',namespace:'fixture'}));
      build.onLoad({filter:/forbidden-storage-paths/,namespace:'fixture'},()=>({contents:'export function resolveOutputRootDir(){throw Error("Production output directory is forbidden in M2 fixture");}',loader:'js'}));
    }}]});
  const mod=new Module(path.join(WORK,'isolated-runs','m2-broker-module.cjs'),module);
  mod.filename=path.join(WORK,'isolated-runs','m2-broker-module.cjs');mod.paths=module.paths;
  const nativeRequire=mod.require.bind(mod);mod.require=spec=>spec==='m2-fixture-hooks'?options.fsHooks:nativeRequire(spec);
  mod._compile(result.outputFiles[0].text,mod.filename);return mod.exports;
}

function databaseFixture(t, schemaSql) {
  const allowed=path.join(WORK,'isolated-runs');fs.mkdirSync(allowed,{recursive:true});
  const root=fs.realpathSync(fs.mkdtempSync(path.join(allowed,'m2-brokers-')));
  if(!root.startsWith(fs.realpathSync(allowed)+path.sep))throw Error('M2 fixture path escaped');
  const db=new Database(path.join(root,'synthetic.sqlite'));db.pragma('journal_mode = WAL');
  db.exec(schemaSql);t.after(()=>{if(db.open)db.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,db};
}

function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}

/** A real TLS/HTTP server listening only on loopback. Route functions are entirely synthetic. */
async function tlsFixture(t, routes={}) {
  const cert=fs.readFileSync(path.join(FIXTURES,'synthetic-tls-cert.pem'));
  const key=fs.readFileSync(path.join(FIXTURES,'synthetic-tls-key.pem'));
  const requests=[],connections=[],sockets=new Set();
  const server=https.createServer({key,cert},async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const receipt={method:req.method,path:req.url,headers:{...req.headers},body:Buffer.concat(chunks).toString('utf8')};
    requests.push(receipt);
    const route=routes[new URL(req.url,'https://source.fixture.test').pathname];
    if(!route){res.writeHead(404,{'content-type':'text/plain'});res.end('synthetic route absent');return;}
    try{await route(req,res,receipt);}catch(error){res.destroy(error);}
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  /** Injectable Node request function: asserts that production transport supplied a
   * pinned public lookup, then maps that verified target to this loopback test server.
   * This mapping is fixture-only and is never used by application code. */
  function requestPinned(options,callback) {
    if(typeof options.lookup!=='function')throw Error('Fixture requires an explicit pinned DNS lookup');
    const hostname=String(options.hostname??options.host);
    let resolved;
    options.lookup(hostname,{},(error,addressValue,family)=>{
      if(error)throw error;resolved={address:addressValue,family};
    });
    if(!resolved||resolved.address!==SYNTHETIC_PUBLIC_ADDRESS||resolved.family!==4)
      throw Error('Production lookup did not pin the synthetic public address');
    const connection={hostname,servername:options.servername,resolved,closed:false,...(options.path?{path:options.path}:{})};
    connections.push(connection);
    // The fixture Agent maps only to loopback; it cannot invoke a system DNS lookup.
    const agent=new https.Agent({keepAlive:false});
    agent.createConnection=()=>tls.connect({host:'127.0.0.1',port:address.port,servername:hostname,ca:cert,
      rejectUnauthorized:true});
    const request=https.request({...options,agent,port:address.port},callback);
    request.once('close',()=>{connection.closed=true;agent.destroy();});return request;
  }
  const verifySocket = (socket,pin) => pin.address===SYNTHETIC_PUBLIC_ADDRESS && pin.family===4 && socket.remoteAddress==='127.0.0.1' && socket.remotePort===address.port;
  return {server,requests,connections,requestPinned,verifySocket,cert,port:address.port};
}

const sha=value=>createHash('sha256').update(value).digest('hex');
module.exports={WORK,FIXTURES,SYNTHETIC_PUBLIC_ADDRESS,loadSource,databaseFixture,tlsFixture,deferred,sha};
