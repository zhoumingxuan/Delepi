import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { PublicAddition } from '../brokers/contracts';
import type { TaskService } from '../tasks/task-service';
import type { TaskRunContext } from '../tasks/types';
import type { GoalService } from '../goals/goal-service';
import { appendAutonomyAudit, getPublicRunBinding } from '../goals/autonomy-store';
import { permissionInteger } from '../permissions/permission-validation';

export class PublicInboxError extends Error { constructor(readonly code: string) { super(code); } }
export interface PublicInboxReceipt { accepted: boolean; messageId: string; reason?: string; duplicate?: boolean }
type Scope = { goalId: string; dataScopeId: string; goalRevision: number; destinationId: string; destinationRevision: number; configHash: string };
type InboxRow = { id: number; run_id: string; attempt_id: string; generation: number; message_id: string; text: string; content_hash: string; state: string };
type PublicRow = { classification: string; data_scope_id: string; goal_revision: number; destination_id: string;
  destination_revision: number | null; destination_config_hash: string | null; content_hash: string | null };
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const messageId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);

/** Only a newly bound public Run can use this queue. It never searches a chat or private history. */
export function createPublicInbox(db: Database.Database, options: {
  taskService: TaskService; goalService: GoalService;
  canAppend(context: TaskRunContext): boolean;
  isAtSafePoint(context: TaskRunContext): boolean;
  now?: () => string;
}) {
  const now = options.now ?? (() => new Date().toISOString());
  const minted = new WeakMap<PublicAddition, { runId: string; attemptId: string; generation: number; scope: Scope }>();
  const scope = (context: TaskRunContext, expectedRevision?: number, destinationRef?: string): Scope => {
    if (!options.taskService.isCurrent(context)) throw new PublicInboxError('STALE_TASK_ATTEMPT');
    const run = db.prepare('SELECT root_attempt_id FROM runs WHERE id=?').get(context.runId) as { root_attempt_id: string } | undefined;
    if (run?.root_attempt_id !== context.attemptId) throw new PublicInboxError('PUBLIC_INBOX_ROOT_REQUIRED');
    const binding = getPublicRunBinding(db, context);
    const instant = Date.parse(now()), deadline = Date.parse(binding.deadline_at);
    if (!Number.isFinite(instant) || !Number.isFinite(deadline) || instant >= deadline) throw new PublicInboxError('PUBLIC_INBOX_DEADLINE_EXPIRED');
    if (binding.mode !== 'public' || (expectedRevision !== undefined && permissionInteger(expectedRevision) !== binding.goal_revision)
      || (destinationRef !== undefined && destinationRef !== binding.destination_id)) throw new PublicInboxError('PUBLIC_INBOX_SCOPE_MISMATCH');
    const current = options.goalService.get(binding.goal_id).goal;
    if (current.state !== 'active' || current.revision !== binding.goal_revision || current.dataScopeId !== binding.data_scope_id
      || current.destinationId !== binding.destination_id) throw new PublicInboxError('PUBLIC_INBOX_SCOPE_CHANGED');
    const data = db.prepare('SELECT classification,allowed_uses_json,destination_id FROM m2_data_scopes WHERE id=? AND goal_id=?').get(binding.data_scope_id, binding.goal_id) as {
      classification: string; allowed_uses_json: string; destination_id: string;
    } | undefined;
    if (data?.classification !== 'public' || data.destination_id !== binding.destination_id || !(JSON.parse(data.allowed_uses_json) as string[]).includes('model.invoke')) throw new PublicInboxError('PUBLIC_INBOX_SCOPE_MISMATCH');
    const snapshot = JSON.parse(binding.snapshot_json) as { destination: { id: string; revision: number; configHash: string } };
    const actual = options.goalService.resolveDestination(binding.destination_id);
    if (snapshot.destination.id !== binding.destination_id || actual.revision !== snapshot.destination.revision
      || actual.configHash !== snapshot.destination.configHash) throw new PublicInboxError('DESTINATION_CHANGED');
    return { goalId: binding.goal_id, dataScopeId: binding.data_scope_id, goalRevision: binding.goal_revision,
      destinationId: binding.destination_id, destinationRevision: actual.revision, configHash: actual.configHash };
  };
  function valid(row: PublicRow | undefined, selected: Scope, contentHash: string): boolean {
    return !!row && row.classification === 'public' && row.data_scope_id === selected.dataScopeId && row.goal_revision === selected.goalRevision
      && row.destination_id === selected.destinationId && row.destination_revision === selected.destinationRevision
      && row.destination_config_hash === selected.configHash && row.content_hash === contentHash;
  }
  return {
    append(context: TaskRunContext, input: { messageId: string; text: string; explicitlyPublic: true }, expectedGoalRevision: number): PublicInboxReceipt {
      const id = input?.messageId;
      if (!messageId(id)) throw new PublicInboxError('PUBLIC_INBOX_INPUT_INVALID');
      if (input.explicitlyPublic !== true) return { accepted: false, messageId: id, reason: 'public-confirmation-required' };
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.includes('\0')) return { accepted: false, messageId: id, reason: 'empty-or-invalid' };
      // Preserve M1's character bound as well as this public context's stricter UTF-8 byte bound.
      if (input.text.length > 4000 || Buffer.byteLength(input.text, 'utf8') > 4096) return { accepted: false, messageId: id, reason: 'too-long' };
      const result = db.transaction(() => {
        const selected = scope(context, expectedGoalRevision), contentHash = hash(input.text);
        const previous = db.prepare('SELECT * FROM run_inbox WHERE run_id=? AND message_id=?').get(context.runId, id) as InboxRow | undefined;
        if (previous) {
          const classification = db.prepare('SELECT * FROM m2_public_inbox WHERE run_id=? AND message_id=?').get(context.runId, id) as PublicRow | undefined;
          if (!valid(classification, selected, contentHash) || previous.content_hash !== contentHash || previous.attempt_id !== context.attemptId
            || previous.generation !== context.generation) return { accepted: false, messageId: id, reason: 'message-id-conflict' };
          return options.taskService.acceptMessage(context, id, input.text);
        }
        if (!options.canAppend(context)) return { accepted: false, messageId: id, reason: 'summary-already-started' };
        const receipt = options.taskService.acceptMessage(context, id, input.text, 10);
        if (!receipt.accepted) return receipt;
        db.prepare('INSERT INTO m2_public_inbox(run_id,message_id,classification,data_scope_id,goal_revision,destination_id,destination_revision,destination_config_hash,content_hash) VALUES(?,?,\'public\',?,?,?,?,?,?)')
          .run(context.runId, id, selected.dataScopeId, selected.goalRevision, selected.destinationId, selected.destinationRevision, selected.configHash, contentHash);
        appendAutonomyAudit(db, 'public.inbox.accepted', { goalId: selected.goalId, revision: selected.goalRevision }, context, now());
        return receipt;
      })();
      options.taskService.notifyCommittedActivity();
      return result;
    },
    /** Commit a local safe-point claim before returning any text; uncertainty is never replayed. */
    claim(context: TaskRunContext, expectedGoalRevision: number, destinationRef: string): PublicAddition[] {
      const prepared: Array<{ addition: PublicAddition; scope: Scope }> = [];
      db.transaction(() => {
        const selected = scope(context, expectedGoalRevision, destinationRef);
        if (!options.isAtSafePoint(context)) throw new PublicInboxError('PUBLIC_INBOX_NOT_AT_SAFE_POINT');
        // The join excludes unlabeled M1 messages without loading their text into the public path.
        const rows = db.prepare(`SELECT i.*,p.classification,p.data_scope_id,p.goal_revision,p.destination_id,
          p.destination_revision,p.destination_config_hash,p.content_hash AS public_content_hash FROM run_inbox i
          JOIN m2_public_inbox p ON p.run_id=i.run_id AND p.message_id=i.message_id
          WHERE i.run_id=? AND i.attempt_id=? AND i.generation=? AND i.state='accepted' AND p.classification='public'
          ORDER BY i.id LIMIT 10`).all(context.runId, context.attemptId, context.generation) as Array<InboxRow & PublicRow & { public_content_hash: string | null }>;
        for (const row of rows) {
          if (!valid({ ...row, content_hash: row.public_content_hash }, selected, row.content_hash) || hash(row.text) !== row.content_hash
            || row.text.includes('\0') || row.text.length > 4000 || Buffer.byteLength(row.text, 'utf8') > 4096) throw new PublicInboxError('PUBLIC_INBOX_CLASSIFICATION_CHANGED');
          const at = now();
          if (db.prepare("UPDATE run_inbox SET state='injected',updated_at=?,injected_at=? WHERE id=? AND state='accepted'").run(at, at, row.id).changes !== 1) throw new PublicInboxError('PUBLIC_INBOX_CLAIM_CONFLICT');
          appendAutonomyAudit(db, 'public.inbox.claimed', { goalId: selected.goalId, revision: selected.goalRevision }, context, at);
          prepared.push({ scope: selected, addition: Object.freeze({ id: row.message_id, text: row.text, contentHash: row.content_hash,
            goalId: selected.goalId, dataScopeId: selected.dataScopeId, classification: 'public' }) });
        }
      })();
      for (const item of prepared) minted.set(item.addition, { runId: context.runId, attemptId: context.attemptId, generation: context.generation, scope: item.scope });
      options.taskService.notifyCommittedActivity();
      return prepared.map(item => item.addition);
    },
    verifyAddition(addition: PublicAddition, context: TaskRunContext, destinationRef: string): boolean {
      try {
        const receipt = minted.get(addition), selected = scope(context, undefined, destinationRef);
        if (!receipt || receipt.runId !== context.runId || receipt.attemptId !== context.attemptId || receipt.generation !== context.generation
          || receipt.scope.goalRevision !== selected.goalRevision || receipt.scope.destinationRevision !== selected.destinationRevision || receipt.scope.configHash !== selected.configHash) return false;
        const row = db.prepare('SELECT state,content_hash FROM run_inbox WHERE run_id=? AND message_id=? AND attempt_id=? AND generation=?')
          .get(context.runId, addition.id, context.attemptId, context.generation) as { state: string; content_hash: string } | undefined;
        const classification = db.prepare('SELECT * FROM m2_public_inbox WHERE run_id=? AND message_id=?').get(context.runId, addition.id) as PublicRow | undefined;
        return row?.state === 'injected' && row.content_hash === addition.contentHash && hash(addition.text) === addition.contentHash
          && valid(classification, selected, addition.contentHash) && addition.goalId === selected.goalId && addition.dataScopeId === selected.dataScopeId
          && addition.classification === 'public';
      } catch { return false; }
    },
  };
}
export type PublicInbox = ReturnType<typeof createPublicInbox>;
