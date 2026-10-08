import type { MuseResult } from './muse';

export const PUBLIC_CAPABILITIES = ['fetch.public', 'model.invoke', 'file.read_public', 'artifact.publish'] as const;
export type PublicCapability = typeof PUBLIC_CAPABILITIES[number];
export type GoalState = 'active' | 'paused' | 'archived';
export interface BudgetAmounts {
  modelRequests: number; fetchRequests: number; downloadBytes: number; storageBytes: number; tokenUnits: number;
}
export interface ExplorationLimits extends BudgetAmounts {
  activeMilliseconds: number; absoluteMilliseconds: number; maxDocumentBytes: number; concurrency: number;
}
export interface PublicGoalDraft {
  title: string; topic: string; sourceUrls: string[]; destinationId: string;
  expectedOutput: string; stopConditions: string; limits: ExplorationLimits;
}
export interface PublicGoal extends PublicGoalDraft {
  id: string; revision: number; state: GoalState; dataScopeId: string; createdAt: string; updatedAt: string;
}
export interface ModelDestination {
  id: string; label: string; endpointOrigin: string; model: string; revision: number; available: boolean;
}
export interface PublicResource {
  id: string; goalId: string; dataScopeId: string; kind: 'public_url' | 'public_snapshot' | 'artifact';
  url?: string; contentHash: string; sizeBytes: number; revision: number; parentId?: string;
}
/** Created by the main-process broker from actual parameters; never accepted from IPC/model arguments. */
export interface PublicAction {
  capability: PublicCapability; resourceRef: string; resourceVersion: string; destinationRef?: string;
  payloadHash?: string; summary: string; units: BudgetAmounts;
}
export interface ApprovalPreview {
  id: string; revision: number; state: 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked';
  goalId: string; goalRevision: number; runId: string; attemptId: string;
  action: PublicAction; resourceLabel: string; destinationLabel?: string;
  expiresAt: string; authorizationExpiresAt: string; createdAt: string;
}
export type ApprovalChoice = 'once' | 'run' | 'reject';
export interface DecisionReceipt { previewId: string; state: string; grantId?: string; revision: number }
export interface RuleDraft {
  goalId: string; expectedGoalRevision: number; capabilities: PublicCapability[]; resourceRefs: string[];
  expiresAt: string; resumeAfterRestart: boolean;
}
export interface RulePreview {
  id: string; revision: number; goalId: string; goalRevision: number; capabilities: PublicCapability[];
  resources: PublicResource[]; destination: ModelDestination; limits: ExplorationLimits;
  expiresAt: string; previewExpiresAt: string; resumeAfterRestart: boolean;
}
export interface StandingRule {
  id: string; revision: number; goalId: string; goalRevision: number;
  state: 'active' | 'revoked' | 'expired' | 'suspended'; capabilities: PublicCapability[];
  resourceRefs: string[]; destinationId: string; limits: ExplorationLimits;
  expiresAt: string; resumeAfterRestart: boolean; createdAt: string;
}
export interface GrantProjection {
  id: string; revision: number; goalId: string; runId: string; scope: 'once' | 'run';
  state: string; capability: PublicCapability; resourceRef: string; expiresAt: string;
}
export interface PermissionPolicy {
  revision: number; deniedCapabilities: PublicCapability[];
  deniedLegacyTools: Array<'shell' | 'python' | 'scriptTools' | 'dynamicTools' | 'localFiles'>;
  warnings: string[];
}
export type OsPermissionKind = 'camera' | 'microphone' | 'screen' | 'accessibility' | 'inputMonitoring' | 'automation' | 'fullDisk';
export interface OsPermissionStatus {
  kind: OsPermissionKind; label: string; status: 'granted' | 'not-granted' | 'unknown';
  querySupported: boolean; requestSupported: boolean; settingsSupported: boolean; checkedAt: string; detail: string;
}
export interface BudgetProjection {
  accounts: Array<{ id: string; kind: string; limits: BudgetAmounts; used: BudgetAmounts; reserved: BudgetAmounts;
    scope?: 'global' | 'goal' | 'run' | 'day'; scopeRef?: string; windowKey?: string; windowStart?: string; windowEnd?: string;
    timezone?: 'UTC'; remaining?: BudgetAmounts; revision?: number }>;
}
export interface ExplorationPlan { id: string; goalId: string; goalRevision: number; revision: number; protocol: 'chat-completions' | 'responses'; sources: PublicResource[]; destination: ModelDestination; limits: ExplorationLimits; expiresAt: string }
export interface ExplorationSession {
  id: string; goalId: string; runId: string; state: string; stopReason?: string;
  sourceCount: number; artifactId?: string; createdAt: string; settledAt?: string;
  sourceTotal?: number; phase?: 'fetching' | 'reading' | 'summarizing' | 'publishing' | 'settling';
  pendingApprovalCount?: number; additionCount?: number; activeRemainingMilliseconds?: number; absoluteRemainingMilliseconds?: number;
  goalRevision?: number; destination?: ModelDestination;
}
export interface AutonomyApi {
  status(): Promise<MuseResult<{ explorationReady: boolean }>>;
  listGoals(): Promise<MuseResult<PublicGoal[]>>;
  getGoal(goalId: string): Promise<MuseResult<{ goal: PublicGoal; resources: PublicResource[] }>>;
  listDestinations(): Promise<MuseResult<ModelDestination[]>>;
  createGoal(draft: PublicGoalDraft): Promise<MuseResult<PublicGoal>>;
  updateGoal(goalId: string, expectedRevision: number, draft: PublicGoalDraft): Promise<MuseResult<PublicGoal>>;
  setGoalState(goalId: string, expectedRevision: number, state: GoalState): Promise<MuseResult<PublicGoal>>;
  listApprovals(): Promise<MuseResult<ApprovalPreview[]>>;
  decideApproval(previewId: string, expectedRevision: number, choice: ApprovalChoice): Promise<MuseResult<DecisionReceipt>>;
  previewRule(draft: RuleDraft): Promise<MuseResult<RulePreview>>;
  issueRule(previewId: string, expectedRevision: number): Promise<MuseResult<StandingRule>>;
  listRules(goalId?: string): Promise<MuseResult<StandingRule[]>>;
  revokeRule(ruleId: string, expectedRevision: number): Promise<MuseResult<void>>;
  listGrants(): Promise<MuseResult<GrantProjection[]>>;
  revokeGrant(grantId: string, expectedRevision: number): Promise<MuseResult<void>>;
  getPolicy(): Promise<MuseResult<PermissionPolicy>>;
  updatePolicy(expectedRevision: number, patch: Pick<PermissionPolicy, 'deniedCapabilities' | 'deniedLegacyTools'>): Promise<MuseResult<PermissionPolicy>>;
  osStatus(): Promise<MuseResult<OsPermissionStatus[]>>;
  requestOs(kind: OsPermissionKind): Promise<MuseResult<OsPermissionStatus>>;
  openOsSettings(kind: OsPermissionKind): Promise<MuseResult<{ opened: boolean }>>;
  budget(goalId?: string, runId?: string): Promise<MuseResult<BudgetProjection>>;
  planExploration(goalId: string, expectedRevision: number, protocol?: ExplorationPlan['protocol']): Promise<MuseResult<ExplorationPlan>>;
  startExploration(planId: string, expectedRevision: number): Promise<MuseResult<ExplorationSession>>;
  stopExploration(runId: string): Promise<MuseResult<void>>;
  listExplorations(goalId?: string): Promise<MuseResult<ExplorationSession[]>>;
  appendPublicMessage(runId: string, messageId: string, text: string, confirmedPublic: boolean): Promise<MuseResult<{ accepted: boolean; reason?: string }>>;
  onChanged(listener: () => void): () => void;
}
