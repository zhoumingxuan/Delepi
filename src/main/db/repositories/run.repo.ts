import type Database from 'better-sqlite3';
import type { AttemptRecord, RunRecord, TaskRunContext } from '../../modules/tasks/types';

export interface RunRow {
  id: string; conversation_id: string; root_attempt_id: string; owner_id: string; generation: number;
  state: RunRecord['state']; revision: number; created_at: string; updated_at: string; settled_at: string | null;
}
export interface AttemptRow {
  id: string; run_id: string; task_id: string; parent_attempt_id: string | null; delegate_call_id: string | null;
  owner_id: string; generation: number; state: AttemptRecord['state']; started_at: string;
  settled_at: string | null; result_kind: string | null;
}
export function publicRun(row: RunRow): RunRecord {
  return { id: row.id, conversationId: row.conversation_id, rootAttemptId: row.root_attempt_id,
    state: row.state, generation: row.generation, revision: row.revision, createdAt: row.created_at,
    updatedAt: row.updated_at, ...(row.settled_at ? { settledAt: row.settled_at } : {}) };
}
export function publicAttempt(row: AttemptRow): AttemptRecord {
  return { id: row.id, runId: row.run_id, taskId: row.task_id, state: row.state, generation: row.generation,
    startedAt: row.started_at, ...(row.parent_attempt_id ? { parentAttemptId: row.parent_attempt_id } : {}),
    ...(row.delegate_call_id ? { delegateCallId: row.delegate_call_id } : {}),
    ...(row.settled_at ? { settledAt: row.settled_at } : {}), ...(row.result_kind ? { resultKind: row.result_kind } : {}) };
}
export function createRunRepository(db: Database.Database) {
  // Stream callbacks check the durable fence for every delta. Reuse SQL statements,
  // while still reading current rows each time so stop/restart cannot become stale.
  const getRun = db.prepare('SELECT * FROM runs WHERE id=?');
  const getActiveRun = db.prepare("SELECT * FROM runs WHERE conversation_id=? AND state IN ('running','stop_requested')");
  const getAttempt = db.prepare('SELECT * FROM task_attempts WHERE id=?');
  return {
    get: (id: string) => getRun.get(id) as RunRow | undefined,
    active: (conversationId: string) => getActiveRun.get(conversationId) as RunRow | undefined,
    getAttempt: (id: string) => getAttempt.get(id) as AttemptRow | undefined,
    list: (query: { conversationId?: string; limit?: number } = {}) => {
      const limit = Math.min(200, Math.max(1, query.limit ?? 50));
      const rows = query.conversationId
        ? db.prepare('SELECT * FROM runs WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(query.conversationId, limit)
        : db.prepare('SELECT * FROM runs ORDER BY created_at DESC,id DESC LIMIT ?').all(limit);
      return (rows as RunRow[]).map(publicRun);
    },
    attempts: (runId: string) => (db.prepare('SELECT * FROM task_attempts WHERE run_id=? ORDER BY started_at,id').all(runId) as AttemptRow[]).map(publicAttempt),
    context: (row: AttemptRow, run: RunRow): TaskRunContext => Object.freeze({
      runId: run.id, attemptId: row.id, taskId: row.task_id, conversationId: run.conversation_id,
      generation: row.generation, ownerId: row.owner_id,
      ...(row.parent_attempt_id ? { parentAttemptId: row.parent_attempt_id } : {}),
      ...(row.delegate_call_id ? { delegateCallId: row.delegate_call_id } : {}),
    }),
  };
}
