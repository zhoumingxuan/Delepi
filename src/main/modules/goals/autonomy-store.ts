import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { TaskRunContext } from '../tasks/types';
import { canonicalPermissionJson } from '../permissions/permission-validation';

export class AutonomyError extends Error {
  constructor(readonly code: string, readonly currentRevision?: number) { super(code); }
}
export function canonical(value: unknown): string {
  return canonicalPermissionJson(value);
}
export const hashValue = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export function appendAutonomyAudit(db: Database.Database, kind: string, refs: Record<string, string | number | boolean>, context?: TaskRunContext, at = new Date().toISOString()): void {
  const allowed = ['goalId','previewId','grantId','ruleId','operationId','leaseId','resourceId','capability','state','reasonCode','revision','choice','known','bytes','sourceCount'];
  if (!/^[a-z0-9_.-]{1,80}$/.test(kind) || Object.entries(refs).some(([k,v]) => !allowed.includes(k) || (typeof v === 'string' && v.length > 200))) throw new AutonomyError('INVALID_AUDIT_FACT');
  db.prepare('INSERT INTO m2_audit_events(kind,refs_json,run_id,attempt_id,occurred_at) VALUES(?,?,?,?,?)').run(kind,JSON.stringify(refs),context?.runId ?? null,context?.attemptId ?? null,at);
  if (context) db.prepare('INSERT INTO activity_events(run_id,attempt_id,conversation_id,kind,details_json,occurred_at,committed_at) VALUES(?,?,?,?,?,?,?)')
    .run(context.runId,context.attemptId,context.conversationId,kind,JSON.stringify(refs),at,at);
}
export interface PublicRunBinding {
  run_id: string; goal_id: string; goal_revision: number; data_scope_id: string; destination_id: string;
  mode: 'public'; owner_id: string; generation: number; snapshot_json: string; deadline_at: string; created_at: string;
}
export function getPublicRunBinding(db: Database.Database, context: TaskRunContext): PublicRunBinding {
  const row = db.prepare('SELECT * FROM m2_run_scopes WHERE run_id=?').get(context.runId) as PublicRunBinding | undefined;
  if (!row || row.owner_id !== context.ownerId || row.generation !== context.generation) throw new AutonomyError('PUBLIC_SCOPE_MISMATCH');
  return row;
}
