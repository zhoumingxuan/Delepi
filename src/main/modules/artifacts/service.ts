import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ArtifactRepository, type ArtifactOrigin, type ArtifactRecord, type PublicationRecord } from '../../db/repositories/artifact.repo';
import { assertLocalAbsolutePath, assertNoSymlinks, inspectArtifactFile } from './files';
import { openVerifiedArtifact, usesExternalDocumentViewer } from './preview';
import { createLegacyArtifactIndexer } from './legacy-index';
export type { LegacyArtifactIndexResult } from './legacy-index';

export type { ArtifactOrigin } from '../../db/repositories/artifact.repo';
export type ArtifactDto = Omit<ArtifactRecord, 'sourcePath' | 'path'>;
export interface ArtifactCopyOptions { artifactOrigin?: ArtifactOrigin; signal?: AbortSignal }
export interface ArtifactRegistrationOptions extends ArtifactCopyOptions {
  conversationId?: string;
  /** Main-process-only synchronous provenance registration in the same artifact transaction. */
  onRegisteredInTransaction?: (record: ArtifactRecord) => void;
}
export interface ArtifactListOptions { conversationId?: string; runId?: string; limit?: number; cursor?: string }
let wakeListener: (() => void) | undefined;
export function setArtifactWakeListener(listener: (() => void) | undefined): void { wakeListener = listener; }
function wake(): void { try { wakeListener?.(); } catch { /* Advisory wake cannot replace committed facts. */ } }

export function toArtifactDto(record: ArtifactRecord): ArtifactDto {
  const { sourcePath: _sourcePath, path: _path, ...dto } = record;
  return dto;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('ARTIFACT_CANCELLED');
}
function safeName(filename: string): string {
  return path.basename(filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'artifact';
}
async function exists(value: string): Promise<boolean> {
  try { await lstat(value); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function removeVerifiedStage(stagingPath: string, dev: number, ino: number): Promise<boolean> {
  try {
    await assertNoSymlinks(stagingPath);
    const stat = await lstat(stagingPath);
    if (!stat.isFile() || stat.dev !== dev || stat.ino !== ino) return false;
    await unlink(stagingPath); return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function checkOutputAncestorsBeforeCreation(output: string): Promise<void> {
  let existing = output;
  while (!await exists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('ARTIFACT_OUTPUT_INVALID');
    existing = parent;
  }
  await assertNoSymlinks(existing);
  if (!(await lstat(existing)).isDirectory()) throw new Error('ARTIFACT_OUTPUT_NOT_DIRECTORY');
}

export class ArtifactService {
  constructor(readonly repository = new ArtifactRepository()) {}

  async list(options: ArtifactListOptions = {}): Promise<{ items: ArtifactDto[]; nextCursor?: string }> {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 40)));
    const rows = this.repository.list({ ...options, limit });
    return { items: rows.slice(0, limit).map(toArtifactDto), ...(rows.length > limit ? { nextCursor: rows[limit - 1].id } : {}) };
  }

  async get(id: string): Promise<ArtifactDto | null> {
    const record = this.repository.get(id);
    return record ? toArtifactDto(record) : null;
  }

  private async verify(record: ArtifactRecord, readBytes = false): Promise<Awaited<ReturnType<typeof inspectArtifactFile>>> {
    if (record.saveState !== 'saved') throw new Error('ARTIFACT_NOT_SAVED');
    try {
      const file = await inspectArtifactFile(record.path, readBytes ? { readBytes: true, maxBytes: 12 * 1024 * 1024 } : {});
      if (file.contentHash !== record.contentHash || file.sizeBytes !== record.sizeBytes) throw new Error('ARTIFACT_HASH_CHANGED');
      const identity = this.repository.publicationIdentity(record.id);
      if (!identity || identity.dev !== file.dev || identity.ino !== file.ino) throw new Error('ARTIFACT_IDENTITY_CHANGED');
      return file;
    } catch (error) {
      if (error instanceof Error && error.message === 'ARTIFACT_PREVIEW_TOO_LARGE') throw error;
      this.repository.setSaveState(record.id, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'quarantined', true);
      throw error;
    }
  }

  async open(id: string): Promise<void> {
    const record = this.repository.get(id);
    if (!record) throw new Error('ARTIFACT_NOT_FOUND');
    const file = await this.verify(record, !usesExternalDocumentViewer(record.path));
    await openVerifiedArtifact(file, record.title);
  }

  async accept(options: { artifactId: string; expectedRevision: number; accepted: boolean; requestId: string }): Promise<ArtifactDto> {
    if (!options.requestId || options.requestId.length > 200 || !Number.isInteger(options.expectedRevision)
      || typeof options.accepted !== 'boolean') throw new Error('ARTIFACT_INPUT_INVALID');
    // Replaying an acknowledged mutation returns its original receipt, without fresh IO or mutations.
    const prior = this.repository.committedAcceptance(options);
    if (prior) return toArtifactDto(prior);
    const record = this.repository.get(options.artifactId);
    if (!record) throw new Error('ARTIFACT_NOT_FOUND');
    if (record.revision !== options.expectedRevision) throw Object.assign(new Error('STALE_REVISION'), { currentRevision: record.revision });
    if (options.accepted) await this.verify(record);
    const result = toArtifactDto(this.repository.accept(options)); wake(); return result;
  }

  async registerExisting(sourcePath: string, options: ArtifactRegistrationOptions = {}): Promise<ArtifactRecord> {
    checkCancelled(options.signal);
    if (options.artifactOrigin) this.repository.assertOrigin(options.artifactOrigin);
    const file = await inspectArtifactFile(sourcePath);
    const origin = options.artifactOrigin;
    const id = createHash('sha256').update(JSON.stringify([origin?.attemptId ?? 'legacy', file.path, file.contentHash,
      file.dev, file.ino, options.conversationId ?? origin?.conversationId ?? ''])).digest('hex');
    const existing = this.repository.get(id);
    if (existing) {
      if(options.onRegisteredInTransaction)throw new Error('ARTIFACT_REGISTRATION_ALREADY_EXISTS');
      return existing;
    }
    const now = new Date().toISOString();
    const record: ArtifactRecord = { id, runId: origin?.runId, attemptId: origin?.attemptId,
      conversationId: origin?.conversationId ?? options.conversationId, sourcePath: file.path, path: file.path,
      title: path.basename(file.path), contentHash: file.contentHash, sizeBytes: file.sizeBytes,
      saveState: 'saved', validationState: 'pending', acceptanceState: 'unreviewed', needsReview: !origin,
      revision: 1, createdAt: now, updatedAt: now };
    this.repository.begin(record, { id: randomUUID(), artifactId: id, sourcePath: file.path, targetPath: file.path,
      stagingPath: '', expectedHash: file.contentHash, sizeBytes: file.sizeBytes, fileDev: file.dev, fileIno: file.ino,
      phase: 'registered', createdAt: now, updatedAt: now }, origin, options.onRegisteredInTransaction);
    wake();
    if (options.signal?.aborted) this.repository.markAttemptReview(origin?.attemptId ?? '');
    checkCancelled(options.signal);
    return record;
  }

  async publish(sourcePath: string, outputDir: string | undefined, options: ArtifactCopyOptions = {}): Promise<string> {
    checkCancelled(options.signal);
    if (options.artifactOrigin) this.repository.assertOrigin(options.artifactOrigin);
    if (!outputDir) return (await this.registerExisting(sourcePath, options)).path;
    const source = await inspectArtifactFile(sourcePath);
    const output = assertLocalAbsolutePath(outputDir);
    await checkOutputAncestorsBeforeCreation(output);
    await mkdir(output, { recursive: true });
    const canonicalOutput = await assertNoSymlinks(output);
    const outputStat = await lstat(canonicalOutput);
    if (!outputStat.isDirectory()) throw new Error('ARTIFACT_OUTPUT_NOT_DIRECTORY');
    const relative = path.relative(canonicalOutput, source.path);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return (await this.registerExisting(source.path, options)).path;
    }
    const originalName = safeName(path.basename(source.path));
    const extension = path.extname(originalName); const basename = path.basename(originalName, extension);
    let target = path.join(canonicalOutput, originalName); let count = 1;
    while (await exists(target)) target = path.join(canonicalOutput, `${basename}(${count++})${extension}`);
    const id = randomUUID(); const stagingPath = path.join(canonicalOutput, `.delepi-artifact-${id}.staging`);
    const now = new Date().toISOString(); const origin = options.artifactOrigin;
    const record: ArtifactRecord = { id, runId: origin?.runId, attemptId: origin?.attemptId, conversationId: origin?.conversationId,
      sourcePath: source.path, path: target, title: path.basename(target), contentHash: source.contentHash, sizeBytes: source.sizeBytes,
      saveState: 'staging', validationState: 'pending', acceptanceState: 'unreviewed', needsReview: !origin,
      revision: 1, createdAt: now, updatedAt: now };
    const publication: PublicationRecord = { id: randomUUID(), artifactId: id, sourcePath: source.path, targetPath: target,
      stagingPath, expectedHash: source.contentHash, sizeBytes: source.sizeBytes, phase: 'intent', createdAt: now, updatedAt: now };
    this.repository.begin(record, publication, origin);
    try {
      checkCancelled(options.signal);
      await copyFile(source.path, stagingPath, constants.COPYFILE_EXCL);
      const staged = await inspectArtifactFile(stagingPath);
      if (staged.contentHash !== source.contentHash || staged.sizeBytes !== source.sizeBytes) throw new Error('ARTIFACT_SOURCE_CHANGED');
      this.repository.setStagedIdentity(publication.id, staged.dev, staged.ino);
      checkCancelled(options.signal);
      // Atomic no-overwrite publication on the same volume. Keep the stage until DB registration succeeds.
      for (let collision = 0; ; collision++) {
        checkCancelled(options.signal);
        if (origin) this.repository.assertOrigin(origin);
        if (await assertNoSymlinks(output) !== canonicalOutput) throw new Error('ARTIFACT_OUTPUT_CHANGED');
        const currentOutput = await lstat(canonicalOutput);
        if (currentOutput.dev !== outputStat.dev || currentOutput.ino !== outputStat.ino) throw new Error('ARTIFACT_OUTPUT_CHANGED');
        try { await link(stagingPath, target); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (collision >= 128) throw new Error('ARTIFACT_OUTPUT_CONFLICT');
          const nextTarget = path.join(canonicalOutput, `${basename}(${count++})${extension}`);
          this.repository.retargetStagedPublication(publication.id, id, nextTarget);
          target = nextTarget; publication.targetPath = target;
        }
      }
      this.repository.setPhase(publication.id, 'published');
      const published = await inspectArtifactFile(target);
      if (published.contentHash !== source.contentHash || published.dev !== staged.dev || published.ino !== staged.ino) {
        throw new Error('ARTIFACT_PUBLISH_CHANGED');
      }
      this.repository.completePublication(publication, Boolean(options.signal?.aborted) || !origin);
      wake();
      if (!await removeVerifiedStage(stagingPath, staged.dev, staged.ino)) {
        this.repository.setSaveState(id, 'saved', true);
      }
      checkCancelled(options.signal);
      return target;
    } catch (error) {
      if (this.repository.get(id)?.saveState === 'saved') {
        if (origin) this.repository.markAttemptReview(origin.attemptId);
        else this.repository.setSaveState(id, 'saved', true);
        throw error;
      }
      const targetExists = await exists(target).catch(() => true);
      // Preserve bytes and journal after ambiguity; startup will verify ownership/hash, never blindly replay copy.
      this.repository.setPhase(publication.id, targetExists ? 'needs_review' : 'failed', options.signal?.aborted ? 'cancelled' : 'publish_failed');
      this.repository.setSaveState(id, targetExists ? 'staging' : 'failed', true);
      throw error;
    }
  }

  async reconcile(): Promise<{ saved: number; needsReview: number; failed: number }> {
    const counts = { saved: 0, needsReview: 0, failed: 0 };
    for (const publication of this.repository.publications()) {
      const record = this.repository.get(publication.artifactId);
      if (!record) { counts.failed++; continue; }
      try {
        const target = await inspectArtifactFile(publication.targetPath);
        if (target.contentHash !== publication.expectedHash || target.sizeBytes !== publication.sizeBytes) throw new Error('ARTIFACT_HASH_CHANGED');
        const owned = publication.fileDev !== undefined && publication.fileIno !== undefined
          && target.dev === publication.fileDev && target.ino === publication.fileIno;
        if (!owned) throw new Error('ARTIFACT_PUBLICATION_UNCONFIRMED');
        let review = record.needsReview || publication.phase !== 'registered';
        if (record.attemptId) {
          const attempt = this.repository.db.prepare('SELECT state FROM task_attempts WHERE id=?').get(record.attemptId) as { state: string } | undefined;
          review ||= !attempt || ['failed', 'cancelled', 'interrupted', 'stop_requested'].includes(attempt.state);
        }
        if (record.saveState !== 'saved' || publication.phase !== 'registered') this.repository.completePublication(publication, review);
        else if (review && !record.needsReview) this.repository.markAttemptReview(record.attemptId ?? '');
        // Registered stage bytes remain protected until this verified cleanup, source/target are never removed.
        if (publication.stagingPath && !await removeVerifiedStage(publication.stagingPath, target.dev, target.ino)) {
          review = true; this.repository.setSaveState(record.id, 'saved', true);
        }
        counts.saved++; if (review) counts.needsReview++;
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        this.repository.setSaveState(record.id, missing ? (record.saveState === 'saved' ? 'missing' : 'failed') : 'quarantined', true);
        this.repository.setPhase(publication.id, 'needs_review', missing ? 'missing_file' : 'integrity_failed');
        counts.failed++; counts.needsReview++;
      }
    }
    wake();
    return counts;
  }
}

const service = new ArtifactService();
export const listArtifacts = (options?: ArtifactListOptions) => service.list(options);
export const getArtifact = (id: string) => service.get(id);
export const openArtifact = (id: string) => service.open(id);
export const acceptArtifact = (options: Parameters<ArtifactService['accept']>[0]) => service.accept(options);
export const publishArtifactFile = (source: string, output?: string, options?: ArtifactCopyOptions) => service.publish(source, output, options);
export const registerExistingArtifact = (source: string, options?: ArtifactRegistrationOptions) => service.registerExisting(source, options);
export const reconcileArtifactPublications = () => service.reconcile();
export const getProtectedTaskPaths = () => service.repository.protectedPaths();
export const markArtifactAttemptReview = (attemptId: string) => { service.repository.markAttemptReview(attemptId); wake(); };
/** Explicit trusted UI action; no path argument, no startup-wide scan. */
export const indexLegacyArtifacts = createLegacyArtifactIndexer((source) => service.registerExisting(source));
