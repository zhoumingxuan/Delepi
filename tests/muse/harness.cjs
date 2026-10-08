 'use strict';
const fs=require('node:fs');const path=require('node:path');const baseAssert=require('node:assert/strict');
const assert=Object.create(baseAssert);assert.deepEqual=(a,b,message)=>baseAssert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)),message); // plain observed payloads cross VM realm, no prototype claim
const {WORK,newRun}=require('./paths.cjs');const {createLoader}=require('./controlled-loader.cjs');
const M='src/main/modules/main-agent/main-agent.ts', E='src/main/modules/executor-agent/executor-agent.ts', S='src/main/modules/executor-agent/executor-task-record-store.ts', P='src/main/modules/executor-agent/executor-structured-payload.ts', L='src/main/modules/executor-agent/executor-execution-log.ts';
const clone=x=>JSON.parse(JSON.stringify(x));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function flush(){for(let i=0;i<8;i++)await Promise.resolve();await new Promise(setImmediate);}
async function until(predicate){const deadline=Date.now()+5000;while(Date.now()<deadline){if(predicate())return;await flush();await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Expected observable not reached within 5 seconds');}
function call(id,args='{}',name='run_shell'){return {id,type:'function',function:{name,arguments:args}};}
function input(name='fixture'){return JSON.stringify({taskname:name,task_type:'编写用例',tasktarget:'controlled fixture only',constraints:[],delivery_type:'权威结论',delivery_spec:'fixture JSON',context:'synthetic; no credentials',skills:[]});}
function final(success=true,extra={}){return '```json\n'+JSON.stringify({success,warnings:[],errors:success?[]:['synthetic failure'],summary_filename:'summary.md',deliverable_filename:'deliverable.json',...extra})+'\n```';}
function stream(calls=[],content='',reasoning=''){return {content,reasoning,toolCalls:calls,assistantMessage:{role:'assistant',content,tool_calls:calls}};}
function harness(t,{mainTurns=[],executorTurns=[],delegate,execute,integrate=false,taskService,artifactReview}={}){
 const root=newRun();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let ms=Date.parse('2030-01-02T03:04:05.000Z');
 class Clock extends Date {constructor(...a){super(...(a.length?a:[ms]));}static now(){return ms;}}
 const events=[],trace=[],rows=[],requests=[],executorRequests=[],delegations=[],executions=[],sessions=[],logs=[],delays=[];
 let uid=0,mi=0,ei=0;const local=p=>path.join(WORK,p); const mocks={};const mock=(p,obj)=>mocks[local(p)]=obj;
 mocks['node:crypto']={randomUUID:require('node:crypto').randomUUID};
 mock('src/main/modules/tasks/task-service.ts',{getTaskService:()=>taskService ?? ({listRuns:()=>[],listAttempts:()=>[],listAttemptWorkspaceReferences:()=>[]})});
 mock('src/main/modules/artifacts/service.ts',{getProtectedTaskPaths:()=>[],markArtifactAttemptReview:id=>artifactReview?.(id)});
 const settings={visionEnabled:false,mainThinkingLevel:'max',executorThinkingLevel:'max',customSkillTags:[]};
 mock('src/main/modules/config/config-manager.ts',{configManager:{getSettings:()=>settings}});
 mock('src/main/modules/llm/model-retry.ts',{isModelApiAbortError:()=>false});
 mock('src/main/modules/event-bus/event-bus.ts',{eventBus:{emit:(name,p)=>{events.push({name,p:clone(p)});trace.push(name);}}});
 // Pure utilities only; target parsing/sanitize/dispatch/normalize/clock/store/exit remain real source.
 const utils={ensureErrorMessage:e=>e instanceof Error?e.message:String(e),normalizeString:x=>typeof x==='string'?x.trim():'',isRecord:x=>!!x&&typeof x==='object'&&!Array.isArray(x)};
 mock('src/main/utils/index.ts',utils);
 mock('src/main/utils/helper.ts',{formatCurrentDateTime:()=>new Clock().toISOString().replace('T',' ').slice(0,19)});
 mock('src/main/modules/executor-agent/executor-system-prompt.ts',{buildExecutorSystemPrompt:()=> 'fixture prompt',buildExecutorUserTaskMessage:x=>typeof x==='string'?x:JSON.stringify(x)});
 mock('src/main/modules/executor-agent/executor-workflow-templates.ts',{EXECUTOR_WORKFLOW_TEMPLATES:{},TASK_TAG_WORKFLOW_TEMPLATE_ID:{},getEnabledCustomSkillTags:()=>[],getCustomSkillsDir:()=>path.join(root,'custom-skills'),getBuiltinOverridesDir:()=>path.join(root,'builtin-skill-overrides'),getCustomSkillTemplatePath:()=>{throw Error('No custom templates permitted');},readBuiltinTemplateContent:async()=>'',readCustomSkillTemplateContent:async()=>''});
 mock('src/main/tools/script-tool-protocol.ts',{scanScriptToolsDir:async()=>[]});
 mock('src/main/modules/llm/constants.ts',{IMAGE_URLS_FIELD_NAME:'image_urls'});
 mock('src/main/utils/file-url.ts',{buildLocalFileUrls:xs=>xs.map(x=>'file://'+x)});
 mock('src/main/utils/storage-output.ts',{copyFileToOutputDir:async(p)=>{if(!p)throw Error('Empty fixture file');assert.ok(p.startsWith(root+path.sep));return p;},copyFilesToOutputDir:async xs=>xs});
 mock('src/main/tools/executor-registry.ts',{getDynamicExecutorToolMeta:()=>null,getExecutorOpenAITools:()=>[],getDefaultEnabledExecutorToolNames:()=>[],executeToolCall:(name,args,id,context)=>{
   executions.push({name,args,id,context});trace.push('execute:'+id);
   return execute?execute({name,args,id,context},h):Promise.resolve({id,result:{success:true,code:'OK',message:'fixture result',data:{}}});
 }});
 mocks.electron={app:{isPackaged:true,getPath:name=>path.join(root,name)}};
 mocks.openai=class NeverNetwork{};mocks.uuid={v4:()=> 'fixture-'+(++uid)};
 mock('src/main/modules/main-agent/prompt.ts',{SYSTEM_PROMPT:'synthetic',MAIN_TOOLS:[]});
 mock('src/main/modules/main-agent/context-compression-task.ts',{getLatestCompletedContextCompression:()=>null,runContextCompressionIfNeeded:async()=>{}});
 mock('src/main/modules/main-agent/title-generation.ts',{generateConversationTitle:async()=>'',truncateConversationTitle:x=>x});
 mock('src/main/modules/main-agent/main-agent-message-content.ts',{buildUserMessageContentParts:({text})=>[{type:'text',text}],buildMainAgentTextContent:x=>x,buildMainAgentUserContent:async({content})=>JSON.stringify(content),isImageContentType:()=>false});
 mock('src/main/utils/chat-content.ts',{contentPartsToText:xs=>xs.map(x=>x.text||'').join('')});
 mock('src/main/utils/storage-paths.ts',{resolveConversationDir:()=>path.join(root,'conversation'),resolveMonthlyOutputDir:()=>path.join(root,'output'),resolveTaskWorkspaceDir:(_c,id)=>path.join(root,'conversation','tasks',id),resolveStoragePath:()=>{throw Error('No uploads in fixture');}});
 function insert(o){const old=rows.findIndex(x=>x.id===o.id);const r={...o,id:o.id||'row-'+(++uid),seq:o.seq??next(),createdAt:o.createdAt||new Clock().toISOString(),payload:clone(o.payload)};if(old>=0)rows[old]=r;else rows.push(r);trace.push('insert:'+o.role);return r;}
 function next(){return Math.max(0,...rows.map(x=>x.seq))+1;}
 mock('src/main/db/index.ts',{getNextMessageSeq:next,insertMessage:insert,insertMessages:({conversationId,messages})=>{trace.push('insertMessages');return messages.map(o=>insert({...o,conversationId}));},listStoredMessages:()=>rows.slice(),getConversationById:()=>({title:'fixture'}),touchConversation:()=>{},updateConversationTitle:()=>{},updateConversationTitleIfUnchanged:()=>false});
 const timers={setTimeout:(fn,delay)=>{delays.push(delay);const token={cancelled:false};queueMicrotask(()=>{if(!token.cancelled)fn();});return token;},clearTimeout:token=>{if(token)token.cancelled=true;}};
 const loader=createLoader({root,mocks,DateClass:Clock,timers});
 const h={root,events,trace,rows,requests,executorRequests,delegations,executions,sessions,logs,delays,loader,clock:{set:x=>ms=typeof x==='string'?Date.parse(x):x,iso:()=>new Clock().toISOString()},model:{baseUrl:'https://invalid.example',apiKey:'synthetic',model:'fixture'}};
 const actualLog=loader.load(L);
 mock(L,{...actualLog,createExecutorExecutionLog:o=>{const log=actualLog.createExecutorExecutionLog(o);logs.push(log);return log;}});
 let active='executor';
 mock('src/main/modules/llm/openai-client.ts',{streamChat:async opts=>{
   const main=active==='main'; const turns=main?mainTurns:executorTurns;const index=main?mi++:ei++; const item=turns[index];
   (main?requests:executorRequests).push(clone(opts.messages));
   if(!item)throw Error('Fixture stream exhausted: '+active+' '+index);
   const value=typeof item==='function'?await item(opts,h):item;return value;
 }});
 // Real CC framing and send lifecycle; only protocol discovery is replaced in
 // these dispatcher fixtures. Discovery has separate real-factory regressions.
 h.adapters=[];
 const actualParser=loader.load(P);
 h.parserCalls=[];
 mock(P,{...actualParser,parseExecutorStructuredPayload:async options=>{
   h.parserCalls.push(clone(options));
   return actualParser.parseExecutorStructuredPayload(options);
 }});
 mock('src/main/modules/llm/adapters/adapter-factory.ts',{
   warnCodingPlanMismatch:()=>false,
   initAdapterWithFallback:async config=>{
     const {ProtocolAdapter}=loader.load('src/main/modules/llm/adapters/protocol-adapter.ts');
     const {ChatCompletionsAdapter}=loader.load('src/main/modules/llm/adapters/chat-completions-adapter.ts');
     const adapter=new ChatCompletionsAdapter();
     const initialized=await ProtocolAdapter.prototype.init.call(adapter,config);
     if(!initialized.success)throw Error(initialized.message);
     h.adapters.push(adapter);
     return {adapter,protocol:'cc'};
   },
 });
 const store=loader.load(S);
 mock(S,{...store,beginExecutorTaskRecord:o=>{const session=store.beginExecutorTaskRecord(o);sessions.push(session);return session;}});
 const executor=loader.load(E);
 if(!integrate)mock(E,{...executor,runDelegatedTask:async opts=>{
   delegations.push({...opts,completedTasks:opts.completedTasks?clone(opts.completedTasks):undefined});trace.push('delegate:'+opts.rawArguments);
   return delegate?delegate(opts,h):{success:true,code:'DELEGATED_TASK_COMPLETED',message:'fixture',data:{}};
 }});
 else mock(E,{...executor,runDelegatedTask:async opts=>{
   fs.mkdirSync(opts.finalOutputDir,{recursive:true});
   fs.writeFileSync(path.join(opts.finalOutputDir,'summary.md'),'fixture summary');
   fs.writeFileSync(path.join(opts.finalOutputDir,'deliverable.json'),'{"fixture":true}');
   delegations.push({...opts,completedTasks:opts.completedTasks?clone(opts.completedTasks):undefined});
   const save=active;active='executor';try{return await executor.runDelegatedTask(opts);}finally{active=save;}
 }});
 const main=loader.load(M);const parser=loader.load(P);
 fs.writeFileSync(path.join(root,'final','summary.md'),'fixture summary');fs.writeFileSync(path.join(root,'final','deliverable.json'),'{"fixture":true}');
 h.runMain=options=>{active='main';return main.runMainAgent({conversationId:'fixture-conv',userMessage:'synthetic only',modelConfig:h.model,visionModelConfig:h.model,assistantConfig:{executorModel:h.model},...options});};
 h.runExecutor=options=>{active='executor';return executor.runDelegatedTask({conversationId:'fixture-conv',rawArguments:input(),assistantConfig:{executorModel:h.model},finalOutputDir:path.join(root,'final'),outputDir:path.join(root,'output'),toolContext:{runDir:root},...options});};
 h.store=store;h.parser=parser;h.session=(id='D')=>{const r=store.beginExecutorTaskRecord({conversationId:'fixture-conv',delegateCallId:id,taskId:'T',messageId:'A',taskName:'fixture'});sessions.push(r);return r;};
 return h;
}
module.exports={harness,deferred,flush,until,call,input,final,stream,clone,assert};
