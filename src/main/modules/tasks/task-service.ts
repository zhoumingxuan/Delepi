import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../../db/sqlite-adapter';
import { createRunRepository, publicRun } from '../../db/repositories/run.repo';
import { createActivityRepository } from '../../db/repositories/activity.repo';
import { createInboxRepository, publicInbox } from '../../db/repositories/inbox.repo';
import type { ActivityQuery, TaskRunContext, TerminalTaskState } from './types';

/** Persistence/adjudication around the existing execution entry; this service never launches an agent. */
export function createTaskService(db: Database.Database, dependencies: {
  ownerId?: string; uuid?: () => string; now?: () => string; wake?: (cursor:number)=>void;
} = {}) {
  const uuid = dependencies.uuid ?? randomUUID;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const ownerId = dependencies.ownerId ?? uuid();
  const runs = createRunRepository(db); const activity = createActivityRepository(db); const inbox = createInboxRepository(db);
  let wake = dependencies.wake;
  function notifyCommittedActivity():void {
    try { wake?.(activity.latest()); } catch { /* pull remains authoritative */ }
  }
  // A wake is advisory: persistence succeeded before it runs, and a missed wake is recovered by cursor pull.
  function transaction<T>(operation: () => T): T {
    const before = activity.latest();
    const result = db.transaction(operation)();
    const after = activity.latest();
    if (after > before) { try { wake?.(after); } catch { /* pull remains authoritative */ } }
    return result;
  }
  function isCurrent(context: TaskRunContext, options: {allowStopping?:boolean;allowTerminal?:boolean} = {}): boolean {
    const run = runs.get(context.runId); const attempt = runs.getAttempt(context.attemptId);
    if (!run || !attempt || context.ownerId !== ownerId || run.owner_id !== ownerId || attempt.owner_id !== ownerId
      || context.generation !== run.generation || context.generation !== attempt.generation
      || attempt.run_id !== run.id || attempt.task_id !== context.taskId || run.conversation_id !== context.conversationId
      || (attempt.parent_attempt_id ?? undefined) !== context.parentAttemptId
      || (attempt.delegate_call_id ?? undefined) !== context.delegateCallId) return false;
    if (options.allowTerminal) return true;
    const states = options.allowStopping ? ['running','stop_requested'] : ['running'];
    return states.includes(run.state) && states.includes(attempt.state);
  }
  function cancelPending(context: TaskRunContext, at: string, reasonCode: string): void {
    const rows = db.prepare("SELECT message_id,state FROM run_inbox WHERE attempt_id=? AND state IN ('accepted','injecting')").all(context.attemptId) as Array<{message_id:string;state:string}>;
    for (const row of rows) {
      const state = row.state === 'injecting' ? 'delivery_unknown' : 'cancelled';
      db.prepare("UPDATE run_inbox SET state=?,reason_code=?,updated_at=? WHERE attempt_id=? AND message_id=? AND state=?")
        .run(state,reasonCode,at,context.attemptId,row.message_id,row.state);
      activity.append(context,`inbox.${state}`,{messageId:row.message_id,inboxState:state,reasonCode},at);
    }
  }
  function finalizeRun(context: TaskRunContext, at: string): void {
    const run = runs.get(context.runId)!;
    const root = runs.getAttempt(run.root_attempt_id)!;
    if (['running','stop_requested'].includes(root.state)) return;
    const active = db.prepare("SELECT COUNT(*) AS count FROM task_attempts WHERE run_id=? AND state IN ('running','stop_requested')").get(run.id) as {count:number};
    if (active.count || !['running','stop_requested'].includes(run.state)) return;
    db.prepare('UPDATE runs SET state=?,revision=revision+1,updated_at=?,settled_at=? WHERE id=? AND generation=? AND owner_id=?')
      .run(root.state,at,at,run.id,context.generation,ownerId);
    const rootContext = runs.context(root,run);
    activity.append(rootContext,'run.settled',{state:root.state,generation:context.generation},at);
  }
  const service = {
    ownerId,
    setWakeListener(listener?: (cursor:number)=>void): void { wake = listener; },
    notifyCommittedActivity,
    isCurrent,
    getTrustedContext(attemptId:string):TaskRunContext|null {
      const attempt = runs.getAttempt(attemptId); const run = attempt && runs.get(attempt.run_id);
      if (!attempt || !run) return null;
      const context = runs.context(attempt,run);
      return isCurrent(context,{allowStopping:true,allowTerminal:true}) ? context : null;
    },
    beginRun(conversationId:string):TaskRunContext {
      return transaction(() => {
        const at = now(); const runId = uuid(); const attemptId = uuid(); const taskId = uuid();
        db.prepare("INSERT INTO runs(id,conversation_id,root_attempt_id,owner_id,generation,state,revision,created_at,updated_at) VALUES(?,?,?,?,1,'running',1,?,?)")
          .run(runId,conversationId,attemptId,ownerId,at,at);
        db.prepare("INSERT INTO task_attempts(id,run_id,task_id,owner_id,generation,state,started_at) VALUES(?,?,?,?,1,'running',?)")
          .run(attemptId,runId,taskId,ownerId,at);
        const context = runs.context(runs.getAttempt(attemptId)!,runs.get(runId)!);
        activity.append(context,'run.started',{taskId,generation:1,state:'running'},at);
        activity.append(context,'attempt.started',{taskId,generation:1,state:'running'},at);
        return context;
      });
    },
    beginAttempt(parent:TaskRunContext, params:{taskId:string;delegateCallId:string}):TaskRunContext {
      return transaction(() => {
        if (!isCurrent(parent)) throw new Error('STALE_TASK_ATTEMPT');
        const at = now(); const attemptId = uuid();
        db.prepare("INSERT INTO task_attempts(id,run_id,task_id,parent_attempt_id,delegate_call_id,owner_id,generation,state,started_at) VALUES(?,?,?,?,?,?,?,'running',?)")
          .run(attemptId,parent.runId,params.taskId,parent.attemptId,params.delegateCallId,ownerId,parent.generation,at);
        const context = runs.context(runs.getAttempt(attemptId)!,runs.get(parent.runId)!);
        activity.append(context,'attempt.started',{taskId:params.taskId,parentAttemptId:parent.attemptId,delegateCallId:params.delegateCallId,generation:parent.generation,state:'running'},at);
        return context;
      });
    },
    requestStop(context:TaskRunContext, scope:'run'|'attempt'='attempt'):boolean {
      return transaction(() => {
        if (!isCurrent(context,{allowStopping:true})) return false;
        const at = now(); const run = runs.get(context.runId)!;
        const targets = scope === 'run'
          ? db.prepare("SELECT id FROM task_attempts WHERE run_id=? AND state IN ('running','stop_requested')").all(context.runId) as Array<{id:string}>
          : [{id:context.attemptId}];
        if (scope === 'run' && run.state === 'running') {
          db.prepare("UPDATE runs SET state='stop_requested',revision=revision+1,updated_at=? WHERE id=?").run(at,context.runId);
          activity.append(context,'run.stop_requested',{state:'stop_requested'},at);
        }
        let changed = false;
        for (const target of targets) {
          const row = runs.getAttempt(target.id)!; const targetContext = runs.context(row,run);
          const result = db.prepare("UPDATE task_attempts SET state='stop_requested' WHERE id=? AND state='running'").run(row.id);
          if (result.changes) { changed = true; activity.append(targetContext,'attempt.stop_requested',{state:'stop_requested'},at); }
          cancelPending(targetContext,at,'stop-requested');
        }
        return changed;
      });
    },
    requestConversationStop(conversationId:string):boolean {
      const run = runs.active(conversationId);
      const context = run && service.getTrustedContext(run.root_attempt_id);
      return context ? service.requestStop(context,'run') : false;
    },
    settleAttempt(context:TaskRunContext, state:TerminalTaskState, resultKind?:string):boolean {
      return transaction(() => {
        if (!isCurrent(context,{allowStopping:true})) return false;
        const at = now();
        db.prepare('UPDATE task_attempts SET state=?,settled_at=?,result_kind=? WHERE id=? AND generation=? AND owner_id=?')
          .run(state,at,resultKind ?? null,context.attemptId,context.generation,ownerId);
        cancelPending(context,at,'attempt-settled');
        activity.append(context,'attempt.settled',{state,...(resultKind?{resultKind}:{})},at);
        finalizeRun(context,at);
        return true;
      });
    },
    recordToolStarted(context:TaskRunContext, facts:{callId:string;toolName:string}):boolean {
      return transaction(() => { if (!isCurrent(context)) return false; activity.append(context,'tool.started',facts,now()); return true; });
    },
    recordToolSettled(context:TaskRunContext, facts:{callId:string;toolName:string;success:boolean}, occurredAt?:string):boolean {
      return transaction(() => { if (!isCurrent(context,{allowStopping:true})) return false; activity.append(context,'tool.settled',facts,now(),occurredAt); return true; });
    },
    acceptMessage(context:TaskRunContext,messageId:string,text:string,limit=10,rejectionHint?:'stop-requested'|'terminal'): {
      accepted:boolean;messageId:string;inboxState?:string;reason?:string;duplicate?:boolean;
    } {
      if (typeof messageId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(messageId)
        || typeof text !== 'string') return {accepted:false,messageId,reason:'message-id-conflict'};
      return transaction(() => {
        // A duplicate is still a receipt for an owned attempt. Validate the complete identity
        // before returning any historical acceptance, including after terminal settlement.
        if (!isCurrent(context,{allowStopping:true,allowTerminal:true}))
          return {accepted:false,messageId,reason:'stale-attempt'};
        const contentHash = createHash('sha256').update(text).digest('hex');
        const existing = inbox.get(context.runId,messageId);
        if (existing) {
          if (existing.content_hash !== contentHash || existing.attempt_id !== context.attemptId || existing.generation !== context.generation)
            return {accepted:false,messageId,reason:'message-id-conflict'};
          const reason = existing.state==='delivery_unknown'?'storage-error'
            : existing.reason_code==='stop-requested'?'stop-requested'
            : existing.reason_code==='process-interrupted'?'stale-attempt'
            : existing.state==='cancelled'?'terminal':existing.reason_code;
          return {accepted:['accepted','injecting','injected'].includes(existing.state),messageId,inboxState:existing.state,
            ...(reason?{reason}:{}),duplicate:true};
        }
        let reason:string|undefined;
        {
          const run = runs.get(context.runId)!; const attempt = runs.getAttempt(context.attemptId)!;
          if (rejectionHint) reason=rejectionHint;
          else if (run.state === 'stop_requested' || attempt.state === 'stop_requested') reason='stop-requested';
          else if (run.state !== 'running' || attempt.state !== 'running') reason='terminal';
          else if (!text.trim()) reason='empty';
          else if (text.length > 4000) reason='too-long';
          else if ((db.prepare("SELECT COUNT(*) AS count FROM run_inbox WHERE attempt_id=? AND state IN ('accepted','injecting')").get(context.attemptId) as {count:number}).count >= limit) reason='queue-full';
        }
        const at=now(); const state=reason?'rejected':'accepted';
        db.prepare('INSERT INTO run_inbox(run_id,attempt_id,message_id,generation,text,content_hash,state,reason_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(context.runId,context.attemptId,messageId,context.generation,text,contentHash,state,reason??null,at,at);
        activity.append(context,`inbox.${state}`,{messageId,inboxState:state,...(reason?{reasonCode:reason}:{})},at);
        return {accepted:!reason,messageId,inboxState:state,...(reason?{reason}:{})};
      });
    },
    /** Commit injecting before touching the model array. Never replay an uncertain delivery. */
    injectNext(context:TaskRunContext,push:(text:string,messageId:string)=>void) {
      const row = transaction(() => {
        if (!isCurrent(context)) return null;
        const next = inbox.next(context.attemptId); if (!next) return null;
        const at=now();
        db.prepare("UPDATE run_inbox SET state='injecting',updated_at=? WHERE id=? AND state='accepted'").run(at,next.id);
        activity.append(context,'inbox.injecting',{messageId:next.message_id,inboxState:'injecting'},at);
        return next;
      });
      if (!row) return null;
      try {
        if (!isCurrent(context)) throw new Error('INBOX_DELIVERY_UNCONFIRMED');
        push(row.text,row.message_id);
        return transaction(() => {
          // An abort or restart between push and confirmation has no reliable delivery receipt.
          if (!isCurrent(context)) throw new Error('INBOX_DELIVERY_UNCONFIRMED');
          const at=now();
          const result=db.prepare("UPDATE run_inbox SET state='injected',updated_at=?,injected_at=? WHERE id=? AND state='injecting'").run(at,at,row.id);
          if (!result.changes) throw new Error('INBOX_DELIVERY_UNCONFIRMED');
          activity.append(context,'inbox.injected',{messageId:row.message_id,inboxState:'injected'},at);
          return publicInbox(inbox.get(context.runId,row.message_id)!);
        });
      } catch (error) {
        try { transaction(() => {
          const at=now();
          const result=db.prepare("UPDATE run_inbox SET state='delivery_unknown',reason_code='delivery-unconfirmed',updated_at=? WHERE id=? AND state='injecting'").run(at,row.id);
          if(result.changes) activity.append(context,'inbox.delivery_unknown',{messageId:row.message_id,inboxState:'delivery_unknown',reasonCode:'delivery-unconfirmed'},at);
        }); } catch { /* injecting remains durable and startup will reconcile it */ }
        throw error;
      }
    },
    /** Startup only: fence interrupted work. No automatic model/tool/inbox replay. */
    reconcileInterrupted():{runs:number;attempts:number} {
      return transaction(() => {
        const at=now(); let interruptedRuns=0; let interruptedAttempts=0;
        const activeRuns=db.prepare("SELECT id FROM runs WHERE state IN ('running','stop_requested')").all() as Array<{id:string}>;
        for(const item of activeRuns) {
          const run=runs.get(item.id)!;
          const rows=db.prepare("SELECT id FROM task_attempts WHERE run_id=? AND state IN ('running','stop_requested')").all(run.id) as Array<{id:string}>;
          for(const itemAttempt of rows) {
            const attempt=runs.getAttempt(itemAttempt.id)!;const context=runs.context(attempt,run);
            cancelPending(context,at,'process-interrupted');
            db.prepare("UPDATE task_attempts SET state='interrupted',settled_at=?,result_kind='process-interrupted' WHERE id=?").run(at,attempt.id);
            activity.append(context,'attempt.interrupted',{state:'interrupted',generation:attempt.generation},at);interruptedAttempts++;
          }
          // Also reconcile orphan injecting entries whose attempt had already settled before crash.
          const pending=db.prepare("SELECT DISTINCT attempt_id FROM run_inbox WHERE run_id=? AND state IN ('accepted','injecting')").all(run.id) as Array<{attempt_id:string}>;
          for(const itemPending of pending) { const row=runs.getAttempt(itemPending.attempt_id);if(row)cancelPending(runs.context(row,run),at,'process-interrupted'); }
          db.prepare("UPDATE runs SET state='interrupted',generation=generation+1,revision=revision+1,updated_at=?,settled_at=? WHERE id=?").run(at,at,run.id);
          activity.append({runId:run.id,attemptId:run.root_attempt_id,conversationId:run.conversation_id},'run.interrupted',{state:'interrupted',generation:run.generation+1},at);interruptedRuns++;
        }
        return {runs:interruptedRuns,attempts:interruptedAttempts};
      });
    },
    getRun(runId:string) { const row=runs.get(runId);return row?publicRun(row):null; },
    listRuns:(query:{conversationId?:string;limit?:number}={})=>runs.list(query),
    listAttempts:(runId:string)=>runs.attempts(runId),
    /** Internal cleanup protection is exhaustive, independent of UI history pagination. */
    listAttemptWorkspaceReferences(conversationId:string):Array<{delegateCallId:string}> {
      return (db.prepare('SELECT DISTINCT a.delegate_call_id FROM task_attempts a JOIN runs r ON r.id=a.run_id WHERE r.conversation_id=? AND a.delegate_call_id IS NOT NULL')
        .all(conversationId) as Array<{delegate_call_id:string}>).map(row=>({delegateCallId:row.delegate_call_id}));
    },
    listActivity:(query:ActivityQuery={})=>activity.list(query),
    listInbox:(query:{runId:string;attemptId?:string})=>inbox.list(query),
  };
  return service;
}
export type TaskService = ReturnType<typeof createTaskService>;
let singleton:TaskService|undefined;
export function getTaskService():TaskService { return singleton ??= createTaskService(getDb()); }
