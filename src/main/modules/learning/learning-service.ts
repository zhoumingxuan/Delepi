import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { inspectArtifactFile } from '../artifacts/files';
import { canonicalPermissionJson, permissionId, permissionInteger } from '../permissions/permission-validation';
import { validateSourceUrl } from '../goals/goal-service';
import { candidateHash, extractCandidate, validateCandidate } from './candidate';
import { LearningError, LEARNING_PROMPT_INSTRUCTION, LEARNING_VALIDATOR_VERSION,
  type LearnedSkill, type LearningReceipt, type RollbackReceipt, type SkillCandidate } from './contracts';
export * from './contracts';

const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_CAPTURE_COUNT = 1000, MAX_CANDIDATE_COUNT = 500, MAX_STORED_BYTES = 8 * 1024 * 1024;
interface RunRow {
  run_id: string; goal_id: string; goal_revision: number; data_scope_id: string; artifact_id: string;
  snapshot_json: string; artifact_hash: string; artifact_path: string; artifact_size: number;
  file_dev: number; file_ino: number; parent_dev: number; parent_ino: number; source_refs_json: string;
  allowed_uses_json: string;
}
interface SourceEvidence { ref: string; url: string; contentHash: string; sizeBytes: number; }
interface SkillRow { id: string; goal_id: string; goal_revision: number; title: string; revision: number; active_version_id: string | null; updated_at: string; }
interface CandidateRow { id: string; skill_id: string; capture_id: string; content_json: string; content_hash: string; method_hash: string; status: string; validation_id: string; }
interface VersionRow { id: string; skill_id: string; ordinal: number; candidate_id: string; content_hash: string; prior_version_id: string | null; }

export function createLearningService(db: Database.Database, options: { now?: () => string; uuid?: () => string; wake?: () => void } = {}) {
  const now = options.now ?? (() => new Date().toISOString()), uuid = options.uuid ?? randomUUID;
  const wake = () => { try { options.wake?.(); } catch { /* Observation never changes a committed receipt. */ } };
  function scope(goalId: string, revision: number, use: 'learning.capture' | 'skill.context'): void {
    const row = db.prepare(`SELECT g.revision,g.state,s.classification,s.allowed_uses_json FROM m2_goals g
      JOIN m2_data_scopes s ON s.id=g.data_scope_id AND s.goal_id=g.id WHERE g.id=?`).get(goalId) as
      { revision: number; state: string; classification: string; allowed_uses_json: string } | undefined;
    if (!row || row.revision !== revision || row.state !== 'active' || row.classification !== 'public') throw new LearningError('LEARNING_SCOPE_CHANGED');
    let uses: unknown; try { uses = JSON.parse(row.allowed_uses_json); } catch { throw new LearningError('LEARNING_USE_DENIED'); }
    if (!Array.isArray(uses) || !uses.includes(use)) throw new LearningError('LEARNING_USE_DENIED');
  }
  function run(runId: string): RunRow {
    const row = db.prepare(`SELECT e.run_id,e.goal_id,s.goal_revision,s.data_scope_id,e.artifact_id,s.snapshot_json,
      a.content_hash AS artifact_hash,a.path AS artifact_path,a.size_bytes AS artifact_size,
      j.file_dev,j.file_ino,w.parent_dev,w.parent_ino,c.source_refs_json,c.allowed_uses_json
      FROM m2_exploration_sessions e JOIN m2_run_scopes s ON s.run_id=e.run_id AND s.mode='public'
      JOIN runs r ON r.id=e.run_id AND r.state='completed' AND r.owner_id=s.owner_id AND r.generation=s.generation
      JOIN artifacts a ON a.id=e.artifact_id AND a.run_id=e.run_id AND a.save_state='saved' AND a.needs_review=0 AND a.acceptance_state!='rejected'
      JOIN artifact_publish_journal j ON j.artifact_id=a.id AND j.phase='registered' AND j.expected_hash=a.content_hash AND j.size_bytes=a.size_bytes
      JOIN m2_artifact_scopes c ON c.artifact_id=a.id AND c.goal_id=e.goal_id AND c.data_scope_id=s.data_scope_id AND c.goal_revision=s.goal_revision
      JOIN m2_public_write_journal w ON w.target_path=a.path AND w.state='registered' AND w.expected_hash=a.content_hash AND w.size_bytes=a.size_bytes
      JOIN m2_operations o ON o.id=w.operation_id AND o.run_id=e.run_id AND o.state='settled' AND o.result_kind='completed'
      WHERE e.run_id=? AND e.state='completed' AND e.settled_at IS NOT NULL`).get(runId) as RunRow | undefined;
    if (!row || row.file_dev === null || row.file_ino === null || row.parent_dev === null || row.parent_ino === null
      || !Number.isSafeInteger(row.artifact_size) || row.artifact_size < 1 || row.artifact_size > MAX_REPORT_BYTES) throw new LearningError('LEARNING_RUN_NOT_ELIGIBLE');
    scope(row.goal_id, row.goal_revision, 'learning.capture');
    let uses: unknown; try { uses = JSON.parse(row.allowed_uses_json); } catch { throw new LearningError('LEARNING_USE_DENIED'); }
    if (!Array.isArray(uses) || !uses.includes('learning.capture')) throw new LearningError('LEARNING_USE_DENIED');
    return row;
  }
  async function evidence(row: RunRow): Promise<{ report: string; sources: SourceEvidence[] }> {
    const artifact = await inspectArtifactFile(row.artifact_path, { readBytes: true, maxBytes: MAX_REPORT_BYTES });
    const parent = await lstat(path.dirname(row.artifact_path));
    if (artifact.path !== row.artifact_path || artifact.contentHash !== row.artifact_hash || artifact.sizeBytes !== row.artifact_size
      || artifact.dev !== row.file_dev || artifact.ino !== row.file_ino || parent.dev !== row.parent_dev || parent.ino !== row.parent_ino) {
      throw new LearningError('LEARNING_ARTIFACT_CHANGED');
    }
    let refs: unknown, snapshot: { resources?: Array<{ id: string; kind: string; url?: string; revision: number; contentHash: string }> };
    try { refs = JSON.parse(row.source_refs_json); snapshot = JSON.parse(row.snapshot_json); } catch { throw new LearningError('LEARNING_PROVENANCE_INVALID'); }
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > 8 || new Set(refs).size !== refs.length || !Array.isArray(snapshot.resources)) {
      throw new LearningError('LEARNING_PROVENANCE_INVALID');
    }
    const sources: SourceEvidence[] = [];
    for (const ref of refs) {
      const source = db.prepare(`SELECT p.id,p.url,p.file_path,p.content_hash,p.size_bytes,p.revision,
        u.id AS parent_id,u.url AS parent_url,u.content_hash AS parent_hash,u.revision AS parent_revision,
        i.file_dev,i.file_ino,i.parent_dev,i.parent_ino
        FROM m2_resources p JOIN m2_resources u ON u.id=p.parent_id AND u.kind='public_url'
        AND u.goal_id=p.goal_id AND u.data_scope_id=p.data_scope_id
        JOIN m2_public_file_identity i ON i.resource_id=p.id
        WHERE p.id=? AND p.goal_id=? AND p.data_scope_id=? AND p.kind='public_snapshot'`).get(permissionId(ref), row.goal_id, row.data_scope_id) as
        { id: string; url: string; file_path: string; content_hash: string; size_bytes: number; revision: number;
          parent_id: string; parent_url: string; parent_hash: string; parent_revision: number;
          file_dev: number; file_ino: number; parent_dev: number; parent_ino: number } | undefined;
      const pin = source && snapshot.resources.find(value => value.id === source.parent_id && value.kind === 'public_url');
      if (!source || !pin || pin.url !== source.parent_url || pin.revision !== source.parent_revision || pin.contentHash !== source.parent_hash
        || source.url !== source.parent_url || validateSourceUrl(source.url) !== source.url || !Number.isSafeInteger(source.size_bytes)
        || source.size_bytes < 0 || source.size_bytes > MAX_REPORT_BYTES) throw new LearningError('LEARNING_PROVENANCE_INVALID');
      const read = db.prepare(`SELECT id FROM m2_operations WHERE run_id=? AND state='settled' AND result_kind='completed'
        AND json_extract(intent_json,'$.capability')='file.read_public' AND json_extract(intent_json,'$.resourceRef')=?
        AND json_extract(intent_json,'$.resourceVersion')=? LIMIT 1`).get(row.run_id, source.id, `${source.revision}:${source.content_hash}`);
      const written = db.prepare(`SELECT w.operation_id FROM m2_public_write_journal w JOIN m2_operations o ON o.id=w.operation_id
        WHERE o.run_id=? AND o.state='settled' AND o.result_kind='completed' AND json_extract(o.intent_json,'$.capability')='fetch.public'
        AND w.target_path=? AND w.state='registered' AND w.expected_hash=? AND w.size_bytes=? LIMIT 1`)
        .get(row.run_id, source.file_path, source.content_hash, source.size_bytes);
      if (!read || !written) throw new LearningError('LEARNING_PROVENANCE_INVALID');
      const actual = await inspectArtifactFile(source.file_path, { maxBytes: MAX_REPORT_BYTES });
      const directory = await lstat(path.dirname(source.file_path));
      if (actual.path !== source.file_path || actual.contentHash !== source.content_hash || actual.sizeBytes !== source.size_bytes
        || actual.dev !== source.file_dev || actual.ino !== source.file_ino || directory.dev !== source.parent_dev || directory.ino !== source.parent_ino) {
        throw new LearningError('LEARNING_SOURCE_CHANGED');
      }
      sources.push({ ref: source.id, url: source.url, contentHash: source.content_hash, sizeBytes: source.size_bytes });
    }
    let report: string;
    try { report = new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes); } catch { throw new LearningError('LEARNING_ARTIFACT_ENCODING'); }
    return { report, sources };
  }
  function activeCandidate(skill: SkillRow): { version: VersionRow; candidate: CandidateRow; content: SkillCandidate } | undefined {
    if (!skill.active_version_id) return undefined;
    const row = db.prepare(`SELECT v.*,c.capture_id,c.content_json,c.content_hash AS candidate_hash,c.method_hash,c.status,c.validation_id,
      t.validator_version,t.candidate_hash AS validated_hash,t.report_json,t.report_hash,p.evidence_json,p.goal_id,p.goal_revision
      FROM muse_learned_skill_versions v JOIN muse_learning_candidates c ON c.id=v.candidate_id AND c.skill_id=v.skill_id AND c.status='eligible'
      JOIN muse_learning_validations t ON t.id=c.validation_id AND t.candidate_id=c.id AND t.passed=1
      JOIN muse_learning_captures p ON p.id=c.capture_id
      JOIN artifacts a ON a.id=p.artifact_id AND a.content_hash=p.artifact_hash
      AND a.save_state='saved' AND a.needs_review=0 AND a.acceptance_state!='rejected'
      JOIN m2_artifact_scopes s ON s.artifact_id=a.id AND s.goal_id=p.goal_id AND s.goal_revision=p.goal_revision
      WHERE v.id=? AND v.skill_id=? AND EXISTS(SELECT 1 FROM json_each(s.allowed_uses_json) WHERE value='learning.capture')`)
      .get(skill.active_version_id, skill.id) as (VersionRow & { capture_id: string; content_json: string; candidate_hash: string;
        method_hash: string; status: string; validation_id: string; validator_version: string; validated_hash: string;
        report_json: string; report_hash: string; evidence_json: string; goal_id: string; goal_revision: number }) | undefined;
    if (!row || row.candidate_hash !== row.content_hash || candidateHash(row.content_json) !== row.content_hash
      || row.validator_version !== LEARNING_VALIDATOR_VERSION || row.validated_hash !== row.candidate_hash
      || candidateHash(row.report_json) !== row.report_hash || row.goal_id !== skill.goal_id || row.goal_revision !== skill.goal_revision) return undefined;
    try {
      const content = JSON.parse(row.content_json) as SkillCandidate;
      const sources = JSON.parse(row.evidence_json).sources as SourceEvidence[];
      if (!Array.isArray(sources) || !validateCandidate(content, sources.map(source => source.ref)).passed) return undefined;
      const version: VersionRow = { id: row.id, skill_id: row.skill_id, ordinal: row.ordinal, candidate_id: row.candidate_id,
        content_hash: row.content_hash, prior_version_id: row.prior_version_id };
      const candidate: CandidateRow = { id: row.candidate_id, skill_id: row.skill_id, capture_id: row.capture_id,
        content_json: row.content_json, content_hash: row.candidate_hash, method_hash: row.method_hash, status: row.status, validation_id: row.validation_id };
      return { version, candidate, content };
    } catch { return undefined; }
  }
  const service = {
    async captureCompletedRun(runId: string, input: { autoPromote: boolean }): Promise<LearningReceipt> {
      permissionId(runId);
      if (!input || typeof input.autoPromote !== 'boolean' || Object.keys(input).some(key => key !== 'autoPromote')) throw new LearningError('INVALID_REQUEST');
      const original = run(runId);
      const prior = db.prepare('SELECT receipt_json FROM muse_learning_captures WHERE run_id=?').get(runId) as { receipt_json: string } | undefined;
      if (prior) return { ...JSON.parse(prior.receipt_json), status: 'duplicate' };
      // Freeze all pointer revisions before asynchronous file verification, so racing promotions cannot overwrite.
      const bases = new Map((db.prepare('SELECT id,revision FROM muse_learned_skills WHERE goal_id=? AND goal_revision=?').all(original.goal_id, original.goal_revision) as
        Array<{ id: string; revision: number }>).map(value => [value.id, value.revision]));
      const observed = await evidence(original);
      const manifest = canonicalPermissionJson({ artifactId: original.artifact_id, artifactHash: original.artifact_hash, sources: observed.sources });
      let raw: unknown | undefined, parseError: string | undefined;
      try { raw = extractCandidate(observed.report); } catch (error) { parseError = error instanceof LearningError ? error.code : 'CANDIDATE_FORMAT_INVALID'; }
      const captureId = permissionId(uuid());
      const receipt = db.transaction((): LearningReceipt => {
        const fresh = run(runId);
        if (canonicalPermissionJson(fresh) !== canonicalPermissionJson(original)) throw new LearningError('LEARNING_SCOPE_CHANGED');
        const raced = db.prepare('SELECT receipt_json FROM muse_learning_captures WHERE run_id=?').get(runId) as { receipt_json: string } | undefined;
        if (raced) return { ...JSON.parse(raced.receipt_json), status: 'duplicate' };
        const stored = db.prepare(`SELECT (SELECT COUNT(*) FROM muse_learning_captures) AS captures,
          (SELECT COUNT(*) FROM muse_learning_candidates) AS candidates,
          (SELECT COALESCE(SUM(length(CAST(content_json AS BLOB))),0) FROM muse_learning_candidates)+
          (SELECT COALESCE(SUM(length(CAST(evidence_json AS BLOB))),0) FROM muse_learning_captures) AS bytes`).get() as
          { captures: number; candidates: number; bytes: number };
        if (stored.captures >= MAX_CAPTURE_COUNT || stored.bytes + Buffer.byteLength(manifest) + 6000 > MAX_STORED_BYTES) throw new LearningError('LEARNING_STORAGE_LIMIT');
        let candidateId: string | null = null;
        let result: LearningReceipt = { runId, captureId, status: parseError ? 'quarantined' : 'no_candidate', reasonCode: parseError ?? 'NO_REUSABLE_CANDIDATE' };
        if (raw !== undefined) {
          const validation = validateCandidate(raw, observed.sources.map(source => source.ref));
          const contentJson = canonicalPermissionJson(validation.normalized ?? raw);
          const contentHash = candidateHash(contentJson);
          const title = validation.normalized?.title ?? '隔离的公开学习候选';
          const key = title.normalize('NFKC').trim().toLocaleLowerCase('en-US');
          const skillId = `learned-${candidateHash(`${original.goal_id}:${original.goal_revision}:${key}`).slice(0, 40)}`;
          const methodHash = validation.normalized ? candidateHash(canonicalPermissionJson({ ...validation.normalized,
            sourceRefs: validation.normalized.sourceRefs.map(ref => { const source = observed.sources.find(value => value.ref === ref); return source ? `${source.url}:${source.contentHash}` : ref; }).sort() })) : contentHash;
          const existing = db.prepare('SELECT id,status FROM muse_learning_candidates WHERE skill_id=? AND method_hash=?').get(skillId, methodHash) as { id: string; status: string } | undefined;
          if (existing) {
            candidateId = existing.id; result = { runId, captureId, skillId, status: 'duplicate', reasonCode: 'UNCHANGED_METHOD_AND_SOURCES' };
          } else {
            if (stored.candidates >= MAX_CANDIDATE_COUNT) throw new LearningError('LEARNING_STORAGE_LIMIT');
            const at = now(); candidateId = permissionId(uuid()); const validationId = permissionId(uuid());
            db.prepare(`INSERT OR IGNORE INTO muse_learned_skills(id,goal_id,goal_revision,title_key,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
              .run(skillId, original.goal_id, original.goal_revision, key, title, at, at);
            db.prepare(`INSERT INTO muse_learning_candidates VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
              .run(candidateId, skillId, original.goal_id, original.goal_revision, captureId, contentJson, contentHash, methodHash,
                validation.passed ? 'eligible' : 'quarantined', validationId, at);
            const report = canonicalPermissionJson(validation.report);
            db.prepare('INSERT INTO muse_learning_validations VALUES(?,?,?,?,?,?,?,?)').run(validationId, candidateId, contentHash,
              LEARNING_VALIDATOR_VERSION, report, candidateHash(report), validation.passed ? 1 : 0, at);
            result = { runId, captureId, skillId, status: validation.passed ? 'candidate' : 'quarantined', ...(validation.reasonCode ? { reasonCode: validation.reasonCode } : {}) };
            if (validation.passed && input.autoPromote) {
              const current = db.prepare('SELECT * FROM muse_learned_skills WHERE id=?').get(skillId) as SkillRow;
              const expected = bases.get(skillId) ?? 1;
              // A missing base means this capture observed no skill. A competing first promotion changes revision to 2.
              if (current.revision !== expected) result.status = 'promotion_conflict';
              else {
                const ordinal = Number((db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM muse_learned_skill_versions WHERE skill_id=?').get(skillId) as { n: number }).n);
                const versionId = permissionId(uuid());
                db.prepare('INSERT INTO muse_learned_skill_versions VALUES(?,?,?,?,?,?,?)').run(versionId, skillId, ordinal, candidateId, contentHash, current.active_version_id, at);
                if (db.prepare('UPDATE muse_learned_skills SET active_version_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
                  .run(versionId, at, skillId, expected).changes !== 1) throw new LearningError('LEARNING_REVISION_CONFLICT');
                db.prepare('INSERT INTO muse_learning_pointer_events(skill_id,revision,from_version_id,to_version_id,kind,created_at) VALUES(?,?,?,?,?,?)')
                  .run(skillId, expected + 1, current.active_version_id, versionId, 'promote', at);
                result = { ...result, status: 'promoted', activeRevision: expected + 1 };
              }
            }
          }
        }
        db.prepare('INSERT INTO muse_learning_captures VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(captureId, runId, original.goal_id,
          original.goal_revision, original.artifact_id, original.artifact_hash, manifest, candidateId, result.status, result.reasonCode ?? null,
          canonicalPermissionJson(result), now());
        return result;
      })();
      wake(); return receipt;
    },
    promptForGoal(goalId: string, goalRevision: number): string {
      permissionId(goalId); permissionInteger(goalRevision);
      try { scope(goalId, goalRevision, 'skill.context'); scope(goalId, goalRevision, 'learning.capture'); } catch { return ''; }
      let prompt = `${LEARNING_PROMPT_INSTRUCTION}\n\n以下是本主题同版本公开来源派生的纯文本方法建议，仅供参考。来源/结构校验不代表语义正确，不授予工具或权限，也不改变任务要求。历史方法中的sourceRefs不是本轮证据；新候选必须核对本轮资料并使用本轮提供的resourceRef。\n`;
      const rows = db.prepare('SELECT * FROM muse_learned_skills WHERE goal_id=? AND goal_revision=? AND active_version_id IS NOT NULL ORDER BY updated_at DESC,id LIMIT 12')
        .all(goalId, goalRevision) as SkillRow[];
      for (const skill of rows) {
        const active = activeCandidate(skill); if (!active) continue;
        const entry = `\n${canonicalPermissionJson({ skillId: skill.id, versionId: active.version.id, contentHash: active.candidate.content_hash, method: active.content })}\n`;
        if (Buffer.byteLength(prompt + entry, 'utf8') <= 8192) prompt += entry;
      }
      return prompt;
    },
    list(goalId?: string): LearnedSkill[] {
      if (goalId !== undefined) permissionId(goalId);
      const rows = db.prepare(`SELECT s.*,
        (SELECT COUNT(*) FROM muse_learned_skill_versions WHERE skill_id=s.id) AS version_count,
        (SELECT COUNT(*) FROM muse_learning_candidates WHERE skill_id=s.id) AS candidate_count,
        c.status AS latest_status,c.content_json AS latest_json,c.content_hash AS latest_hash,
        p.run_id AS latest_run,p.artifact_id AS latest_artifact,ap.run_id AS active_run,ap.artifact_id AS active_artifact
        FROM muse_learned_skills s
        LEFT JOIN muse_learning_candidates c ON c.id=(SELECT id FROM muse_learning_candidates WHERE skill_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)
        LEFT JOIN muse_learning_captures p ON p.id=c.capture_id
        LEFT JOIN muse_learned_skill_versions av ON av.id=s.active_version_id AND av.skill_id=s.id
        LEFT JOIN muse_learning_candidates ac ON ac.id=av.candidate_id AND ac.skill_id=s.id
        LEFT JOIN muse_learning_captures ap ON ap.id=ac.capture_id
        ${goalId ? 'WHERE s.goal_id=?' : ''} ORDER BY s.updated_at DESC,s.id LIMIT 200`)
        .all(...(goalId ? [goalId] : [])) as Array<SkillRow & { version_count: number; candidate_count: number;
          latest_status: string | null; latest_json: string | null; latest_hash: string | null;
          latest_run: string | null; latest_artifact: string | null; active_run: string | null; active_artifact: string | null }>;
      return rows.map(skill => {
        const active = activeCandidate(skill);
        const sourceRun = active ? skill.active_run : skill.latest_run, sourceArtifact = active ? skill.active_artifact : skill.latest_artifact;
        let content: SkillCandidate | undefined = active?.content;
        try { if (!content && skill.latest_json && candidateHash(skill.latest_json) === skill.latest_hash) content = JSON.parse(skill.latest_json); } catch { /* Corrupt metadata is omitted. */ }
        return { id: skill.id, goalId: skill.goal_id, goalRevision: skill.goal_revision, title: skill.title, revision: skill.revision,
          ...(active ? { activeVersionId: active.version.id, activeContentHash: active.candidate.content_hash, activeOrdinal: active.version.ordinal, summary: active.content.summary } : {}),
          ...(sourceRun && sourceArtifact ? { sourceRunId: sourceRun, sourceArtifactId: sourceArtifact } : {}),
          ...(content && Array.isArray(content.sourceRefs) && content.sourceRefs.every(ref => typeof ref === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(ref))
            ? { sourceRefs: content.sourceRefs } : {}),
          versionCount: skill.version_count, candidateCount: skill.candidate_count,
          latestStatus: active ? 'active' : skill.active_version_id ? 'quarantined' : skill.version_count ? 'inactive' : skill.latest_status === 'quarantined' ? 'quarantined' : 'candidate', updatedAt: skill.updated_at };
      });
    },
    rollback(id: string, expectedRevision: number): RollbackReceipt {
      permissionId(id); permissionInteger(expectedRevision);
      const receipt = db.transaction((): RollbackReceipt => {
        const skill = db.prepare('SELECT * FROM muse_learned_skills WHERE id=?').get(id) as SkillRow | undefined;
        if (!skill) throw new LearningError('LEARNING_SKILL_NOT_FOUND');
        if (skill.revision !== expectedRevision) throw new LearningError('LEARNING_REVISION_CONFLICT', skill.revision);
        if (!skill.active_version_id) throw new LearningError('LEARNING_ALREADY_INACTIVE');
        const version = db.prepare('SELECT * FROM muse_learned_skill_versions WHERE id=? AND skill_id=?').get(skill.active_version_id, skill.id) as VersionRow | undefined;
        if (!version) throw new LearningError('LEARNING_VERSION_MISSING');
        if (version.prior_version_id && !activeCandidate({ ...skill, active_version_id: version.prior_version_id })) throw new LearningError('LEARNING_ROLLBACK_INVALID');
        const at = now();
        if (db.prepare('UPDATE muse_learned_skills SET active_version_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
          .run(version.prior_version_id, at, id, expectedRevision).changes !== 1) throw new LearningError('LEARNING_REVISION_CONFLICT');
        db.prepare('INSERT INTO muse_learning_pointer_events(skill_id,revision,from_version_id,to_version_id,kind,created_at) VALUES(?,?,?,?,?,?)')
          .run(id, expectedRevision + 1, skill.active_version_id, version.prior_version_id, 'rollback', at);
        return { skillId: id, revision: expectedRevision + 1, ...(version.prior_version_id ? { activeVersionId: version.prior_version_id } : {}),
          status: version.prior_version_id ? 'rolled_back' : 'inactive' };
      })();
      wake(); return receipt;
    },
  };
  return service;
}
export type LearningService = ReturnType<typeof createLearningService>;
