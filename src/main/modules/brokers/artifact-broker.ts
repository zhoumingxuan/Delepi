import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { PublicResource } from '@shared/types/autonomy';
import { ArtifactService, toArtifactDto, type ArtifactDto } from '../artifacts/service';
import { ArtifactRepository } from '../../db/repositories/artifact.repo';
import { assertLocalAbsolutePath } from '../artifacts/files';
import { permissionId } from '../permissions/permission-validation';
import { appendAutonomyAudit } from '../goals/autonomy-store';
import { BrokerError, type BrokerSession } from './contracts';
import { publicFileScope, pinnedPublicUrl, writePublicBytes, markPublicWriteRegistered, markPublicWriteReview, type PublicFileScope } from './file-broker';

function provenance(db: Database.Database, scope: PublicFileScope, refs: string[]): void {
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 32 || new Set(refs).size !== refs.length) throw new BrokerError('PUBLIC_PROVENANCE_INVALID');
  for (const ref of refs) {
    const row = db.prepare('SELECT goal_id,data_scope_id,kind,parent_id FROM m2_resources WHERE id=?').get(permissionId(ref)) as { goal_id: string; data_scope_id: string; kind: string; parent_id: string | null } | undefined;
    if (!row || row.goal_id !== scope.goalId || row.data_scope_id !== scope.dataScopeId || row.kind !== 'public_snapshot' || !row.parent_id) throw new BrokerError('PUBLIC_PROVENANCE_INVALID');
    pinnedPublicUrl(db, scope, row.parent_id);
  }
}
export function createArtifactBroker(db: Database.Database, options: { artifactRoot: string; artifactService?: ArtifactService; uuid?: () => string; now?: () => string }) {
  const root = assertLocalAbsolutePath(options.artifactRoot), uuid = options.uuid ?? randomUUID;
  const service = options.artifactService ?? new ArtifactService(new ArtifactRepository(() => db));
  if (service.repository.db !== db) throw new BrokerError('ARTIFACT_DATABASE_MISMATCH');
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async publish(session: BrokerSession, input: { anchorRef: string; text: string; sourceRefs: string[] }): Promise<ArtifactDto> {
      if (!input || !Array.isArray(input.sourceRefs)) throw new BrokerError('PUBLIC_PROVENANCE_INVALID');
      const scope = publicFileScope(db, session), refs = [...input.sourceRefs];
      const anchor = db.prepare('SELECT * FROM m2_resources WHERE id=?').get(permissionId(input.anchorRef)) as {
        id: string; goal_id: string; data_scope_id: string; kind: string; file_path: string | null; parent_id: string | null; content_hash: string; revision: number;
      } | undefined;
      const pin: PublicResource | undefined = scope.resources.find(r => r.id === anchor?.id);
      if (!anchor || anchor.goal_id !== scope.goalId || anchor.data_scope_id !== scope.dataScopeId || anchor.kind !== 'artifact'
        || anchor.file_path !== null || anchor.parent_id !== null || !pin || pin.kind !== 'artifact' || pin.revision !== anchor.revision
        || pin.contentHash !== anchor.content_hash) throw new BrokerError('PUBLIC_OUTPUT_SCOPE_INVALID');
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.includes('\0')) throw new BrokerError('PUBLIC_ARTIFACT_INPUT_INVALID');
      const bytes = Buffer.from(input.text, 'utf8');
      if (bytes.length > scope.limits.maxDocumentBytes || bytes.length > scope.limits.storageBytes) throw new BrokerError('PUBLIC_ARTIFACT_TOO_LARGE');
      provenance(db, scope, refs);
      const payloadHash = createHash('sha256').update(bytes).digest('hex');
      const op = await session.prepare({ capability: 'artifact.publish', resourceRef: anchor.id, resourceVersion: `${anchor.revision}:${anchor.content_hash}`,
        payloadHash, summary: '保存本轮公开资料总结，等待验证与用户确认', units: { modelRequests: 0, fetchRequests: 0, downloadBytes: 0, storageBytes: bytes.length, tokenUnits: 0 } });
      const signal = AbortSignal.any([session.signal, op.signal]);
      let started = false, wroteFile = false, written = 0, receiptAttempted = false;
      try {
        return await session.withSlot(async () => {
        session.markStarted(op.leaseId); started = true;
        const file = await writePublicBytes(root, `${permissionId(uuid())}.md`, bytes, session, op.leaseId, { db, resourceRef: anchor.id });
        wroteFile = true; written = file.sizeBytes;
        const record = await service.registerExisting(file.path, {
          artifactOrigin: session.context, signal,
          onRegisteredInTransaction(record) {
            session.assertLease(op.leaseId);
            const fresh = publicFileScope(db, session); provenance(db, fresh, refs);
            const registeredIdentity = service.repository.publicationIdentity(record.id);
            if (fresh.goalRevision !== scope.goalRevision || record.contentHash !== payloadHash || record.sizeBytes !== bytes.length
              || record.path !== file.path || record.sourcePath !== file.path || registeredIdentity?.dev !== file.dev
              || registeredIdentity.ino !== file.ino) throw new BrokerError('PUBLIC_ARTIFACT_CHANGED');
            const at = now();
            // A publication keeps its original purpose grant. Later enabling learning
            // cannot retroactively admit an older report or a private artifact.
            const dataScope = db.prepare("SELECT classification,allowed_uses_json FROM m2_data_scopes WHERE id=? AND goal_id=?")
              .get(fresh.dataScopeId, fresh.goalId) as { classification: string; allowed_uses_json: string } | undefined;
            const uses: unknown = dataScope && JSON.parse(dataScope.allowed_uses_json);
            const artifactUses = ['artifact.view', 'artifact.export'];
            if (dataScope?.classification === 'public' && Array.isArray(uses) && uses.includes('learning.capture')) artifactUses.push('learning.capture');
            db.prepare('INSERT INTO m2_artifact_scopes(artifact_id,goal_id,data_scope_id,goal_revision,source_refs_json,allowed_uses_json,created_at) VALUES(?,?,?,?,?,?,?)')
              .run(record.id, scope.goalId, scope.dataScopeId, scope.goalRevision, JSON.stringify(refs), JSON.stringify(artifactUses), at);
            markPublicWriteRegistered(db, session, op.leaseId);
            appendAutonomyAudit(db, 'public.artifact.scoped', { resourceId: anchor.id, sourceCount: refs.length, bytes: bytes.length }, session.context, at);
          },
        });
        session.assertLease(op.leaseId);
        receiptAttempted = true; session.settle(op.leaseId, 'completed', { known: { storageBytes: written } });
        return toArtifactDto(record);
        }, op.signal);
      } catch (error) {
        written = Math.max(written, Number((error as { storageBytesWritten?: number }).storageBytesWritten ?? 0));
        wroteFile ||= !!(error as { wroteFile?: boolean }).wroteFile;
        markPublicWriteReview(db, op.operationId);
        if (receiptAttempted) throw new BrokerError('OPERATION_RECEIPT_UNKNOWN');
        try { session.settle(op.leaseId, wroteFile ? 'unknown' : !started ? 'not_started' : signal.aborted ? 'cancelled' : 'failed', { known: { storageBytes: written } }); }
        catch { throw new BrokerError('OPERATION_RECEIPT_UNKNOWN'); }
        throw new BrokerError(signal.aborted ? 'CANCELLED' : error instanceof BrokerError ? error.code : wroteFile ? 'PUBLIC_ARTIFACT_RECEIPT_UNKNOWN' : 'PUBLIC_ARTIFACT_WRITE_FAILED');
      }
    },
  };
}
export type ArtifactBroker = ReturnType<typeof createArtifactBroker>;
