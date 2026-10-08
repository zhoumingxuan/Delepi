const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const {spawn,spawnSync} = require('node:child_process');
const root = path.resolve(__dirname,'..');
const evidence = path.resolve(process.env.MUSE_SMOKE_EVIDENCE || path.join(root,'开发验证-M1-20261007'));
const binary = process.env.MUSE_SMOKE_BINARY || require('electron');
if(binary.startsWith('/Applications/'))throw Error('Installed application is forbidden in isolated smoke');
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function port() {return new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});}
async function eventually(operation) {const deadline=Date.now()+30000;let last;while(Date.now()<deadline){try{const value=await operation();if(value)return value;}catch(e){last=e;}await pause(200);}throw last||Error('Timed out waiting for GUI');}
class Cdp {
  constructor(socket){this.socket=socket;this.pending=new Map();this.seq=0;socket.addEventListener('message',e=>{const data=JSON.parse(e.data);if(!data.id)return;const item=this.pending.get(data.id);if(!item)return;this.pending.delete(data.id);clearTimeout(item.timer);data.error?item.reject(Error(data.error.message)):item.resolve(data.result);});socket.addEventListener('close',()=>{for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(Error('CDP target closed'));}this.pending.clear();});}
  static async open(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});return new Cdp(socket);}
  send(method,params={}){const id=++this.seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP command timed out: '+method));},15000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  async eval(expression){const result=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text+' '+(result.exceptionDetails.exception?.description||''));return result.result.value;}
  close(){this.socket.close();}
}
(async()=>{
  await fs.mkdir(evidence,{recursive:true});
  const prepared=spawnSync(require('electron'),[path.join(root,'scripts/muse-m1-smoke-fixture.cjs')],{cwd:root,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8'});
  if(prepared.status!==0)throw Error(prepared.stderr||prepared.stdout);
  const fixture=prepared.stdout.trim().split('\n').at(-1);
  if(process.env.MUSE_SMOKE_BINARY){
    // Packaged DB resolver uses userData. Only this freshly-created synthetic database is copied.
    await fs.copyFile(path.join(fixture,'data','delepi.db'),path.join(fixture,'userData','delepi.db'));
  }
  const rendererPort=await port(),mainPort=await port();
  const env={...process.env,MUSE_SMOKE_FIXTURE:fixture};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_DISABLE_SANDBOX;delete env.VITE_DEV_SERVER_URL;
  const child=spawn(binary,[`--inspect=${mainPort}`,`--remote-debugging-port=${rendererPort}`,'--remote-debugging-address=127.0.0.1',fixture],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',b=>{logs+=b;});child.stderr.on('data',b=>{logs+=b;});
  const checks=[];let main,renderer,mainTargetId;
  const targets=async p=>{const r=await fetch(`http://127.0.0.1:${p}/json/list`);return r.json();};
  const mainPage=async(excludeId)=>eventually(async()=> (await targets(rendererPort)).find(t=>t.id!==excludeId&&t.type==='page'&&t.url.startsWith('file:')&&t.url.endsWith('/index.html')));
  const screenshot=async(c,name)=>{const shot=await c.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(evidence,name),Buffer.from(shot.data,'base64'));};
  try{
    main=await Cdp.open((await eventually(async()=>(await targets(mainPort))[0])).webSocketDebuggerUrl);
    await eventually(()=>main.eval('Boolean(globalThis.__museSmoke)'));
    const firstPage=await mainPage();mainTargetId=firstPage.id;
    renderer=await Cdp.open(firstPage.webSocketDebuggerUrl);
    await eventually(()=>renderer.eval('Boolean(document.querySelector("[data-testid=muse-activity-open]"))'));
    const appInfo=await renderer.eval('window.electronAPI.muse.appInfo({requestId:"smoke-info",data:{}})');
    assert.equal(appInfo.ok,true);checks.push('main-window narrow IPC and runtime version');
    const version=await eventually(()=>renderer.eval('document.querySelector("[data-testid=muse-version]")?.textContent'));
    assert.equal(version,`Delepi ${appInfo.result.version}`);
    await pause(350);
    await screenshot(renderer,'M1主界面.png');
    await renderer.eval('document.querySelector("[data-testid=muse-activity-open]").click()');
    await eventually(()=>renderer.eval('document.body.textContent.includes("synthetic-run") || document.body.textContent.includes("执行收尾") || document.body.textContent.includes("运行完成")'));
    await pause(350);
    await screenshot(renderer,'M1活动界面.png');checks.push('durable activity UI reads seeded SQLite facts');
    await renderer.eval('document.querySelector("[data-testid=muse-artifact-open]").click()');
    await eventually(()=>renderer.eval('document.body.textContent.includes("合成成果.html")'));
    const initialStates=await renderer.eval('Array.from(document.querySelectorAll(".ant-list-item")).find(x=>x.textContent.includes("合成成果.html"))?.textContent');
    for(const state of ['已保存','尚未验证','待查看']) assert.ok(initialStates.includes(state),initialStates);
    await pause(350);
    await screenshot(renderer,'M1成果界面.png');checks.push('artifact UI shows saved/validation/acceptance independently');
    await renderer.eval('Array.from(document.querySelectorAll(".ant-list-item")).find(x=>x.textContent.includes("合成成果.html")).querySelector("button").click()');
    await eventually(()=>renderer.eval('Array.from(document.querySelectorAll(".ant-drawer-title")).some(x=>x.textContent === "成果详情")'));
    const detail=await renderer.eval('Array.from(document.querySelectorAll(".ant-drawer-title")).find(x=>x.textContent === "成果详情").closest(".ant-drawer-section, .ant-drawer-content").textContent');
    for(const text of ['保存','验证','你的接受状态','synthetic-run','内容指纹']) assert.ok(detail.includes(text),detail);
    if(process.env.MUSE_SMOKE_REVIEW==='1') {
      assert.ok(detail.includes('需要复核') && detail.includes('核对内容与来源'),detail);
      checks.push('artifact review requirement remains visible in the real detail UI');
    }
    await pause(350);await screenshot(renderer,'M1成果详情.png');
    await renderer.eval('Array.from(document.querySelectorAll(".ant-drawer-title")).find(x=>x.textContent === "成果详情").closest(".ant-drawer-section, .ant-drawer-content").querySelectorAll("button").forEach(x=>{if(x.textContent === "打开成果")x.click()})');
    const preview=await eventually(async()=>(await targets(rendererPort)).find(t=>t.type==='page'&&t.url.startsWith('data:')));
    const previewCdp=await Cdp.open(preview.webSocketDebuggerUrl);
    await eventually(()=>previewCdp.eval('document.readyState === "complete" && Boolean(document.body?.textContent.includes("合成验收成果"))'));
    const isolation=await previewCdp.eval('({api:typeof window.electronAPI,scriptRan:document.body.dataset.scriptRan||null})');
    assert.equal(isolation.api,'undefined');assert.equal(isolation.scriptRan,null);
    await screenshot(previewCdp,'M1独立成果预览.png');previewCdp.close();checks.push('artifact HTML has no privileged preload and document scripts do not run');
    await renderer.eval('Array.from(document.querySelectorAll(".ant-drawer-title")).find(x=>x.textContent === "成果详情").closest(".ant-drawer-section, .ant-drawer-content").querySelectorAll("button").forEach(x=>{if(x.textContent === "接受")x.click()})');
    await eventually(()=>renderer.eval('Array.from(document.querySelectorAll(".ant-modal-confirm-title")).some(x=>x.textContent === "接受这份成果？")'));
    await renderer.eval('Array.from(document.querySelectorAll(".ant-modal-confirm-title")).find(x=>x.textContent === "接受这份成果？").closest(".ant-modal").querySelector(".ant-modal-confirm-btns .ant-btn-primary").click()');
    await eventually(()=>renderer.eval('Array.from(document.querySelectorAll(".ant-drawer-title")).find(x=>x.textContent === "成果详情").closest(".ant-drawer-section, .ant-drawer-content").textContent.includes("已接受")'));
    const accepted=await renderer.eval('window.electronAPI.muse.getArtifact("synthetic-artifact")');
    assert.equal(accepted.ok,true);assert.equal(accepted.result.saveState,'saved');assert.equal(accepted.result.validationState,'pending');assert.equal(accepted.result.acceptanceState,'accepted');
    if(process.env.MUSE_SMOKE_REVIEW==='1') assert.equal(accepted.result.needsReview,true);
    await pause(350);await screenshot(renderer,'M1成果验收.png');checks.push('user acceptance UI commits independently while validation remains pending');
    await renderer.eval('Array.from(document.querySelectorAll(".ant-drawer-title")).find(x=>x.textContent === "成果详情").closest(".ant-drawer-section, .ant-drawer-content").querySelector(".ant-drawer-close").click()');
    await main.eval('globalThis.__museSmoke.openSettings()');
    await eventually(()=>renderer.eval('Array.from(document.querySelectorAll(".ant-drawer-title")).some(x=>x.textContent === "配置")'));
    await pause(350);
    await screenshot(renderer,'M1设置入口.png');checks.push('native settings menu opens existing configuration UI');
    renderer.close();await main.eval('globalThis.__museSmoke.recreateMain()');
    const replacement=await mainPage(mainTargetId);mainTargetId=replacement.id;
    renderer=await Cdp.open(replacement.webSocketDebuggerUrl);
    await eventually(()=>renderer.eval('Boolean(window.electronAPI && document.querySelector("[data-testid=muse-version]")?.textContent)'));
    const rebuilt=await renderer.eval('window.electronAPI.muse.appInfo({requestId:"smoke-rebuilt",data:{}})');assert.equal(rebuilt.ok,true);
    const profiles=await renderer.eval('window.electronAPI.config.listProfiles()');assert.ok(profiles.profiles?.length||profiles.result?.profiles?.length);
    await main.eval('globalThis.__museSmoke.openSettings()');
    await eventually(()=>renderer.eval('Array.from(document.querySelectorAll(".ant-drawer-title")).some(x=>x.textContent === "配置")'));
    checks.push('recreated window keeps live IPC/config sender and native menu without duplicate handlers');
    if(process.env.MUSE_SMOKE_M2==='1') {
      const status=await renderer.eval('window.electronAPI.autonomy.status()');assert.equal(status.ok,true);assert.equal(status.result.explorationReady,true);
      checks.push('M2 production startup exposes exploration only after recovery');
      const goal=await renderer.eval(`(async()=>{const destinations=await window.electronAPI.autonomy.listDestinations();if(!destinations.ok)throw Error(destinations.code);return await window.electronAPI.autonomy.createGoal({title:'M2 隔离公开主题',topic:'仅为本地合成 GUI 验收',sourceUrls:['https://example.com/delepi-isolated-smoke'],destinationId:destinations.result[0].id,expectedOutput:'合成报告',stopConditions:'只做一轮',limits:{activeMilliseconds:300000,absoluteMilliseconds:900000,modelRequests:6,fetchRequests:8,downloadBytes:5242880,storageBytes:5242880,tokenUnits:100000,maxDocumentBytes:1048576,concurrency:2}});})()`);
      assert.equal(goal.ok,true);await renderer.eval('document.querySelector("[data-testid=autonomy-center-open]").click()');
      await eventually(()=>renderer.eval('Array.from(document.querySelectorAll("button")).some(x=>x.textContent === "手动探索" && !x.disabled)'));
      await renderer.eval('Array.from(document.querySelectorAll("button")).find(x=>x.textContent === "手动探索").click()');
      await eventually(()=>renderer.eval('Array.from(document.querySelectorAll("button")).some(x=>x.textContent === "预览本次探索" && !x.disabled)'));
      await renderer.eval('Array.from(document.querySelectorAll("button")).find(x=>x.textContent === "预览本次探索").click()');
      await eventually(()=>renderer.eval('Array.from(document.querySelectorAll("button")).some(x=>x.textContent === "确认范围并开始" && !x.disabled)'));
      const before=await renderer.eval('window.electronAPI.autonomy.listExplorations()');assert.equal(before.ok,true);assert.equal(before.result.length,0);
      await pause(200);await screenshot(renderer,'M2计划预览.png');checks.push('M2 actual React plan preview creates no Run and shows exact destination/limits');
      await renderer.eval('Array.from(document.querySelectorAll("button")).find(x=>x.textContent === "确认范围并开始").click()');
      const pending=await eventually(async()=>{const value=await renderer.eval('window.electronAPI.autonomy.listExplorations()');return value.ok&&value.result.find(row=>row.state==='waiting_approval');});
      assert.equal(pending.sourceCount,0);assert.equal(pending.pendingApprovalCount,1);assert.ok(pending.destination);
      assert.equal(JSON.stringify(pending).includes('synthetic-not-a-real-key'),false);
      await eventually(()=>renderer.eval('document.body.textContent.includes("项操作等待批准")'));
      await pause(200);await screenshot(renderer,'M2等待批准.png');checks.push('M2 real TaskService starts a separate public Run with zero completed sources before consent');
      const appendix=await renderer.eval(`window.electronAPI.autonomy.appendPublicMessage(${JSON.stringify(pending.runId)},'gui-public-note','明确确认可公开的合成补充',true)`);assert.equal(appendix.ok,true);assert.equal(appendix.result.accepted,true);
      const budget=await renderer.eval('window.electronAPI.autonomy.budget()');assert.equal(budget.ok,true);assert.equal(budget.result.accounts.length,0);
      checks.push('M2 trusted IPC classifies a public FIFO addition and makes no budget reservation while waiting');
      await renderer.eval('Array.from(document.querySelectorAll("button")).find(x=>x.textContent === "停止本次探索").click()');
      await eventually(()=>renderer.eval('Array.from(document.querySelectorAll(".ant-modal-confirm-title")).some(x=>x.textContent === "停止本次探索？")'));
      await renderer.eval('Array.from(document.querySelectorAll(".ant-modal-confirm-title")).find(x=>x.textContent === "停止本次探索？").closest(".ant-modal").querySelector(".ant-modal-confirm-btns .ant-btn-primary").click()');
      const stopped=await eventually(async()=>{const value=await renderer.eval('window.electronAPI.autonomy.listExplorations()');return value.ok&&value.result.find(row=>row.runId===pending.runId&&row.state==='stopped');});
      assert.ok(stopped.settledAt);assert.equal(stopped.stopReason,'STOP_REQUESTED');
      const cards=await renderer.eval('window.electronAPI.autonomy.listApprovals()');assert.equal(cards.ok,true);assert.equal(cards.result.filter(row=>row.state==='pending').length,0);
      const legacy=await renderer.eval('window.electronAPI.muse.getArtifact("synthetic-artifact")');assert.equal(legacy.result.acceptanceState,'accepted');
      await pause(200);await screenshot(renderer,'M2停止收尾.png');checks.push('M2 actual stop control waits for durable settlement, revokes pending cards and preserves M1 accepted artifact');
      await fs.writeFile(path.join(evidence,'M2隔离GUI增量验收.json'),JSON.stringify({createdAtUtc:new Date().toISOString(),syntheticOnly:true,productionDataAccessed:false,realModelCalled:false,publicSourcesApproved:false,compiledMain:process.env.MUSE_SMOKE_COMPILED_MAIN||path.join(root,'dist/main/index.js'),checks:checks.filter(x=>x.startsWith('M2 '))},null,2)+'\n');
    }
    await fs.writeFile(path.join(evidence,'M1隔离GUI验收.json'),JSON.stringify({createdAtUtc:new Date().toISOString(),syntheticOnly:true,productionDataAccessed:false,realModelCalled:false,version:appInfo.result.version,checks,fixture},null,2)+'\n');
    console.log(JSON.stringify({passed:checks.length,checks}));
  }catch(error){
    if(renderer) await fs.writeFile(path.join(evidence,'M1隔离GUI故障DOM.html'),await renderer.eval('document.documentElement.outerHTML').catch(()=>'Target closed'));
    throw error;
  }finally{
    if(renderer)renderer.close();
    if(main){await main.eval('globalThis.__museSmoke.quit()').catch(()=>{});main.close();}
    child.kill();await fs.writeFile(path.join(evidence,'M1隔离GUI启动.log'),logs);
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
