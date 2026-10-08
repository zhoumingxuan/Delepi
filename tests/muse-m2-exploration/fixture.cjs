'use strict';
const path=require('node:path');
const { loadSource,databaseFixture,tlsFixture,SYNTHETIC_PUBLIC_ADDRESS }=require('../muse-m2-brokers/fixture.cjs');
let source;
async function sourceApi(){return source??=Promise.all([
  'src/main/db/migrations/runtime-schema.ts','src/main/db/migrations/autonomy-schema.ts','src/main/db/migrations/broker-storage-schema.ts',
  'src/main/db/migrations/public-inbox-schema.ts','src/main/modules/tasks/task-service.ts','src/main/modules/goals/goal-service.ts',
  'src/main/modules/permissions/authority.ts','src/main/modules/budget/ledger.ts','src/main/modules/budget/contracts.ts',
  'src/main/modules/brokers/index.ts','src/main/modules/exploration/public-inbox.ts','src/main/modules/exploration/exploration-service.ts',
  'src/main/modules/artifacts/artifact-schema.ts',
].map(loadSource)).then(parts=>Object.assign({},...parts));}
async function fixture(t,extras={}){
  const api=await sourceApi();let cleanDb;
  const {db,root}=databaseFixture({after(fn){cleanDb=fn;}},'CREATE TABLE settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);'+
    api.RUNTIME_SCHEMA_SQL+api.ARTIFACT_SCHEMA_SQL+api.AUTONOMY_SCHEMA_SQL+api.BROKER_STORAGE_SCHEMA_SQL+api.PUBLIC_INBOX_SCHEMA_SQL);
  const server=await tlsFixture(t,extras.routes??{
    '/public':(_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<p>Public synthetic source.</p>');},
    '/second':(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('Second public source.');},
    '/v1/chat/completions':(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'Synthetic CC research report.'}}],usage:{prompt_tokens:10,completion_tokens:20}}));},
    '/v1/responses':(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'Synthetic Responses report.'}]}],usage:{input_tokens:12,output_tokens:30}}));},
  });
  let n=0;const uuid=()=>`exploration-fixture-${++n}`;
  const tasks=api.createTaskService(db,{ownerId:'exploration-fixture-owner',uuid});
  let exploration,authority;
  const settings={mainModelBaseUrl:'https://model.example.com/v1',mainModelName:'synthetic-public-model',mainModelApiKey:'synthetic-key-not-a-real-provider'};
  const goals=api.createGoalService(db,{taskService:tasks,uuid,config:{getSettings:()=>settings},onScopeChanged(goalId){authority?.cancelGoalOperations(goalId);exploration?.cancelGoal(goalId);}});
  const destination=goals.listDestinations()[0];
  const draft={title:'Public fixture study',topic:'Only public synthetic sources',sourceUrls:extras.urls??['https://source.example.com/public'],destinationId:destination.id,
    expectedOutput:'A Chinese report',stopConditions:'One pass',limits:{...api.DEFAULT_EXPLORATION_LIMITS,...extras.limits}};
  const goal=goals.create(draft);
  const ledger=api.createBudgetLedger(db,{caps:api.DEFAULT_PUBLIC_BUDGET_CAPS});
  authority=api.createPermissionAuthority(db,{taskService:tasks,budget:ledger,resolveDestination:goals.resolveDestination,uuid});
  const file=api.createFileBroker(db,{publicRoot:path.join(root,'public-snapshots'),uuid});
  const artifact=api.createArtifactBroker(db,{artifactRoot:path.join(root,'public-artifacts'),uuid});
  const transport=api.createPinnedTransport({resolve:async()=>[{address:SYNTHETIC_PUBLIC_ADDRESS,family:4}],request:server.requestPinned,verifySocket:server.verifySocket});
  const fetch=api.createFetchBroker(db,{transport,registerSnapshot:file.registerSnapshot});
  const inbox=api.createPublicInbox(db,{taskService:tasks,goalService:goals,canAppend:ctx=>exploration.canAppend(ctx),isAtSafePoint:ctx=>exploration.isAtSafePoint(ctx)});
  const model=api.createModelBroker(db,{transport,resolveDestination:goals.resolveDestination,verifyDocument:file.verifyDocument,
    verifyAddition(session,addition){if(!inbox.verifyAddition(addition,session.context,goal.destinationId))throw new api.BrokerError('PUBLIC_ADDITION_NOT_MINTED');},...extras.model});
  exploration=api.createExplorationService(extras.serviceDatabase?.(db)??db,{taskService:tasks,goals,authority,fetchBroker:fetch,fileBroker:file,modelBroker:model,artifactBroker:artifact,publicInbox:inbox,uuid,...extras.service});
  const state={api,db,root,server,tasks,settings,goals,goal,draft,destination,ledger,authority,file,artifact,fetch,model,inbox,exploration};
  t.after(async()=>{await exploration.dispose();authority.dispose();cleanDb();});
  state.plan=(protocol='chat-completions',caller=1)=>exploration.planExploration(goal.id,goal.revision,protocol,caller);
  state.start=plan=>exploration.startExploration(plan.id,plan.revision,1);
  state.approveAll=()=>{const timer=setInterval(()=>{for(const card of authority.listApprovals())if(card.state==='pending')authority.decideApproval(card.id,card.revision,'run',1);},2);return()=>clearInterval(timer);};
  return state;
}
async function until(predicate,timeout=2000){const end=Date.now()+timeout;for(;;){const value=predicate();if(value)return value;if(Date.now()>=end)throw Error('synthetic condition timeout');await new Promise(resolve=>setTimeout(resolve,2));}}
module.exports={fixture,sourceApi,until};
