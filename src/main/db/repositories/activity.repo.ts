import type Database from 'better-sqlite3';
import type { ActivityPage, ActivityQuery, ActivityRecord, TaskRunContext } from '../../modules/tasks/types';

const FACT_KEYS = new Set(['taskId','parentAttemptId','delegateCallId','callId','toolName','success','messageId','inboxState','reasonCode','resultKind','generation','state']);
export function safeActivityFacts(facts: Record<string, unknown>): ActivityRecord['details'] {
  const safe: ActivityRecord['details'] = {};
  for (const [key, value] of Object.entries(facts)) {
    if (!FACT_KEYS.has(key)) throw new Error('Unsupported activity fact');
    if (typeof value === 'string' && value.length <= 200) safe[key] = value;
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value))) safe[key] = value;
    else throw new Error('Invalid activity fact');
  }
  return safe;
}
export function createActivityRepository(db: Database.Database) {
  const insert = db.prepare('INSERT INTO activity_events(run_id,attempt_id,conversation_id,kind,details_json,occurred_at,committed_at) VALUES(?,?,?,?,?,?,?)');
  const latest = db.prepare('SELECT COALESCE(MAX(event_id),0) AS id FROM activity_events');
  return {
    append(context: Pick<TaskRunContext, 'runId' | 'attemptId' | 'conversationId'>, kind: string,
      facts: Record<string, unknown>, at: string, occurredAt = at): number {
      return Number(insert
        .run(context.runId, context.attemptId, context.conversationId, kind, JSON.stringify(safeActivityFacts(facts)), occurredAt, at).lastInsertRowid);
    },
    latest(): number { return (latest.get() as {id:number}).id; },
    list(query: ActivityQuery = {}): ActivityPage {
      const latestId = (latest.get() as {id:number}).id;
      const throughEventId = Math.min(latestId, Math.max(0, query.throughEventId ?? latestId));
      const after = Math.max(0, query.afterEventId ?? 0);
      const limit = Math.min(200, Math.max(1, query.limit ?? 50));
      const clauses = ['event_id>?', 'event_id<=?']; const args: Array<string|number> = [after, throughEventId];
      if (query.runId) { clauses.push('run_id=?'); args.push(query.runId); }
      if (query.conversationId) { clauses.push('conversation_id=?'); args.push(query.conversationId); }
      const rows = db.prepare(`SELECT * FROM activity_events WHERE ${clauses.join(' AND ')} ORDER BY event_id LIMIT ?`).all(...args,limit+1) as Array<{
        event_id:number;run_id:string;attempt_id:string|null;conversation_id:string;kind:string;details_json:string;occurred_at:string;committed_at:string;
      }>;
      const hasMore = rows.length > limit;
      const events = rows.slice(0,limit).map(row => ({ eventId:row.event_id,runId:row.run_id,
        ...(row.attempt_id ? {attemptId:row.attempt_id}:{}),conversationId:row.conversation_id,kind:row.kind,
        details:JSON.parse(row.details_json),occurredAt:row.occurred_at,committedAt:row.committed_at }));
      return {events,throughEventId,nextAfterEventId:events.at(-1)?.eventId ?? after,hasMore};
    },
  };
}
