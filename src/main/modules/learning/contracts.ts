export interface SkillCandidate {
  title: string; summary: string; applicability: string; steps: string[]; checks: string[];
  limitations: string[]; sourceRefs: string[];
}
export interface LearningReceipt {
  runId: string; captureId: string;
  status: 'promoted' | 'candidate' | 'quarantined' | 'duplicate' | 'no_candidate' | 'promotion_conflict';
  skillId?: string; reasonCode?: string; activeRevision?: number;
}
export interface LearnedSkill {
  id: string; goalId: string; goalRevision: number; title: string; revision: number;
  activeVersionId?: string; activeContentHash?: string; activeOrdinal?: number; summary?: string;
  versionCount: number; candidateCount: number; latestStatus: 'active' | 'candidate' | 'quarantined' | 'inactive';
  sourceRunId?: string; sourceArtifactId?: string; sourceRefs?: string[];
  updatedAt: string;
}
export interface RollbackReceipt {
  skillId: string; revision: number; activeVersionId?: string; status: 'rolled_back' | 'inactive';
}
export class LearningError extends Error {
  constructor(readonly code: string, readonly currentRevision?: number) { super(code); }
}
export const LEARNING_VALIDATOR_VERSION = 'public-text-v1';
export const LEARNING_PROMPT_INSTRUCTION = `若本轮公开资料支持一个明确可复用的纯文本方法，可在总结末尾附一个候选；无充分证据时不要生成。
只能输出一个 <!-- delepi-skill-candidate:v1 --> 标记，紧随一个 json 代码块。JSON严格为：
{"title":"稳定的方法名称","summary":"方法摘要","applicability":"适用条件","steps":["纯文本步骤"],"checks":["可观察的验收"],"limitations":["适用限制和停止条件"],"sourceRefs":["本轮公开document的resourceRef"]}。
只引用本轮提供的真实resourceRef；不得包含代码、命令、脚本、密钥、私人数据、权限/模型配置更改或自我授权。候选是未经语义验证的建议，不要声明学会、训练完成或正确性已验证。`;
