'use strict';
const fs=require('node:fs');const path=require('node:path');const {app,BrowserWindow,ipcMain}=require('electron');
const {fixture,WORK}=require('./fixture.cjs');const {harness,deferred}=require('../muse/harness.cjs');
const fixtureRoot=path.resolve(process.argv[2]);const allowed=path.join(WORK,'isolated-runs');
if(!fs.realpathSync(fixtureRoot).startsWith(fs.realpathSync(allowed)+path.sep))throw Error('Hook fixture escaped');
app.setName('Delepi Task Hook Fixture');app.setPath('userData',fixtureRoot);app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const cleanup=[];const t={after:fn=>cleanup.push(fn)};let window;
  try {
    const {service,db}=await fixture(t);const root=service.beginRun('fixture-conv');
    const h=harness(t,{taskService:service});let child,session,controller,taskNumber=0;
    const sends=[],gets=[];let sendMode='normal',sendPending,getPending,holdNextGet=false;
    const signal=()=>({conversationId:'fixture-conv',delegateCallId:'D',taskId:child.taskId,latestSeq:session.latestSeq,status:session.status,updatedAt:h.clock.iso()});
    const emit=()=>window.webContents.send('executor:record-signal',signal());
    function nextTask() {
      child=service.beginAttempt(root,{taskId:'T'+(++taskNumber),delegateCallId:'D'});
      session=h.store.beginExecutorTaskRecord({taskContext:child,conversationId:'fixture-conv',delegateCallId:'D',taskId:child.taskId,messageId:'A'+taskNumber,taskName:'synthetic task '+taskNumber});
      session.adoptMessages([{role:'system',content:'synthetic only'}]);controller=new AbortController();
      h.store.registerTaskStopController('fixture-conv','D',controller);h.clock.set(Date.parse('2030-01-02T03:04:05Z')+taskNumber*1000);
    }
    function snapshot() {return {inbox:service.listInbox({runId:root.runId}),sends,gets,modelMessages:session.modelMessages,status:session.status,attempt:service.listAttempts(root.runId).find(row=>row.id===child.attemptId)};}
    ipcMain.handle('executor:get-task-record',async(_event,params)=>{
      gets.push({...params});const result=h.store.queryExecutorTaskRecord(params);
      if(holdNextGet){holdNextGet=false;getPending={...deferred(),result};return getPending.promise;}
      return result;
    });
    ipcMain.handle('executor:send-task-message',async(_event,params)=>{
      sends.push({...params});const result=h.store.sendTaskUserMessage(params.conversationId,params.delegateCallId,params.message,params.messageId);emit();
      const mode=sendMode;sendMode='normal';
      if(mode==='lost')throw Error('Synthetic receipt lost after durable admission');
      if(mode==='hold'){sendPending={...deferred(),result};return sendPending.promise;}
      return result;
    });
    ipcMain.handle('executor:stop-task',(_event,params)=>h.store.stopExecutorTask(params.conversationId,params.delegateCallId));
    ipcMain.handle('fixture:runtime-step',async(_event,params)=>{
      switch(params.action) {
        case 'init':nextTask();emit();return snapshot();
        case 'snapshot':return snapshot();
        case 'send-mode':sendMode=params.mode;return true;
        case 'release-send':if(!sendPending)throw Error('No held send');sendPending.resolve(sendPending.result);sendPending=undefined;return true;
        case 'inject':{const count=session.consumePendingUserMessages();emit();return {count,...snapshot()};}
        case 'inject-fault':{
          db.exec("CREATE TRIGGER fail_injected BEFORE UPDATE ON run_inbox WHEN NEW.state='injected' BEGIN SELECT RAISE(ABORT,'synthetic receipt persistence failure'); END;");
          try{session.consumePendingUserMessages();throw Error('Expected confirmation fault');}catch(error){if(!/synthetic receipt persistence failure/.test(error.message))throw error;}finally{db.exec('DROP TRIGGER fail_injected');}
          emit();return snapshot();
        }
        case 'stop':h.store.stopExecutorTask('fixture-conv','D');window.webContents.send('chat:aborted',{conversationId:'fixture-conv'});return snapshot();
        case 'begin-tool':session.beginToolCall({callId:'still-executing',name:'synthetic-tool',args:'{}'});emit();return snapshot();
        case 'settle':session.markTerminal('aborted');service.settleAttempt(child,'cancelled');h.store.unregisterTaskStopController('fixture-conv','D',controller);emit();return snapshot();
        case 'hold-get':holdNextGet=true;return true;
        case 'has-held-get':return !!getPending;
        case 'next-task':nextTask();emit();return snapshot();
        case 'release-get':if(!getPending)throw Error('No held GET');getPending.resolve(getPending.result);getPending=undefined;return true;
        case 'old-signal':window.webContents.send('executor:record-signal',{...signal(),taskId:'T1',latestSeq:999,updatedAt:'2030-01-02T03:04:05.000Z'});return true;
        default:throw Error('Unknown fixture action');
      }
    });
    window=new BrowserWindow({show:false,webPreferences:{preload:path.join(fixtureRoot,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
    await window.loadFile(path.join(fixtureRoot,'index.html'));
    const results=await window.webContents.executeJavaScript('window.__runRuntimeHookScenarios()');
    fs.writeFileSync(path.join(fixtureRoot,'results.json'),JSON.stringify({ok:true,results}));
    window.destroy();for(const fn of cleanup.reverse())fn();app.exit(0);
  }catch(error){fs.writeFileSync(path.join(fixtureRoot,'results.json'),JSON.stringify({ok:false,error:error.stack||String(error)}));window?.destroy();for(const fn of cleanup.reverse())fn();app.exit(1);}
});
