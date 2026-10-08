import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { PUBLIC_CAPABILITIES } from '../../../shared/types/autonomy';
import type { ExplorationLimits, GoalState, ModelDestination, PublicGoal, PublicGoalDraft, PublicResource } from '../../../shared/types/autonomy';
import type { TaskService } from '../tasks/task-service';
import type { TaskRunContext } from '../tasks/types';
import { permissionId, permissionInteger, permissionObject, permissionText } from '../permissions/permission-validation';
import { appendAutonomyAudit, AutonomyError, hashValue } from './autonomy-store';

export const DEFAULT_EXPLORATION_LIMITS: ExplorationLimits = {
  activeMilliseconds: 300000, absoluteMilliseconds: 900000, modelRequests: 6, fetchRequests: 8,
  downloadBytes: 5 * 1024 * 1024, storageBytes: 5 * 1024 * 1024, tokenUnits: 100000,
  maxDocumentBytes: 1024 * 1024, concurrency: 2,
};
const limitCaps: ExplorationLimits = {activeMilliseconds:900000,absoluteMilliseconds:3600000,modelRequests:20,fetchRequests:32,
  downloadBytes:20*1024*1024,storageBytes:20*1024*1024,tokenUnits:1000000,maxDocumentBytes:1024*1024,concurrency:2};
export function validateLimits(value: unknown): ExplorationLimits {
  const input=permissionObject(value,Object.keys(limitCaps));
  const result=Object.fromEntries(Object.entries(limitCaps).map(([key,cap])=>[key,permissionInteger(input[key],cap)])) as unknown as ExplorationLimits;
  if(result.activeMilliseconds<1000 || result.absoluteMilliseconds<result.activeMilliseconds || result.maxDocumentBytes<1 || result.concurrency<1
    || result.maxDocumentBytes>result.downloadBytes) throw new AutonomyError('INVALID_REQUEST');
  return result;
}
export function validateSourceUrl(raw: unknown): string {
  const text=permissionText(raw,2048); let url:URL;
  try { url=new URL(text); } catch { throw new AutonomyError('INVALID_REQUEST'); }
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  // Literal IPs are intentionally excluded here. The FetchBroker additionally validates DNS and its actual socket.
  if(url.protocol!=='https:' || url.username || url.password || url.hash || (url.port && url.port!=='443')
    || host.endsWith('.') || !host.includes('.') || isIP(host) || host==='localhost' || /\.(local|localhost|internal|invalid|test)$/.test(host)) throw new AutonomyError('INVALID_REQUEST');
  return url.href;
}
export function validateGoalDraft(raw: unknown): PublicGoalDraft {
  const input=permissionObject(raw,['title','topic','sourceUrls','destinationId','expectedOutput','stopConditions','limits']);
  if(!Array.isArray(input.sourceUrls) || input.sourceUrls.length<1 || input.sourceUrls.length>8) throw new AutonomyError('INVALID_REQUEST');
  const sourceUrls=input.sourceUrls.map(validateSourceUrl);
  if(new Set(sourceUrls).size!==sourceUrls.length) throw new AutonomyError('INVALID_REQUEST');
  return {title:permissionText(input.title,120),topic:permissionText(input.topic,4000),sourceUrls,
    destinationId:permissionId(input.destinationId),expectedOutput:permissionText(input.expectedOutput,1000),
    stopConditions:permissionText(input.stopConditions,1000),limits:validateLimits(input.limits)};
}
interface GoalRow {id:string;revision:number;state:GoalState;title:string;topic:string;source_urls_json:string;destination_id:string;data_scope_id:string;
  expected_output:string;stop_conditions:string;limits_json:string;created_at:string;updated_at:string}
interface ResourceRow {id:string;goal_id:string;data_scope_id:string;kind:PublicResource['kind'];url:string|null;file_path:string|null;
  content_hash:string;size_bytes:number;revision:number;parent_id:string|null}
export interface DestinationConfig {endpoint:string;model:string;apiKey:string;label:string}
export interface DestinationReader { getSettings(): Readonly<Record<string,unknown>> | object;onModelConfigurationChanged?:(listener:()=>void)=>()=>void }
export function createGoalService(db: Database.Database, deps:{taskService:TaskService;config?:DestinationReader;now?:()=>string;uuid?:()=>string;
  onScopeChanged?:(goalId:string)=>void} ) {
  const now=deps.now??(()=>new Date().toISOString()); const uuid=deps.uuid??randomUUID;
  function row(id:string):GoalRow { const value=db.prepare('SELECT * FROM m2_goals WHERE id=?').get(permissionId(id)) as GoalRow|undefined;
    if(!value) throw new AutonomyError('GOAL_NOT_FOUND');return value; }
  function project(value:GoalRow):PublicGoal {return {id:value.id,revision:value.revision,state:value.state,title:value.title,topic:value.topic,
    sourceUrls:JSON.parse(value.source_urls_json),destinationId:value.destination_id,dataScopeId:value.data_scope_id,expectedOutput:value.expected_output,
    stopConditions:value.stop_conditions,limits:JSON.parse(value.limits_json),createdAt:value.created_at,updatedAt:value.updated_at};}
  function resource(value:ResourceRow):PublicResource { return {id:value.id,goalId:value.goal_id,dataScopeId:value.data_scope_id,kind:value.kind,
    ...(value.url?{url:value.url}:{}),contentHash:value.content_hash,sizeBytes:value.size_bytes,revision:value.revision,...(value.parent_id?{parentId:value.parent_id}:{})}; }
  function configFor(sourceKey:string):DestinationConfig|null {
    const settings=deps.config?.getSettings() as Record<string,unknown>|undefined;
    if(!settings || !['main','executor'].includes(sourceKey)) return null;
    const endpoint=settings[sourceKey+'ModelBaseUrl']; const model=settings[sourceKey+'ModelName']; const apiKey=settings[sourceKey+'ModelApiKey'];
    if(typeof endpoint!=='string'||typeof model!=='string'||!model.trim()||model.length>200||typeof apiKey!=='string'||!apiKey.trim()) return null;
    try {const url=new URL(endpoint);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) return null;
      // HTTP is reserved for explicitly configured local/private model servers, never public Fetch.
      const host=url.hostname.replace(/^\[|\]$/g,'');
      const octets=isIP(host)===4?host.split('.').map(Number):[];
      const privateV4=octets.length===4&&(octets[0]===127||octets[0]===10||(octets[0]===192&&octets[1]===168)||(octets[0]===172&&octets[1]>=16&&octets[1]<=31));
      const privateV6=isIP(host)===6&&(host==='::1'||/^f[cd][0-9a-f]{2}:/i.test(host));
      if(url.protocol==='http:' && !(host==='localhost'||privateV4||privateV6))return null;
      return {endpoint:url.href,model,apiKey,label:sourceKey==='main'?'当前主模型':'当前执行模型'};
    } catch{return null;}
  }
  function destination(id:string):ModelDestination {
    const value=db.prepare('SELECT * FROM m2_model_destinations WHERE id=?').get(permissionId(id)) as {id:string;source_key:string;endpoint:string;model:string;config_hash:string;revision:number}|undefined;
    if(!value)throw new AutonomyError('DESTINATION_UNAVAILABLE');
    const actual=configFor(value.source_key);const available=!!actual && value.config_hash===hashValue({endpoint:actual.endpoint,model:actual.model,apiKey:actual.apiKey});
    return {id:value.id,label:actual?.label??'已登记模型',endpointOrigin:new URL(value.endpoint).origin,model:value.model,revision:value.revision,available};
  }
  function listDestinations():ModelDestination[] {
    db.transaction(()=>{for(const source of ['main','executor']) {const actual=configFor(source);if(!actual)continue;
      const configHash=hashValue({endpoint:actual.endpoint,model:actual.model,apiKey:actual.apiKey});
      const old=db.prepare('SELECT id,config_hash FROM m2_model_destinations WHERE source_key=?').get(source) as {id:string;config_hash:string}|undefined;
      if(!old)db.prepare('INSERT INTO m2_model_destinations VALUES(?,?,?,?,?,1,?)').run(uuid(),source,actual.endpoint,actual.model,configHash,now());
      else if(old.config_hash!==configHash) {db.prepare('UPDATE m2_model_destinations SET endpoint=?,model=?,config_hash=?,revision=revision+1 WHERE id=?').run(actual.endpoint,actual.model,configHash,old.id);
        appendAutonomyAudit(db,'destination.changed',{revision:(db.prepare('SELECT revision FROM m2_model_destinations WHERE id=?').get(old.id) as {revision:number}).revision},undefined,now());}
    }})();
    return (db.prepare('SELECT id FROM m2_model_destinations ORDER BY source_key').all() as {id:string}[]).map(v=>destination(v.id));
  }
  function requireDestination(id:string) { listDestinations();const value=destination(id);if(!value.available)throw new AutonomyError('DESTINATION_UNAVAILABLE');return value; }
  function currentResources(goal:PublicGoal):PublicResource[] {
    const rows=db.prepare('SELECT * FROM m2_resources WHERE goal_id=? ORDER BY created_at,id').all(goal.id) as ResourceRow[];
    const byId=new Map(rows.map(r=>[r.id,r]));
    function current(value:ResourceRow,seen=new Set<string>()):boolean {
      if(value.goal_id!==goal.id||value.data_scope_id!==goal.dataScopeId||seen.has(value.id))return false;
      if(value.kind==='public_url')return goal.sourceUrls.includes(value.url??'');
      if(value.kind==='artifact')return value.file_path===null && value.parent_id===null;
      seen.add(value.id);const parent=value.parent_id&&byId.get(value.parent_id);
      return !!parent && parent.kind==='public_url' && current(parent,seen);
    }
    return rows.filter(r=>current(r)).map(resource);
  }
  function createResources(goal:PublicGoal):void {
    if(!db.prepare("SELECT id FROM m2_resources WHERE goal_id=? AND kind='artifact' AND file_path IS NULL").get(goal.id)) {
      db.prepare("INSERT INTO m2_resources(id,goal_id,data_scope_id,kind,content_hash,size_bytes,revision,created_at) VALUES(?,?,?,'artifact',?,0,1,?)")
        .run(uuid(),goal.id,goal.dataScopeId,hashValue({goalId:goal.id,dataScopeId:goal.dataScopeId,kind:'output-scope'}),now());
    }
    for(const url of goal.sourceUrls) {
      const old=db.prepare("SELECT id FROM m2_resources WHERE goal_id=? AND kind='public_url' AND url=?").get(goal.id,url);
      if(!old)db.prepare("INSERT INTO m2_resources(id,goal_id,data_scope_id,kind,url,content_hash,size_bytes,revision,created_at) VALUES(?,?,?,'public_url',?,?,0,1,?)")
        .run(uuid(),goal.id,goal.dataScopeId,url,hashValue(url),now());
    }
  }
  function get(id:string) {const goal=project(row(id));return {goal,resources:currentResources(goal)};}
  function checkRevision(value:GoalRow,revision:number) {if(value.revision!==permissionInteger(revision))throw new AutonomyError('REVISION_CONFLICT',value.revision);}
  function invalidate(goalId:string):void {
    const at=now();
    db.prepare("UPDATE m2_approval_previews SET state='revoked',revision=revision+1 WHERE goal_id=? AND state='pending'").run(goalId);
    db.prepare("UPDATE m2_grants SET state='revoked',revision=revision+1,updated_at=? WHERE goal_id=? AND state='active'").run(at,goalId);
    db.prepare("UPDATE m2_standing_rules SET state='suspended',revision=revision+1,updated_at=? WHERE goal_id=? AND state='active'").run(at,goalId);
    db.prepare("UPDATE m2_rule_previews SET state='revoked',revision=revision+1 WHERE goal_id=? AND state='pending'").run(goalId);
  }
  const service={
    list:()=> (db.prepare('SELECT * FROM m2_goals ORDER BY updated_at DESC,id').all() as GoalRow[]).map(project), get,listDestinations,
    create(raw:PublicGoalDraft):PublicGoal {
      const draft=validateGoalDraft(raw);requireDestination(draft.destinationId);
      return db.transaction(()=>{const at=now(),id=uuid(),scopeId=uuid();
        db.prepare("INSERT INTO m2_goals(id,revision,state,title,topic,source_urls_json,destination_id,data_scope_id,expected_output,stop_conditions,limits_json,created_at,updated_at) VALUES(?,1,'active',?,?,?,?,?,?,?,?,?,?)").run(id,draft.title,draft.topic,JSON.stringify(draft.sourceUrls),draft.destinationId,scopeId,draft.expectedOutput,draft.stopConditions,JSON.stringify(draft.limits),at,at);
        db.prepare("INSERT INTO m2_data_scopes VALUES(?,?,'public',?,?,1,?)").run(scopeId,id,JSON.stringify(PUBLIC_CAPABILITIES),draft.destinationId,at);
        const goal=project(row(id));createResources(goal);appendAutonomyAudit(db,'goal.created',{goalId:id,revision:1,state:'active'},undefined,at);return goal;
      })();
    },
    update(id:string,revision:number,raw:PublicGoalDraft):PublicGoal {
      const draft=validateGoalDraft(raw);requireDestination(draft.destinationId);
      const result=db.transaction(()=>{const old=row(id);checkRevision(old,revision);if(old.state==='archived')throw new AutonomyError('GOAL_INACTIVE');
        db.prepare('UPDATE m2_goals SET revision=revision+1,title=?,topic=?,source_urls_json=?,destination_id=?,expected_output=?,stop_conditions=?,limits_json=?,updated_at=? WHERE id=?')
          .run(draft.title,draft.topic,JSON.stringify(draft.sourceUrls),draft.destinationId,draft.expectedOutput,draft.stopConditions,JSON.stringify(draft.limits),now(),id);
        db.prepare('UPDATE m2_data_scopes SET revision=revision+1,destination_id=? WHERE goal_id=?').run(draft.destinationId,id);
        invalidate(id);const goal=project(row(id));createResources(goal);appendAutonomyAudit(db,'goal.updated',{goalId:id,revision:goal.revision},undefined,now());return goal;
      })();deps.onScopeChanged?.(id);return result;
    },
    setState(id:string,revision:number,state:GoalState):PublicGoal {
      if(!['active','paused','archived'].includes(state))throw new AutonomyError('INVALID_REQUEST');
      const result=db.transaction(()=>{const old=row(id);checkRevision(old,revision);if(old.state==='archived' && state!=='archived')throw new AutonomyError('GOAL_INACTIVE');
        if(old.state===state)return project(old);
        db.prepare('UPDATE m2_goals SET state=?,revision=revision+1,updated_at=? WHERE id=?').run(state,now(),id);invalidate(id);
        const goal=project(row(id));appendAutonomyAudit(db,'goal.state_changed',{goalId:id,state,revision:goal.revision},undefined,now());return goal;
      })();deps.onScopeChanged?.(id);return result;
    },
    bindRun(context:TaskRunContext,id:string,revision:number):void {
      const selected=requireDestination(row(id).destination_id);
      db.transaction(()=>{const old=row(id);checkRevision(old,revision);if(old.state!=='active'||!deps.taskService.isCurrent(context))throw new AutonomyError('STALE_TASK_ATTEMPT');
        const scope=project(old),resources=currentResources(scope).filter(value=>value.kind==='public_url'||value.kind==='artifact'),at=now();
        const destinationRow=db.prepare('SELECT config_hash FROM m2_model_destinations WHERE id=?').get(selected.id) as {config_hash:string};
        const snapshot={goal:scope,resources,destination:{id:selected.id,revision:selected.revision,configHash:destinationRow.config_hash},limits:scope.limits};
        db.prepare("INSERT INTO m2_run_scopes VALUES(?,?,?,?,?,'public',?,?,?,?,?)")
          .run(context.runId,id,revision,scope.dataScopeId,selected.id,context.ownerId,context.generation,JSON.stringify(snapshot),new Date(Date.parse(at)+scope.limits.absoluteMilliseconds).toISOString(),at);
        appendAutonomyAudit(db,'scope.bound',{goalId:id,revision},context,at);
      })();
    },
    resolveResource(id:string):PublicResource { const value=db.prepare('SELECT * FROM m2_resources WHERE id=?').get(permissionId(id)) as ResourceRow|undefined;
      if(!value)throw new AutonomyError('RESOURCE_NOT_FOUND');return resource(value); },
    resolveDestination(id:string):DestinationConfig & {revision:number;configHash:string} {
      const selected=requireDestination(id);const value=db.prepare('SELECT source_key,config_hash FROM m2_model_destinations WHERE id=?').get(id) as {source_key:string;config_hash:string};
      const config=configFor(value.source_key);if(!config)throw new AutonomyError('DESTINATION_UNAVAILABLE');
      return {...config,revision:selected.revision,configHash:value.config_hash};
    },
  };return service;
}
export type GoalService=ReturnType<typeof createGoalService>;
