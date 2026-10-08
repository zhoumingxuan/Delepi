import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ExplorationPlan, ExplorationSession, PublicGoal, PublicResource } from '@shared/types/autonomy';
import type { TaskService } from '../tasks/task-service';
import type { TaskRunContext, TerminalTaskState } from '../tasks/types';
import type { GoalService } from '../goals/goal-service';
import { appendAutonomyAudit, AutonomyError, getPublicRunBinding, hashValue } from '../goals/autonomy-store';
import type { PermissionAuthority } from '../permissions/authority';
import { permissionId, permissionInteger } from '../permissions/permission-validation';
import { createBrokerConcurrency } from '../brokers/concurrency';
import { createBrokerSession } from '../brokers/session';
import type { BrokerSession, PublicDocument } from '../brokers/contracts';
import type { createFetchBroker } from '../brokers/fetch-broker';
import type { FileBroker } from '../brokers/file-broker';
import type { createModelBroker } from '../brokers/model-broker';
import type { ArtifactBroker } from '../brokers/artifact-broker';
import { createRunClock, type RunClock } from '../budget/run-clock';
import type { createPublicInbox } from './public-inbox';

interface PlanSnapshot {
  goal: PublicGoal; resources: PublicResource[];
  destination: ExplorationPlan['destination'] & { configHash: string };
  protocol: ExplorationPlan['protocol']; policyRevision: number;
}
interface PlanRow { id:string; goal_id:string; goal_revision:number; caller_id:number; snapshot_json:string; revision:number; state:string; expires_at:string; created_at:string }
interface SessionRow { id:string; plan_id:string; goal_id:string; run_id:string; state:string; stop_reason:string|null; source_count:number; artifact_id:string|null; created_at:string; settled_at:string|null }
interface SessionProjectionRow extends SessionRow { snapshot_json:string|null; pending_count:number }
interface ActiveRun {
  context:TaskRunContext; goalId:string; goalRevision:number; destinationRef:string; callerId:number;
  controller:AbortController; clock:RunClock; sessions:Set<BrokerSession>; promise:Promise<void>;
  phase:'fetching'|'reading'|'summarizing'|'publishing'|'settling'; sourceCount:number; sourceTotal:number;
  additionCount:number; modelStarted:boolean; stopReason?:string; persistenceFailed:boolean;
}
const stopCodes = new Set(['STOP_REQUESTED','CANCELLED','GOAL_CHANGED','GOAL_INACTIVE','PUBLIC_SCOPE_CHANGED','DESTINATION_CHANGED','AUTHORIZATION_REVOKED','AUTHORIZATION_CHANGED','POLICY_CHANGED','POLICY_BLOCKED','ACTIVE_TIME_EXHAUSTED','ABSOLUTE_DEADLINE_EXCEEDED','APPLICATION_CLOSED']);
function safeCode(error:unknown):string {
  const code=error && typeof error==='object' && 'code' in error ? (error as {code:unknown}).code : error instanceof Error ? error.message : '';
  return typeof code==='string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : 'OPERATION_FAILED';
}
const md = (text:string) => text.replace(/[\\`*_{}\[\]<>#|]/g, '\\$&').replace(/[\r\n]+/g,' ');

/** One explicit, bounded public pass. This service has no scheduler, private context or legacy tool entry. */
export function createExplorationService(db:Database.Database, deps:{
  taskService:TaskService; goals:GoalService; authority:PermissionAuthority;
  fetchBroker:ReturnType<typeof createFetchBroker>; fileBroker:FileBroker;
  modelBroker:ReturnType<typeof createModelBroker>; artifactBroker:ArtifactBroker;
  publicInbox:ReturnType<typeof createPublicInbox>; wake?:()=>void; now?:()=>number; uuid?:()=>string;
  createClock?:typeof createRunClock;
}) {
  const now=deps.now??Date.now, uuid=deps.uuid??randomUUID;
  const active=new Map<string,ActiveRun>();
  let disposed=false;
  const at=()=>new Date(now()).toISOString();
  const wake=()=>{try {deps.wake?.();} catch {/* advisory only */}};
  const sessionRow=(runId:string)=>db.prepare('SELECT * FROM m2_exploration_sessions WHERE run_id=?').get(permissionId(runId)) as SessionRow|undefined;
  function project(row:SessionRow,facts?:SessionProjectionRow):ExplorationSession {
    const live=active.get(row.run_id), snapshot=live?.clock.snapshot();
    const plan=facts??db.prepare('SELECT snapshot_json FROM m2_exploration_plans WHERE id=?').get(row.plan_id) as {snapshot_json:string}|undefined;
    const planned=plan?.snapshot_json?JSON.parse(plan.snapshot_json) as PlanSnapshot:undefined;
    const pending=facts?Number(facts.pending_count):Number((db.prepare("SELECT COUNT(*) AS n FROM m2_approval_previews WHERE run_id=? AND state='pending' AND expires_at>?").get(row.run_id,at()) as {n:number}).n);
    return {id:row.id,goalId:row.goal_id,runId:row.run_id,state:live?.persistenceFailed?'outcome_unknown':live?.controller.signal.aborted && !row.settled_at?'stop_requested':row.state==='running' && pending?'waiting_approval':row.state,
      sourceCount:row.source_count,...(row.stop_reason||live?.stopReason?{stopReason:row.stop_reason??live!.stopReason}:{}),
      ...(row.artifact_id?{artifactId:row.artifact_id}:{}),createdAt:row.created_at,...(row.settled_at?{settledAt:row.settled_at}:{}),
      ...(planned?{sourceTotal:planned.goal.sourceUrls.length,goalRevision:planned.goal.revision,destination:{id:planned.destination.id,label:planned.destination.label,
        endpointOrigin:planned.destination.endpointOrigin,model:planned.destination.model,revision:planned.destination.revision,available:planned.destination.available}}:{}),
      ...(live?{phase:live.phase,additionCount:live.additionCount,
        activeRemainingMilliseconds:snapshot!.activeRemainingMilliseconds,absoluteRemainingMilliseconds:snapshot!.absoluteRemainingMilliseconds}:{}),pendingApprovalCount:pending};
  }
  function recordProgress(live:ActiveRun) {
    db.transaction(()=>{
      if(!deps.taskService.isCurrent(live.context))throw new AutonomyError('STALE_TASK_ATTEMPT');
      db.prepare('UPDATE m2_exploration_sessions SET source_count=? WHERE run_id=?').run(live.sourceCount,live.context.runId);
      appendAutonomyAudit(db,'exploration.progress',{sourceCount:live.sourceCount},live.context,at());
    })();wake();
  }
  function abort(live:ActiveRun,reason:string) {
    live.stopReason??=reason;
    live.controller.abort(new AutonomyError(live.stopReason));
    // Memory cancellation must precede every persistence attempt.
    deps.authority.cancelRunOperations(live.context.runId);
    live.clock.stop(live.stopReason);wake();
  }
  function checkLive(live:ActiveRun) {
    if(live.controller.signal.aborted)throw new AutonomyError(live.stopReason??'CANCELLED');
    live.clock.assertRemaining();
    if(!deps.taskService.isCurrent(live.context))throw new AutonomyError('STALE_TASK_ATTEMPT');
    const {goal}=deps.goals.get(live.goalId);
    if(goal.state!=='active'||goal.revision!==live.goalRevision)throw new AutonomyError('GOAL_CHANGED');
    const scope=JSON.parse(getPublicRunBinding(db,live.context).snapshot_json) as {destination:{id:string;revision:number;configHash:string}};
    const destination=deps.goals.resolveDestination(scope.destination.id);
    if(destination.revision!==scope.destination.revision||destination.configHash!==scope.destination.configHash)throw new AutonomyError('DESTINATION_CHANGED');
  }
  async function execute(live:ActiveRun,snapshot:PlanSnapshot):Promise<void> {
    let root:BrokerSession|undefined, artifactId:string|undefined;
    const concurrency=createBrokerConcurrency(snapshot.goal.limits.concurrency);
    const makeSession=(context:TaskRunContext)=>{
      // The scheduler commits this link before execute's microtask. Background
      // work must stop on missing authorization instead of opening user cards.
      const hasScheduler=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='muse_background_triggers'").get();
      const background=hasScheduler&&!!db.prepare('SELECT 1 FROM muse_background_triggers WHERE run_id=?').get(context.runId);
      const session=createBrokerSession({context,authority:deps.authority,clock:live.clock,concurrency,signal:live.controller.signal,callerId:live.callerId,interactiveApproval:!background});
      live.sessions.add(session);return session;
    };
    const settleAttempt=(context:TaskRunContext,state:TerminalTaskState,reason:string)=>{
      try {if(!deps.taskService.settleAttempt(context,state,reason))throw new AutonomyError('STALE_TASK_ATTEMPT');}
      catch {live.persistenceFailed=true;abort(live,'PERSISTENCE_FAILED');}
    };
    try {
      checkLive(live);
      // Every parallel source owns its own Attempt and Session/clock branch.
      const jobs=snapshot.resources.filter(value=>value.kind==='public_url').map(async source=>{
        let child:TaskRunContext|undefined, session:BrokerSession|undefined;
        try {
          checkLive(live);
          child=deps.taskService.beginAttempt(live.context,{taskId:uuid(),delegateCallId:uuid()});
          session=makeSession(child);
          const fetched=await deps.fetchBroker.fetch(session,source.id);
          checkLive(live);
          const document=await deps.fileBroker.read(session,fetched.resource.id);
          checkLive(live);live.sourceCount++;recordProgress(live);
          settleAttempt(child,'completed','public-source-read');
          return document;
        } catch(error) {
          const reason=safeCode(error);abort(live,reason);
          if(child)settleAttempt(child,stopCodes.has(reason)?'cancelled':'failed',reason);
          throw error;
        } finally {session?.close();}
      });
      // Await every branch, including cancelled network/descriptor closure, before final settlement.
      const results=await Promise.allSettled(jobs);
      const failed=results.find(value=>value.status==='rejected');
      if(failed?.status==='rejected')throw failed.reason;
      checkLive(live);
      const documents=results.map(value=>(value as PromiseFulfilledResult<PublicDocument>).value);
      root=makeSession(live.context);
      const anchor=snapshot.resources.find(value=>value.kind==='artifact');
      if(!anchor)throw new AutonomyError('PUBLIC_OUTPUT_SCOPE_INVALID');
      live.phase='summarizing';wake();
      const additions=deps.publicInbox.claim(live.context,live.goalRevision,live.destinationRef);
      live.additionCount=additions.length;
      // Close admission before the model body is built. Later messages need a fresh manual pass.
      live.modelStarted=true;checkLive(live);wake();
      const result=await deps.modelBroker.invoke(root,{anchorRef:anchor.id,destinationRef:live.destinationRef,protocol:snapshot.protocol,documents,additions});
      checkLive(live);live.phase='publishing';wake();
      const bibliography=documents.map((document,index)=>`${index+1}. ${md(document.resource.url??'')}  \n   原文 SHA-256：\`${document.contentHash}\`；资料引用：\`${document.resource.id}\``).join('\n');
      const report=`# ${md(snapshot.goal.title)}\n\n${result.text}\n\n---\n\n## 本轮公开资料记录\n\n主题版本：${snapshot.goal.revision}；协议：${snapshot.protocol}；登记模型：${md(snapshot.destination.model)}。\n\n${bibliography}\n\n已纳入用户确认公开的补充：${additions.length} 条。资料使用有界摘录，保存、验证与用户接受分别记录。\n`;
      const artifact=await deps.artifactBroker.publish(root,{anchorRef:anchor.id,text:report,sourceRefs:documents.map(document=>document.resource.id)});
      artifactId=artifact.id;checkLive(live);
    } catch(error) {
      abort(live,safeCode(error));
    } finally {
      live.phase='settling';
      for(const session of live.sessions)session.close();
      try {
        const unknown=Number((db.prepare("SELECT COUNT(*) AS n FROM m2_operations WHERE run_id=? AND state IN ('prepared','started','outcome_unknown')").get(live.context.runId) as {n:number}).n);
        const writeUnknown=Number((db.prepare("SELECT COUNT(*) AS n FROM m2_public_write_journal w JOIN m2_operations o ON o.id=w.operation_id WHERE o.run_id=? AND w.state!='registered'").get(live.context.runId) as {n:number}).n);
        const outcomeUnknown=live.persistenceFailed||unknown>0||writeUnknown>0||/RECEIPT_UNKNOWN|PERSISTENCE_FAILED/.test(live.stopReason??'');
        const state=outcomeUnknown?'outcome_unknown':live.stopReason?stopCodes.has(live.stopReason)?'stopped':'failed':'completed';
        db.transaction(()=>{
          if(!deps.taskService.settleAttempt(live.context,state==='completed'?'completed':state==='stopped'?'cancelled':'failed',live.stopReason??'public-report-saved'))throw new AutonomyError('STALE_TASK_ATTEMPT');
          if(db.prepare('UPDATE m2_exploration_sessions SET state=?,stop_reason=?,source_count=?,artifact_id=?,settled_at=? WHERE run_id=? AND settled_at IS NULL')
            .run(state,live.stopReason??null,live.sourceCount,artifactId??null,at(),live.context.runId).changes!==1)throw new AutonomyError('PERSISTENCE_FAILED');
          appendAutonomyAudit(db,'exploration.settled',{state,sourceCount:live.sourceCount,...(live.stopReason?{reasonCode:live.stopReason}:{})},live.context,at());
        })();
      } catch {live.persistenceFailed=true;live.stopReason='PERSISTENCE_FAILED';}
      live.clock.dispose();wake();
      if(!live.persistenceFailed)active.delete(live.context.runId);
    }
  }
  const service={
    planExploration(goalId:string,revision:number,protocol:ExplorationPlan['protocol']='chat-completions',callerId:number):ExplorationPlan {
      if(disposed)throw new AutonomyError('STAGE_NOT_READY');permissionInteger(callerId);
      if(!['chat-completions','responses'].includes(protocol))throw new AutonomyError('INVALID_REQUEST');
      const {goal,resources}=deps.goals.get(permissionId(goalId));
      if(goal.revision!==permissionInteger(revision))throw new AutonomyError('REVISION_CONFLICT',goal.revision);
      if(goal.state!=='active')throw new AutonomyError('GOAL_INACTIVE');
      const destination=deps.goals.listDestinations().find(value=>value.id===goal.destinationId);
      if(!destination?.available)throw new AutonomyError('DESTINATION_UNAVAILABLE');
      const actual=deps.goals.resolveDestination(destination.id), id=uuid(),expiresAt=new Date(now()+120000).toISOString();
      const snapshot:PlanSnapshot={goal,resources:resources.filter(value=>value.kind==='public_url'||value.kind==='artifact'),destination:{...destination,configHash:actual.configHash},protocol,policyRevision:deps.authority.getPolicy().revision};
      db.transaction(()=>{
        db.prepare("INSERT INTO m2_exploration_plans(id,goal_id,goal_revision,caller_id,snapshot_json,revision,state,expires_at,created_at) VALUES(?,?,?,?,?,1,'pending',?,?)")
          .run(id,goal.id,goal.revision,callerId,JSON.stringify(snapshot),expiresAt,at());
        appendAutonomyAudit(db,'exploration.planned',{goalId:goal.id,revision:goal.revision});
      })();
      return {id,goalId:goal.id,goalRevision:goal.revision,revision:1,protocol,sources:snapshot.resources.filter(value=>value.kind==='public_url'),destination,limits:goal.limits,expiresAt};
    },
    startExploration(planId:string,revision:number,callerId:number):ExplorationSession {
      if(disposed)throw new AutonomyError('STAGE_NOT_READY');permissionInteger(callerId);permissionInteger(revision);
      let live:ActiveRun|undefined, snapshot:PlanSnapshot|undefined;
      let row:SessionRow;
      try {row=db.transaction(()=>{
        const plan=db.prepare('SELECT * FROM m2_exploration_plans WHERE id=?').get(permissionId(planId)) as PlanRow|undefined;
        if(!plan)throw new AutonomyError('APPROVAL_NOT_FOUND');
        if(plan.caller_id!==callerId)throw new AutonomyError('UNTRUSTED_CALLER');
        const existing=db.prepare('SELECT * FROM m2_exploration_sessions WHERE plan_id=?').get(planId) as SessionRow|undefined;
        if(existing){if(plan.state!=='started'||plan.revision!==revision+1)throw new AutonomyError('REVISION_CONFLICT',plan.revision);return existing;}
        if(plan.revision!==revision)throw new AutonomyError('REVISION_CONFLICT',plan.revision);
        if(plan.state!=='pending'||Date.parse(plan.expires_at)<=now())throw new AutonomyError('APPROVAL_EXPIRED');
        snapshot=JSON.parse(plan.snapshot_json) as PlanSnapshot;
        const current=deps.goals.get(plan.goal_id);
        if(current.goal.state!=='active'||current.goal.revision!==plan.goal_revision||hashValue(current.goal)!==hashValue(snapshot.goal))throw new AutonomyError('GOAL_CHANGED');
        if(hashValue(current.resources.filter(value=>value.kind==='public_url'||value.kind==='artifact'))!==hashValue(snapshot.resources))throw new AutonomyError('RESOURCE_CHANGED');
        const actual=deps.goals.resolveDestination(snapshot.destination.id);
        if(actual.revision!==snapshot.destination.revision||actual.configHash!==snapshot.destination.configHash)throw new AutonomyError('DESTINATION_CHANGED');
        if(deps.authority.getPolicy().revision!==snapshot.policyRevision)throw new AutonomyError('POLICY_CHANGED');
        if(db.prepare("SELECT 1 FROM m2_exploration_sessions WHERE goal_id=? AND state IN ('running','stop_requested','outcome_unknown') AND settled_at IS NULL").get(plan.goal_id))throw new AutonomyError('GOAL_ALREADY_RUNNING');
        const context=deps.taskService.beginRun(`m2-public-${plan.goal_id}`);
        deps.goals.bindRun(context,plan.goal_id,plan.goal_revision);
        const binding=getPublicRunBinding(db,context);
        const clock=(deps.createClock??createRunClock)({activeMilliseconds:snapshot.goal.limits.activeMilliseconds,deadlineAt:binding.deadline_at,wallNow:now});
        live={context,goalId:plan.goal_id,goalRevision:plan.goal_revision,destinationRef:snapshot.destination.id,callerId,
          controller:new AbortController(),clock,sessions:new Set(),promise:Promise.resolve(),phase:'fetching',sourceCount:0,sourceTotal:snapshot.goal.sourceUrls.length,additionCount:0,modelStarted:false,persistenceFailed:false};
        const sessionId=uuid();
        db.prepare("INSERT INTO m2_exploration_sessions(id,plan_id,goal_id,run_id,state,created_at) VALUES(?,?,?,?,'running',?)").run(sessionId,plan.id,plan.goal_id,context.runId,at());
        db.prepare("UPDATE m2_exploration_plans SET state='started',revision=revision+1 WHERE id=? AND revision=? AND state='pending'").run(planId,revision);
        appendAutonomyAudit(db,'exploration.started',{goalId:plan.goal_id,revision:plan.goal_revision},context,at());
        return sessionRow(context.runId)!;
      })();} catch(error){(live as ActiveRun|undefined)?.clock.dispose();throw error;}
      if(live && snapshot){
        const owned=live as ActiveRun;
        active.set(owned.context.runId,owned);
        owned.clock.signal.addEventListener('abort',()=>abort(owned,safeCode(owned.clock.signal.reason)),{once:true});
        owned.promise=Promise.resolve().then(()=>execute(owned,snapshot!));wake();
      }
      return project(row);
    },
    async stopExploration(runId:string):Promise<void> {
      permissionId(runId);const live=active.get(runId);
      if(!live){
        const row=sessionRow(runId);
        if(!row)throw new AutonomyError('EXPLORATION_NOT_FOUND');
        if(row.settled_at)return;
        throw new AutonomyError('STALE_TASK_ATTEMPT');
      }
      // A committed, memory-owned Run needs no database lookup to stop its I/O.
      // A read failure must never prevent the abort and actual promise drain.
      abort(live,'STOP_REQUESTED');
      try {db.transaction(()=>{deps.taskService.requestStop(live.context,'run');db.prepare("UPDATE m2_exploration_sessions SET state='stop_requested',stop_reason=? WHERE run_id=? AND settled_at IS NULL").run(live.stopReason,runId);})();}
      catch {live.persistenceFailed=true;}
      await live.promise;
      if(live.persistenceFailed)throw new AutonomyError('PERSISTENCE_FAILED');
    },
    listExplorations(goalId?:string):ExplorationSession[] {
      if(goalId!==undefined)permissionId(goalId);
      // Read one bounded snapshot per refresh. Per-row plan/count queries made
      // a 200-item history perform 401 database round trips on the main thread.
      const sql=`WITH recent AS (
        SELECT * FROM m2_exploration_sessions ${goalId?'WHERE goal_id=?':''} ORDER BY created_at DESC,id DESC LIMIT 200
      ), pending AS (
        SELECT a.run_id,COUNT(*) AS n FROM m2_approval_previews a JOIN recent r ON r.run_id=a.run_id
        WHERE a.state='pending' AND a.expires_at>? GROUP BY a.run_id
      ) SELECT r.*,p.snapshot_json,COALESCE(a.n,0) AS pending_count FROM recent r
        LEFT JOIN m2_exploration_plans p ON p.id=r.plan_id LEFT JOIN pending a ON a.run_id=r.run_id
        ORDER BY r.created_at DESC,r.id DESC`;
      const rows=db.prepare(sql).all(...(goalId?[goalId,at()]:[at()])) as SessionProjectionRow[];
      return rows.map(row=>project(row,row));
    },
    appendPublicMessage(runId:string,messageId:string,text:string,confirmedPublic:boolean,callerId:number) {
      const live=active.get(permissionId(runId));
      if(!live)return {accepted:false,reason:'run_stopped'};
      if(live.callerId!==callerId)throw new AutonomyError('UNTRUSTED_CALLER');
      if(confirmedPublic!==true)return {accepted:false,reason:'public_confirmation_required'};
      if(live.controller.signal.aborted)return {accepted:false,reason:'run_stopped'};
      const receipt=deps.publicInbox.append(live.context,{messageId,text,explicitlyPublic:true},live.goalRevision);
      return {...receipt,...(receipt.reason==='summary-already-started'?{reason:'summarization_started'}:{})};
    },
    canAppend(context:TaskRunContext):boolean {const live=active.get(context.runId);return !!live && !live.modelStarted && !live.controller.signal.aborted && context.attemptId===live.context.attemptId;},
    isAtSafePoint(context:TaskRunContext):boolean {const live=active.get(context.runId);return !!live && live.phase==='summarizing' && !live.modelStarted && !live.controller.signal.aborted && context.attemptId===live.context.attemptId;},
    cancelGoal(goalId:string,reason='GOAL_CHANGED') {for(const live of active.values())if(live.goalId===goalId)abort(live,reason);},
    cancelAll(reason='DESTINATION_CHANGED') {for(const live of active.values())abort(live,reason);},
    async waitForRun(runId:string):Promise<void> {await active.get(runId)?.promise;},
    reconcileInterrupted():number {
      if(active.size)throw new AutonomyError('PUBLIC_RUNS_ACTIVE');
      return db.transaction(()=>{
        db.prepare("UPDATE m2_exploration_plans SET state='expired',revision=revision+1 WHERE state='pending'").run();
        const rows=db.prepare("SELECT run_id FROM m2_exploration_sessions WHERE settled_at IS NULL").all() as {run_id:string}[];
        for(const row of rows){db.prepare("UPDATE m2_exploration_sessions SET state='interrupted',stop_reason='PROCESS_INTERRUPTED',settled_at=? WHERE run_id=?").run(at(),row.run_id);}
        return rows.length;
      })();
    },
    async dispose():Promise<void> {disposed=true;service.cancelAll('APPLICATION_CLOSED');await Promise.all([...active.values()].map(live=>live.promise));},
  };
  return service;
}
export type ExplorationService=ReturnType<typeof createExplorationService>;
