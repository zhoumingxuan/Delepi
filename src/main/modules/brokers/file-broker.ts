import type Database from 'better-sqlite3';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { ExplorationLimits, PublicAction, PublicResource } from '@shared/types/autonomy';
import { assertLocalAbsolutePath, assertNoSymlinks, inspectArtifactFile } from '../artifacts/files';
import { getPublicRunBinding, appendAutonomyAudit } from '../goals/autonomy-store';
import { permissionId } from '../permissions/permission-validation';
import { BrokerError, type BrokerSession, type PublicDocument } from './contracts';

interface ResourceRow {
  id: string; goal_id: string; data_scope_id: string; kind: PublicResource['kind']; url: string | null;
  file_path: string | null; content_hash: string; size_bytes: number; revision: number; parent_id: string | null;
}
interface FileIdentity { file_dev: number; file_ino: number; parent_dev: number; parent_ino: number }
export interface PublicFileScope {
  goalId: string; dataScopeId: string; goalRevision: number; limits: ExplorationLimits;
  resources: PublicResource[];
}
export function publicFileScope(db: Database.Database, session: BrokerSession): PublicFileScope {
  const binding = getPublicRunBinding(db, session.context);
  const goal = db.prepare('SELECT revision,state FROM m2_goals WHERE id=?').get(binding.goal_id) as { revision: number; state: string } | undefined;
  if (!goal || goal.state !== 'active' || goal.revision !== binding.goal_revision) throw new BrokerError('PUBLIC_SCOPE_CHANGED');
  const snapshot = JSON.parse(binding.snapshot_json) as { resources: PublicResource[]; limits: ExplorationLimits };
  return { goalId: binding.goal_id, dataScopeId: binding.data_scope_id, goalRevision: binding.goal_revision,
    limits: snapshot.limits, resources: snapshot.resources };
}
function project(row: ResourceRow): PublicResource {
  return { id: row.id, goalId: row.goal_id, dataScopeId: row.data_scope_id, kind: row.kind,
    contentHash: row.content_hash, sizeBytes: row.size_bytes, revision: row.revision,
    ...(row.parent_id ? { parentId: row.parent_id } : {}), ...(row.url ? { url: row.url } : {}) };
}
function loadResource(db: Database.Database, scope: PublicFileScope, ref: string): ResourceRow {
  const row = db.prepare('SELECT * FROM m2_resources WHERE id=?').get(permissionId(ref)) as ResourceRow | undefined;
  if (!row || row.goal_id !== scope.goalId || row.data_scope_id !== scope.dataScopeId) throw new BrokerError('PUBLIC_RESOURCE_MISMATCH');
  return row;
}
export function pinnedPublicUrl(db: Database.Database, scope: PublicFileScope, ref: string): ResourceRow {
  const row = loadResource(db, scope, ref);
  const pin = scope.resources.find(r => r.id === row.id);
  if (row.kind !== 'public_url' || row.file_path !== null || !row.url || !pin || pin.kind !== 'public_url'
    || pin.revision !== row.revision || pin.contentHash !== row.content_hash || pin.url !== row.url) throw new BrokerError('PUBLIC_RESOURCE_CHANGED');
  return row;
}
function snapshotRow(db: Database.Database, scope: PublicFileScope, ref: string): ResourceRow {
  const row = loadResource(db, scope, ref);
  if (row.kind !== 'public_snapshot' || !row.file_path || !row.parent_id || !Number.isSafeInteger(row.size_bytes)
    || row.size_bytes < 0 || row.size_bytes > scope.limits.maxDocumentBytes) throw new BrokerError('PUBLIC_SNAPSHOT_INVALID');
  pinnedPublicUrl(db, scope, row.parent_id);
  return row;
}
function checkLive(session: BrokerSession, leaseId: string): void {
  if (session.signal.aborted) throw new BrokerError('CANCELLED');
  session.assertLease(leaseId);
}
function safeStat(stat: { dev: number; ino: number }): void {
  if (!Number.isSafeInteger(stat.dev) || stat.dev < 0 || !Number.isSafeInteger(stat.ino) || stat.ino < 0) throw new BrokerError('PUBLIC_FILE_IDENTITY_INVALID');
}
export function publicText(bytes: Buffer): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes('\0')) throw new Error();
    return text;
  } catch { throw new BrokerError('PUBLIC_DOCUMENT_ENCODING_INVALID'); }
}
/** A flat, main-process-owned directory. Call only under a started and live operation. */
export async function ensurePublicDirectory(root: string): Promise<{ dev: number; ino: number }> {
  let ancestor = root;
  for (;;) {
    try { await assertNoSymlinks(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BrokerError('PUBLIC_ROOT_INVALID');
      const next = path.dirname(ancestor); if (next === ancestor) throw new BrokerError('PUBLIC_ROOT_INVALID'); ancestor = next;
    }
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await assertNoSymlinks(root) !== root) throw new BrokerError('PUBLIC_ROOT_INVALID');
  const stat = await lstat(root); safeStat(stat);
  if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new BrokerError('PUBLIC_ROOT_INVALID');
  return { dev: stat.dev, ino: stat.ino };
}
/** New immutable bytes only. Failed DB receipt leaves the owned bytes available for review. */
export async function writePublicBytes(root: string, filename: string, bytes: Buffer, session: BrokerSession, leaseId: string, journal: { db: Database.Database; resourceRef: string }) {
  checkLive(session, leaseId);
  const operation = session.assertLease(leaseId), db = journal.db;
  const target = path.join(root, filename);
  if (path.dirname(target) !== root) throw new BrokerError('PUBLIC_FILE_PATH_INVALID');
  const expectedHash = createHash('sha256').update(bytes).digest('hex'), at = new Date().toISOString();
  db.transaction(() => {
    checkLive(session, leaseId);
    db.prepare("INSERT INTO m2_public_write_journal(operation_id,resource_ref,target_path,expected_hash,size_bytes,state,created_at,updated_at) VALUES(?,?,?,?,?,'intent',?,?)")
      .run(operation.operationId, journal.resourceRef, target, expectedHash, bytes.length, at, at);
  })();
  let written = 0, wroteFile = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let failure: BrokerError | undefined;
  try {
    const parent = await ensurePublicDirectory(root);
    checkLive(session, leaseId);
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    wroteFile = true;
    const identity = await handle.stat(); safeStat(identity);
    for (; written < bytes.length;) {
      checkLive(session, leaseId);
      const result = await handle.write(bytes, written, Math.min(65536, bytes.length - written), written);
      if (!result.bytesWritten) throw new BrokerError('PUBLIC_FILE_WRITE_FAILED');
      written += result.bytesWritten;
    }
    await handle.sync();
    checkLive(session, leaseId);
    const current = await lstat(target), currentParent = await lstat(root), after = await handle.stat();
    if (await assertNoSymlinks(target) !== target || current.dev !== identity.dev || current.ino !== identity.ino
      || after.size !== bytes.length || current.size !== bytes.length || currentParent.dev !== parent.dev
      || currentParent.ino !== parent.ino) throw new BrokerError('PUBLIC_FILE_IDENTITY_CHANGED');
    db.transaction(() => {
      checkLive(session, leaseId);
      if (db.prepare("UPDATE m2_public_write_journal SET state='written',file_dev=?,file_ino=?,parent_dev=?,parent_ino=?,updated_at=? WHERE operation_id=? AND state='intent'")
        .run(identity.dev, identity.ino, parent.dev, parent.ino, new Date().toISOString(), operation.operationId).changes !== 1) throw new BrokerError('PUBLIC_WRITE_RECEIPT_CONFLICT');
    })();
    return { path: target, dev: identity.dev, ino: identity.ino, parentDev: parent.dev, parentIno: parent.ino, sizeBytes: written };
  } catch (error) {
    try { db.prepare("UPDATE m2_public_write_journal SET state='review_required',updated_at=? WHERE operation_id=? AND state!='registered'").run(new Date().toISOString(), operation.operationId); } catch { /* The already committed intent remains the review locator. */ }
    failure = Object.assign(new BrokerError(session.signal.aborted ? 'CANCELLED' : error instanceof BrokerError ? error.code : 'PUBLIC_FILE_WRITE_FAILED'), { storageBytesWritten: written, wroteFile });
    throw failure;
  } finally {
    try { await handle?.close(); }
    catch {
      markPublicWriteReview(db, operation.operationId);
      if (!failure) throw Object.assign(new BrokerError('PUBLIC_FILE_CLOSE_FAILED'), { storageBytesWritten: written, wroteFile });
      // The primary error already contains the confirmed write evidence; a secondary close
      // error cannot replace it with an unmetered raw filesystem exception.
    }
  }
}
export function markPublicWriteRegistered(db: Database.Database, session: BrokerSession, leaseId: string): void {
  if (!db.inTransaction) throw new BrokerError('PUBLIC_WRITE_TRANSACTION_REQUIRED');
  const op = session.assertLease(leaseId);
  if (db.prepare("UPDATE m2_public_write_journal SET state='registered',updated_at=? WHERE operation_id=? AND state='written'")
    .run(new Date().toISOString(), op.operationId).changes !== 1) throw new BrokerError('PUBLIC_WRITE_RECEIPT_CONFLICT');
}
export function markPublicWriteReview(db: Database.Database, operationId: string): void {
  try { db.prepare("UPDATE m2_public_write_journal SET state='review_required',updated_at=? WHERE operation_id=? AND state!='registered'").run(new Date().toISOString(), operationId); }
  catch { /* Committed intent/written identity remains; never erase bytes or pretend registration. */ }
}
/** Startup evidence review only: never replays writes, registers an artifact, or removes bytes. */
export async function reconcilePublicWrites(db: Database.Database, options: { publicRoots: string[] }) {
  const roots = new Set(options.publicRoots.map(assertLocalAbsolutePath));
  const rows = db.prepare("SELECT * FROM m2_public_write_journal WHERE state!='registered' ORDER BY created_at,operation_id").all() as Array<{
    operation_id: string; target_path: string; expected_hash: string; size_bytes: number;
    file_dev: number | null; file_ino: number | null; parent_dev: number | null; parent_ino: number | null;
  }>;
  const counts = { reviewRequired: rows.length, integrityConfirmed: 0, missing: 0, unconfirmed: 0 };
  for (const row of rows) {
    markPublicWriteReview(db, row.operation_id);
    if (!roots.has(path.dirname(row.target_path)) || !/^[A-Za-z0-9_-]+\.(txt|md)$/.test(path.basename(row.target_path))
      || !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0 || row.size_bytes > 1024 * 1024) { counts.unconfirmed++; continue; }
    try {
      const parent = await lstat(path.dirname(row.target_path));
      if (row.file_dev === null || row.file_ino === null || parent.dev !== row.parent_dev || parent.ino !== row.parent_ino) {
        counts.unconfirmed++; continue;
      }
      const file = await inspectArtifactFile(row.target_path, { maxBytes: row.size_bytes });
      if (file.dev !== row.file_dev || file.ino !== row.file_ino || file.sizeBytes !== row.size_bytes || file.contentHash !== row.expected_hash) {
        counts.unconfirmed++; continue;
      }
      counts.integrityConfirmed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') counts.missing++; else counts.unconfirmed++;
    }
  }
  return counts;
}

export function createFileBroker(db: Database.Database, options: { publicRoot: string; uuid?: () => string; now?: () => string }) {
  const root = assertLocalAbsolutePath(options.publicRoot);
  const uuid = options.uuid ?? randomUUID, now = options.now ?? (() => new Date().toISOString());
  const minted = new WeakMap<PublicDocument, { runId: string; goalRevision: number }>();
  const service = {
    async registerSnapshot(session: BrokerSession, parentRef: string, incoming: Buffer, mime: string, url: string, leaseId: string): Promise<PublicResource> {
      checkLive(session, leaseId);
      const operationLease = session.assertLease(leaseId);
      const scope = publicFileScope(db, session), parent = pinnedPublicUrl(db, scope, parentRef);
      if (!Buffer.isBuffer(incoming) || incoming.length > scope.limits.maxDocumentBytes || url !== parent.url
        || !/^(text\/(plain|html)|application\/(json|[a-z0-9.+-]+\+json))(?:\s*;.*)?$/i.test(mime)) throw new BrokerError('PUBLIC_SNAPSHOT_INPUT_INVALID');
      const bytes = Buffer.from(incoming); publicText(bytes);
      const operation = db.prepare("SELECT o.intent_json,o.state FROM m2_operations o JOIN m2_leases l ON l.operation_id=o.id WHERE l.id=?").get(leaseId) as { intent_json: string; state: string } | undefined;
      const action = operation && JSON.parse(operation.intent_json) as PublicAction | undefined;
      if (!action || operation?.state !== 'started' || action.capability !== 'fetch.public' || action.resourceRef !== parent.id
        || action.resourceVersion !== `${parent.revision}:${parent.content_hash}` || action.units.storageBytes < bytes.length) throw new BrokerError('PUBLIC_SNAPSHOT_LEASE_MISMATCH');
      const id = permissionId(uuid()), contentHash = createHash('sha256').update(bytes).digest('hex');
      const file = await writePublicBytes(root, `${id}.txt`, bytes, session, leaseId, { db, resourceRef: parentRef });
      try {
        // Closing the writer is an async boundary. Revalidate the actual immutable bytes
        // before committing a "registered" fact, including same-content inode swaps.
        checkLive(session, leaseId);
        const persisted = await inspectArtifactFile(file.path, { maxBytes: bytes.length });
        const parentDirectory = await lstat(root);
        if (persisted.path !== file.path || persisted.dev !== file.dev || persisted.ino !== file.ino
          || persisted.contentHash !== contentHash || persisted.sizeBytes !== bytes.length
          || parentDirectory.dev !== file.parentDev || parentDirectory.ino !== file.parentIno) throw new BrokerError('PUBLIC_SNAPSHOT_CHANGED');
        return db.transaction(() => {
          checkLive(session, leaseId);
          const fresh = publicFileScope(db, session); pinnedPublicUrl(db, fresh, parentRef);
          const at = now();
          db.prepare("INSERT INTO m2_resources(id,goal_id,data_scope_id,kind,url,file_path,content_hash,size_bytes,revision,parent_id,created_at) VALUES(?,?,?,'public_snapshot',?,?,?, ?,1,?,?)")
            .run(id, scope.goalId, scope.dataScopeId, url, file.path, contentHash, bytes.length, parentRef, at);
          db.prepare('INSERT INTO m2_public_file_identity(resource_id,file_dev,file_ino,parent_dev,parent_ino,created_at) VALUES(?,?,?,?,?,?)')
            .run(id, file.dev, file.ino, file.parentDev, file.parentIno, at);
          markPublicWriteRegistered(db, session, leaseId);
          appendAutonomyAudit(db, 'public.snapshot.saved', { resourceId: id, bytes: bytes.length }, session.context, at);
          return project(loadResource(db, scope, id));
        })();
      } catch (error) {
        markPublicWriteReview(db, operationLease.operationId);
        throw Object.assign(new BrokerError(session.signal.aborted ? 'CANCELLED' : 'PUBLIC_SNAPSHOT_RECEIPT_UNKNOWN'), { storageBytesWritten: bytes.length, wroteFile: true });
      }
    },
    async read(session: BrokerSession, resourceRef: string): Promise<PublicDocument> {
      const scope = publicFileScope(db, session), row = snapshotRow(db, scope, resourceRef);
      const filePath = path.join(root, `${row.id}.txt`);
      if (row.file_path !== filePath) throw new BrokerError('PUBLIC_FILE_PATH_INVALID');
      const identity = db.prepare('SELECT * FROM m2_public_file_identity WHERE resource_id=?').get(row.id) as FileIdentity | undefined;
      if (!identity) throw new BrokerError('PUBLIC_FILE_IDENTITY_MISSING');
      const op = await session.prepare({ capability: 'file.read_public', resourceRef: row.id, resourceVersion: `${row.revision}:${row.content_hash}`,
        summary: '读取本轮已登记的公开资料快照', units: { modelRequests: 0, fetchRequests: 0, downloadBytes: 0, storageBytes: 0, tokenUnits: 0 } });
      const signal = AbortSignal.any([session.signal, op.signal]);
      let started = false, consumed = 0, receiptAttempted = false;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        return await session.withSlot(async () => {
        session.markStarted(op.leaseId); started = true; checkLive(session, op.leaseId);
        if (signal.aborted) throw new BrokerError('CANCELLED');
        const canonical = await assertNoSymlinks(filePath), parent = await lstat(root);
        if (canonical !== filePath || !parent.isDirectory() || parent.dev !== identity.parent_dev || parent.ino !== identity.parent_ino) throw new BrokerError('PUBLIC_FILE_IDENTITY_CHANGED');
        checkLive(session, op.leaseId);
        handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const before = await handle.stat();
        if (!before.isFile() || before.dev !== identity.file_dev || before.ino !== identity.file_ino || before.size !== row.size_bytes) throw new BrokerError('PUBLIC_FILE_IDENTITY_CHANGED');
        const bytes = Buffer.alloc(row.size_bytes), hash = createHash('sha256');
        for (; consumed < bytes.length;) {
          if (signal.aborted) throw new BrokerError('CANCELLED'); checkLive(session, op.leaseId);
          const part = await handle.read(bytes, consumed, Math.min(65536, bytes.length - consumed), consumed);
          if (!part.bytesRead) throw new BrokerError('PUBLIC_FILE_IDENTITY_CHANGED');
          hash.update(bytes.subarray(consumed, consumed + part.bytesRead)); consumed += part.bytesRead;
        }
        const after = await handle.stat(), current = await lstat(canonical), currentParent = await lstat(root);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
          || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || currentParent.dev !== parent.dev
          || currentParent.ino !== parent.ino || await assertNoSymlinks(canonical) !== canonical || hash.digest('hex') !== row.content_hash) throw new BrokerError('PUBLIC_FILE_IDENTITY_CHANGED');
        checkLive(session, op.leaseId); snapshotRow(db, publicFileScope(db, session), resourceRef);
        const text = publicText(bytes);
        await handle.close(); handle = undefined;
        db.transaction(() => appendAutonomyAudit(db, 'public.snapshot.read', { resourceId: row.id, bytes: consumed }, session.context))();
        receiptAttempted = true; session.settle(op.leaseId, 'completed', {});
        const document: PublicDocument = Object.freeze({ resource: Object.freeze(project(row)), text, contentHash: row.content_hash, sizeBytes: consumed });
        minted.set(document, { runId: session.context.runId, goalRevision: scope.goalRevision });
        return document;
        }, op.signal);
      } catch (error) {
        if (handle) { try { await handle.close(); } catch { /* The failure still receives an authoritative terminal receipt. */ } handle = undefined; }
        if (receiptAttempted) throw new BrokerError('OPERATION_RECEIPT_UNKNOWN');
        try { session.settle(op.leaseId, !started ? 'not_started' : signal.aborted ? 'cancelled' : 'failed', {}); }
        catch { throw new BrokerError('OPERATION_RECEIPT_UNKNOWN'); }
        throw new BrokerError(signal.aborted ? 'CANCELLED' : error instanceof BrokerError ? error.code : 'PUBLIC_FILE_READ_FAILED');
      }
    },
    verifyDocument(session: BrokerSession, document: PublicDocument): void {
      const receipt = minted.get(document), scope = publicFileScope(db, session);
      if (!receipt || receipt.runId !== session.context.runId || receipt.goalRevision !== scope.goalRevision) throw new BrokerError('PUBLIC_DOCUMENT_NOT_MINTED');
      const row = snapshotRow(db, scope, document.resource.id);
      if (row.revision !== document.resource.revision || row.content_hash !== document.contentHash || row.size_bytes !== document.sizeBytes) throw new BrokerError('PUBLIC_DOCUMENT_CHANGED');
    },
  };
  return service;
}
export type FileBroker = ReturnType<typeof createFileBroker>;
