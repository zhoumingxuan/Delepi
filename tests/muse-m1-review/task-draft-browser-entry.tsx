import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ExecutorRecordDrawer } from '../../src/renderer/components/ExecutorRecordDrawer';

function deferred() { let resolve!: (value:any)=>void; const promise=new Promise<any>(yes=>{resolve=yes;}); return {promise,resolve}; }
function check(value:unknown,text:string) { if(!value) throw new Error(text); }
async function until(predicate:()=>boolean) { const start=Date.now();while(!predicate()){if(Date.now()-start>3000)throw new Error('Task draft observation timed out');await new Promise(resolve=>setTimeout(resolve,5));} }
async function flush() { await new Promise(resolve=>setTimeout(resolve,30)); }
const view=(taskId:string,delegateCallId='D')=>({conversationId:'fixture-conv',delegateCallId,taskId,taskName:taskId,status:'running' as const,latestSeq:0,entries:[],createdAt:'2030-01-01T00:00:00.000Z',hasRecords:true});
function typeText(host:HTMLElement,text:string) {
  const input=host.querySelector('textarea')!;
  const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!;
  setter.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));
}
async function mounted() {
  const held:Array<ReturnType<typeof deferred>>=[];let switchView!:(next:ReturnType<typeof view>)=>void;
  function Probe() { const [task,setTask]=useState(view('T1'));switchView=setTask;return <ExecutorRecordDrawer taskView={task} onClose={()=>{}} onSendTaskMessage={()=>{const wait=deferred();held.push(wait);return wait.promise;}}/>; }
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);root.render(<Probe/>);
  await until(()=>!!host.querySelector('textarea'));
  return {host,held,switchView,close:()=>{root.unmount();host.remove();}};
}
async function run() {
  const results:string[]=[];
  {
    const f=await mounted();try {
      typeText(f.host,'old task draft');await flush();f.host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.click();await until(()=>f.held.length===1);
      f.switchView(view('T2'));await flush();
      check(f.host.querySelector('textarea')!.value==='','A new task using the same delegate key must not inherit its predecessor draft');
      typeText(f.host,'new task draft');await flush();f.held[0].resolve({accepted:true});await flush();
      check(f.host.querySelector('textarea')!.value==='new task draft','Late acceptance for prior task must not clear the current task draft');
      results.push('same delegate key with a new task identity keeps draft ownership and fences late acceptance');
    }finally{f.close();}
  }
  {
    const f=await mounted();try {
      typeText(f.host,'first sent draft');await flush();f.host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.click();await until(()=>f.held.length===1);
      typeText(f.host,'newer edited draft');await flush();f.held[0].resolve({accepted:true});await flush();
      check(f.host.querySelector('textarea')!.value==='newer edited draft','Late acceptance must not erase edits typed after the send');
      results.push('late acceptance preserves newer edits in the same task');
    }finally{f.close();}
  }
  return results;
}
(window as any).__runMuseDrawerScenarios=run;
