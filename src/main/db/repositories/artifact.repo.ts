import type Database from 'better-sqlite3';
import path from 'node:path';
import { getDb } from '../sqlite-adapter';

export type ArtifactSaveState = 'staging' | 'saved' | 'failed' | 'missing' | 'quarantined';
export type ArtifactValidationState = 'pending' | 'passed' | 'failed' | 'not_applicable';
export type ArtifactAcceptanceState = 'unreviewed' | 'accepted' | 'rejected';
export interface ArtifactOrigin {
  runId: string; attemptId: string; conversationId: string; generation: number; ownerId: string;
}
export interface ArtifactRecord {
  id: string; runId?: string; attemptId?: string; conversationId?: string;
  sourcePath: string; path: string; title: string; contentHash: string; sizeBytes: number;
  saveState: ArtifactSaveState; validationState: ArtifactValidationState;
  acceptanceState: ArtifactAcceptanceState; needsReview: boolean;
  revision: number; createdAt: string; updatedAt: string;
}
export interface PublicationRecord {
  id: string; artifactId: string; sourcePath: string; targetPath: string; stagingPath: string;
  expectedHash: string; sizeBytes: number;
  fileDev?: number; fileIno?: number;
  phase: 'intent' | 'staged' | 'published' | 'registered' | 'failed' | 'needs_review';
  errorCode?: string; createdAt: string; updatedAt: string;
}
export interface ArtifactAcceptanceRequest {
  artifactId: string; expectedRevision: number; accepted: boolean; requestId: string;
}
type Row = Record<string, string | number | null>;

function fromRow(row: Row): ArtifactRecord {
  return {
    id: String(row.id), runId: row.run_id ? String(row.run_id) : undefined,
    attemptId: row.attempt_id ? String(row.attempt_id) : undefined,
    conversationId: row.conversation_id ? String(row.conversation_id) : undefined,
    sourcePath: String(row.source_path), path: String(row.path), title: String(row.name),
    contentHash: String(row.content_hash), sizeBytes: Number(row.size_bytes),
    saveState: row.save_state as ArtifactSaveState, validationState: row.validation_state as ArtifactValidationState,
    acceptanceState: row.acceptance_state as ArtifactAcceptanceState, needsReview: row.needs_review === 1,
    revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export class ArtifactRepository {
  constructor(private readonly database: () => Database.Database = getDb) {}
  get db(): Database.Database { return this.database(); }

  private appendActivity(record: ArtifactRecord, kind: string): void {
    if (!record.runId || !record.attemptId || !record.conversationId) return;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO activity_events(run_id,attempt_id,conversation_id,kind,details_json,occurred_at,committed_at)
      VALUES(?,?,?,?,?,?,?)`).run(record.runId, record.attemptId, record.conversationId, kind,
        JSON.stringify({ artifactId: record.id, saveState: record.saveState, validationState: record.validationState,
          acceptanceState: record.acceptanceState, needsReview: record.needsReview }), now, now);
  }

  assertOrigin(origin: ArtifactOrigin): void {
    const row = this.db.prepare(`SELECT r.conversation_id, r.owner_id, r.generation,r.state AS run_state,
      a.owner_id AS attempt_owner, a.generation AS attempt_generation,a.state AS attempt_state FROM runs r
      JOIN task_attempts a ON a.run_id=r.id WHERE r.id=? AND a.id=?`).get(origin.runId, origin.attemptId) as Row | undefined;
    if (!row || row.conversation_id !== origin.conversationId || row.owner_id !== origin.ownerId
      || row.attempt_owner !== origin.ownerId || row.generation !== origin.generation
      || row.attempt_generation !== origin.generation) throw new Error('ARTIFACT_ORIGIN_INVALID');
    if (row.run_state !== 'running' || row.attempt_state !== 'running') throw new Error('ARTIFACT_ORIGIN_NOT_RUNNING');
  }

  begin(record: ArtifactRecord, publication: PublicationRecord, origin?: ArtifactOrigin,
    onRegisteredInTransaction?: (record: ArtifactRecord) => void): void {
    this.db.transaction(() => {
      if (origin) this.assertOrigin(origin);
      this.db.prepare(`INSERT INTO artifacts(id,run_id,attempt_id,conversation_id,source_path,path,name,
        content_hash,size_bytes,save_state,validation_state,acceptance_state,needs_review,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.id, record.runId ?? null, record.attemptId ?? null,
        record.conversationId ?? null, record.sourcePath, record.path, record.title, record.contentHash,
        record.sizeBytes, record.saveState, record.validationState, record.acceptanceState, record.needsReview ? 1 : 0,
        record.revision, record.createdAt, record.updatedAt);
      this.db.prepare(`INSERT INTO artifact_publish_journal(id,artifact_id,source_path,target_path,staging_path,
        expected_hash,size_bytes,file_dev,file_ino,phase,error_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(publication.id, publication.artifactId, publication.sourcePath, publication.targetPath,
          publication.stagingPath, publication.expectedHash, publication.sizeBytes,
          publication.fileDev ?? null, publication.fileIno ?? null, publication.phase,
          publication.errorCode ?? null, publication.createdAt, publication.updatedAt);
      if (onRegisteredInTransaction) {
        const result=onRegisteredInTransaction(record) as unknown;
        if(result && typeof (result as {then?:unknown}).then==='function') throw new Error('ARTIFACT_REGISTRATION_ASYNC_FORBIDDEN');
      }
      if (record.saveState === 'saved') this.appendActivity(record, 'artifact.saved');
    })();
  }

  get(id: string): ArtifactRecord | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  list(options: { conversationId?: string; runId?: string; limit?: number; cursor?: string } = {}): ArtifactRecord[] {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 40)));
    const where: string[] = []; const args: Array<string | number> = [];
    if (options.conversationId) { where.push('conversation_id=?'); args.push(options.conversationId); }
    if (options.runId) { where.push('run_id=?'); args.push(options.runId); }
    if (options.cursor) {
      const cursor = this.get(options.cursor);
      if (!cursor) throw new Error('ARTIFACT_CURSOR_INVALID');
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      args.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    return (this.db.prepare(`SELECT * FROM artifacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC,id DESC LIMIT ?`).all(...args, limit + 1) as Row[]).map(fromRow);
  }

  publications(): PublicationRecord[] {
    return (this.db.prepare('SELECT * FROM artifact_publish_journal ORDER BY created_at,id').all() as Row[]).map((row) => ({
      id: String(row.id), artifactId: String(row.artifact_id), sourcePath: String(row.source_path),
      targetPath: String(row.target_path), stagingPath: String(row.staging_path), expectedHash: String(row.expected_hash),
      sizeBytes: Number(row.size_bytes), phase: row.phase as PublicationRecord['phase'],
      fileDev: row.file_dev !== null ? Number(row.file_dev) : undefined,
      fileIno: row.file_ino !== null ? Number(row.file_ino) : undefined,
      errorCode: row.error_code ? String(row.error_code) : undefined,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  setPhase(id: string, phase: PublicationRecord['phase'], errorCode?: string): void {
    this.db.prepare('UPDATE artifact_publish_journal SET phase=?,error_code=?,updated_at=? WHERE id=?')
      .run(phase, errorCode ?? null, new Date().toISOString(), id);
  }

  setStagedIdentity(id: string, dev: number, ino: number): void {
    this.db.prepare("UPDATE artifact_publish_journal SET phase='staged',file_dev=?,file_ino=?,updated_at=? WHERE id=?")
      .run(dev, ino, new Date().toISOString(), id);
  }

  /** A failed no-overwrite link has no target side effect; journal a new destination before retrying it. */
  retargetStagedPublication(publicationId: string, artifactId: string, targetPath: string): void {
    this.db.transaction(() => {
      const now = new Date().toISOString();
      const journal = this.db.prepare(`UPDATE artifact_publish_journal SET target_path=?,updated_at=?
        WHERE id=? AND artifact_id=? AND phase='staged'`).run(targetPath, now, publicationId, artifactId);
      const artifact = this.db.prepare(`UPDATE artifacts SET path=?,name=?,revision=revision+1,updated_at=?
        WHERE id=? AND save_state='staging'`).run(targetPath, path.basename(targetPath), now, artifactId);
      if (journal.changes !== 1 || artifact.changes !== 1) throw new Error('ARTIFACT_PUBLICATION_NOT_STAGED');
    })();
  }

  publicationIdentity(artifactId: string): { dev: number; ino: number } | null {
    const row = this.db.prepare('SELECT file_dev,file_ino FROM artifact_publish_journal WHERE artifact_id=?')
      .get(artifactId) as Row | undefined;
    return row && row.file_dev !== null && row.file_ino !== null
      ? { dev: Number(row.file_dev), ino: Number(row.file_ino) } : null;
  }

  setSaveState(id: string, state: ArtifactSaveState, needsReview = false): ArtifactRecord {
    this.db.prepare(`UPDATE artifacts SET save_state=?, needs_review=MAX(needs_review,?),
      revision=revision+1,updated_at=? WHERE id=?`).run(state, needsReview ? 1 : 0, new Date().toISOString(), id);
    const record = this.get(id);
    if (!record) throw new Error('ARTIFACT_NOT_FOUND');
    return record;
  }

  completePublication(publication: PublicationRecord, needsReview = false): ArtifactRecord {
    return this.db.transaction(() => {
      const record = this.setSaveState(publication.artifactId, 'saved', needsReview);
      this.setPhase(publication.id, 'registered');
      this.appendActivity(record, 'artifact.saved');
      return record;
    })();
  }

  markAttemptReview(attemptId: string): void {
    this.db.transaction(() => {
      const records = (this.db.prepare('SELECT * FROM artifacts WHERE attempt_id=? AND needs_review=0').all(attemptId) as Row[]).map(fromRow);
      for (const record of records) {
        this.setSaveState(record.id, record.saveState, true);
        this.appendActivity(this.get(record.id)!, 'artifact.review_required');
      }
    })();
  }

  committedAcceptance(options: ArtifactAcceptanceRequest): ArtifactRecord | null {
    const prior = this.db.prepare('SELECT * FROM artifact_accept_requests WHERE request_id=?').get(options.requestId) as Row | undefined;
    if (!prior) return null;
    if (prior.artifact_id !== options.artifactId || prior.accepted !== (options.accepted ? 1 : 0)
      || prior.expected_revision !== options.expectedRevision) throw new Error('ARTIFACT_REQUEST_CONFLICT');
    return JSON.parse(String(prior.result_json)) as ArtifactRecord;
  }

  accept(options: ArtifactAcceptanceRequest): ArtifactRecord {
    return this.db.transaction(() => {
      const prior = this.committedAcceptance(options);
      if (prior) return prior;
      const record = this.get(options.artifactId);
      if (!record) throw new Error('ARTIFACT_NOT_FOUND');
      if (options.accepted && record.saveState !== 'saved') throw new Error('ARTIFACT_NOT_SAVED');
      const now = new Date().toISOString();
      const changes = this.db.prepare(`UPDATE artifacts SET acceptance_state=?,revision=revision+1,updated_at=?
        WHERE id=? AND revision=? ${options.accepted ? "AND save_state='saved'" : ''}`).run(options.accepted ? 'accepted' : 'rejected', now,
          options.artifactId, options.expectedRevision).changes;
      if (changes !== 1) throw Object.assign(new Error('STALE_REVISION'), { currentRevision: this.get(options.artifactId)?.revision });
      const result = this.get(options.artifactId)!;
      this.appendActivity(result, options.accepted ? 'artifact.accepted' : 'artifact.rejected');
      this.db.prepare(`INSERT INTO artifact_accept_requests(request_id,artifact_id,accepted,expected_revision,result_json,created_at)
        VALUES(?,?,?,?,?,?)`).run(options.requestId, options.artifactId, options.accepted ? 1 : 0,
          options.expectedRevision, JSON.stringify(result), now);
      return result;
    })();
  }

  protectedPaths(): string[] {
    const rows = this.db.prepare(`SELECT source_path AS path FROM artifacts UNION SELECT path FROM artifacts
      UNION SELECT source_path AS path FROM artifact_publish_journal UNION SELECT target_path AS path FROM artifact_publish_journal
      UNION SELECT staging_path AS path FROM artifact_publish_journal`).all() as Array<{ path: string }>;
    return rows.map((row) => row.path).filter(Boolean);
  }
}
