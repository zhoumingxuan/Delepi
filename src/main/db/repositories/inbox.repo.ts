import type Database from 'better-sqlite3';
import type { InboxDeliveryRecord, InboxRecord, InboxState } from '../../modules/tasks/types';
export interface InboxRow {
  id:number;run_id:string;attempt_id:string;message_id:string;generation:number;text:string;content_hash:string;
  state:InboxState;reason_code:string|null;created_at:string;updated_at:string;injected_at:string|null;
}
export function publicInbox(row: InboxRow): InboxRecord {
  return { id:row.id,runId:row.run_id,attemptId:row.attempt_id,messageId:row.message_id,generation:row.generation,
    state:row.state,...(row.reason_code?{reasonCode:row.reason_code}:{}),createdAt:row.created_at,updatedAt:row.updated_at,
    ...(row.injected_at?{injectedAt:row.injected_at}:{}) };
}
export function createInboxRepository(db: Database.Database) {
  const get = db.prepare('SELECT * FROM run_inbox WHERE run_id=? AND message_id=?');
  const next = db.prepare("SELECT * FROM run_inbox WHERE attempt_id=? AND state='accepted' ORDER BY id LIMIT 1");
  return {
    get: (runId:string,messageId:string) => get.get(runId,messageId) as InboxRow|undefined,
    next: (attemptId:string) => next.get(attemptId) as InboxRow|undefined,
    delivery: (row:InboxRow):InboxDeliveryRecord => ({...publicInbox(row),text:row.text,contentHash:row.content_hash}),
    list(query:{runId:string;attemptId?:string}):InboxRecord[] {
      const rows = query.attemptId ? db.prepare('SELECT * FROM run_inbox WHERE run_id=? AND attempt_id=? ORDER BY id').all(query.runId,query.attemptId)
        : db.prepare('SELECT * FROM run_inbox WHERE run_id=? ORDER BY id').all(query.runId);
      return (rows as InboxRow[]).map(publicInbox);
    },
  };
}
