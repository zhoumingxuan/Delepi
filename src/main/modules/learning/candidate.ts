import { createHash } from 'node:crypto';
import { canonicalPermissionJson } from '../permissions/permission-validation';
import { LearningError, LEARNING_VALIDATOR_VERSION, type SkillCandidate } from './contracts';

export const MAX_CANDIDATE_BYTES = 6000;
export const candidateHash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
const marker = '<!-- delepi-skill-candidate:v1 -->';
const fields = ['title', 'summary', 'applicability', 'steps', 'checks', 'limitations', 'sourceRefs'];
export function extractCandidate(report: string): unknown | undefined {
  const start = report.indexOf(marker);
  if (start < 0) return undefined;
  if (report.indexOf(marker, start + marker.length) >= 0) throw new LearningError('CANDIDATE_MULTIPLE');
  const match = /^\s*```json[\t ]*\r?\n([\s\S]*?)\r?\n```/.exec(report.slice(start + marker.length));
  if (!match || Buffer.byteLength(match[1], 'utf8') > MAX_CANDIDATE_BYTES) throw new LearningError('CANDIDATE_FORMAT_INVALID');
  try { return JSON.parse(match[1]); } catch { throw new LearningError('CANDIDATE_FORMAT_INVALID'); }
}
function text(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) throw new LearningError('CANDIDATE_STRUCTURE_INVALID');
  return value.trim();
}
function list(value: unknown, maxCount: number, maxBytes: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxCount) throw new LearningError('CANDIDATE_STRUCTURE_INVALID');
  return value.map(item => text(item, maxBytes));
}
/** Fixed structural/content gate, explicitly not a semantic or execution evaluator. */
export function validateCandidate(raw: unknown, sourceRefs: string[]) {
  const checks = { structure: false, publicSources: false, pureText: false, size: false };
  let normalized: SkillCandidate | undefined, reason: string | undefined;
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== fields.length
      || Object.keys(raw).some(key => !fields.includes(key))) throw new LearningError('CANDIDATE_STRUCTURE_INVALID');
    const value = raw as Record<string, unknown>;
    normalized = { title: text(value.title, 160), summary: text(value.summary, 600), applicability: text(value.applicability, 600),
      steps: list(value.steps, 8, 500), checks: list(value.checks, 5, 400), limitations: list(value.limitations, 5, 400),
      sourceRefs: list(value.sourceRefs, 8, 128) };
    checks.structure = true;
    if (new Set(normalized.sourceRefs).size !== normalized.sourceRefs.length
      || normalized.sourceRefs.some(ref => !sourceRefs.includes(ref))) throw new LearningError('CANDIDATE_SOURCE_INVALID');
    checks.publicSources = true;
    const plain = [normalized.title, normalized.summary, normalized.applicability, ...normalized.steps, ...normalized.checks, ...normalized.limitations].join('\n');
    // Deliberately conservative: this lane is advisory prose, with no tool execution adapter.
    if (/```|#!|<\/?(?:script|iframe|object|embed)\b|javascript:|\$\(|\b(?:eval|exec|spawn|require)\s*\(|\b(?:sudo|curl|wget|chmod|launchctl|osascript|powershell|npm\s+install|pip\s+install)\b|(?:^|\n)\s*(?:import\s+\w|def\s+\w|function\s+\w|rm\s+-|python\d*\s+|bash\s+|sh\s+)|(?:权限|系统提示词|模型配置|批准规则|api.?key|密钥).{0,16}(?:修改|更改|绕过|覆盖|禁用)|(?:修改|更改|绕过|覆盖|禁用).{0,16}(?:权限|系统提示词|模型配置|批准规则|api.?key|密钥)/i.test(plain)) {
      throw new LearningError('CANDIDATE_EXECUTABLE_OR_CONTROL_CONTENT');
    }
    checks.pureText = true;
    if (Buffer.byteLength(canonicalPermissionJson(normalized), 'utf8') > MAX_CANDIDATE_BYTES) throw new LearningError('CANDIDATE_TOO_LARGE');
    checks.size = true;
  } catch (error) { reason = error instanceof LearningError ? error.code : 'CANDIDATE_STRUCTURE_INVALID'; }
  const report = { validatorVersion: LEARNING_VALIDATOR_VERSION, checks, passed: !reason, semanticCorrectness: 'not_evaluated',
    execution: 'not_allowed', ...(reason ? { reasonCode: reason } : {}) };
  return { normalized, report, passed: !reason, reasonCode: reason };
}
