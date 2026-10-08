import type Database from 'better-sqlite3';
import path from 'node:path';

/** Internal exhaustive query. UI list limits must never decide what cleanup preserves. */
export function listPersistentTaskWorkspacePaths(db: Database.Database, conversationsRoot: string): string[] {
  const rows = db.prepare(`SELECT r.conversation_id,a.delegate_call_id
    FROM task_attempts a JOIN runs r ON r.id=a.run_id
    WHERE a.delegate_call_id IS NOT NULL`).all() as Array<{conversation_id: string; delegate_call_id: string}>;
  const valid = (value: string) => typeof value === 'string' && value !== '.' && value !== '..'
    && /^[A-Za-z0-9_.-]{1,200}$/.test(value);
  return rows.map(row => {
    if (!valid(row.conversation_id) || !valid(row.delegate_call_id)) throw new Error('MUSE_WORKSPACE_REFERENCE_INVALID');
    return path.join(conversationsRoot, row.conversation_id, 'tasks', row.delegate_call_id);
  });
}
