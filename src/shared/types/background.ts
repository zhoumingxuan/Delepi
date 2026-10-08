import type { MuseResult } from './muse';

export type BackgroundProtocol = 'chat-completions' | 'responses';
export interface BackgroundConfiguration {
  intervalMinutes: number;
  dailyRoundLimit: number;
  expiresAt: string;
  protocol: BackgroundProtocol;
  learningEnabled: boolean;
  autoPromote: boolean;
}
export interface BackgroundSchedule extends BackgroundConfiguration {
  id: string; revision: number; goalId: string; goalRevision: number;
  state: 'enabled' | 'paused' | 'blocked' | 'expired';
  nextDueAt: string; ruleId: string; lastRunId?: string;
  lastOutcome?: string; reasonCode?: string; roundsToday: number; createdAt: string;
}
/** Text-only learned knowledge. Paths, executable content and provider secrets are never exposed. */
export interface LearnedSkill {
  id: string; goalId: string; goalRevision: number; title: string; summary?: string;
  revision: number; activeVersionId?: string; activeContentHash?: string; activeOrdinal?: number;
  versionCount: number; candidateCount: number; latestStatus: 'active' | 'candidate' | 'quarantined' | 'inactive';
  updatedAt: string; sourceRunId?: string; sourceArtifactId?: string; sourceRefs?: string[];
}
export interface LearnedSkillRollback { skillId: string; revision: number; activeVersionId?: string; status: 'rolled_back' | 'inactive' }
export interface BackgroundApi {
  status(): Promise<MuseResult<{ ready: boolean; appMustRemainRunning: true }>>;
  list(): Promise<MuseResult<BackgroundSchedule[]>>;
  configure(goalId: string, goalRevision: number, config: BackgroundConfiguration): Promise<MuseResult<BackgroundSchedule>>;
  setEnabled(scheduleId: string, expectedRevision: number, enabled: boolean): Promise<MuseResult<BackgroundSchedule>>;
  runNow(scheduleId: string, expectedRevision: number): Promise<MuseResult<BackgroundSchedule>>;
  listSkills(goalId?: string): Promise<MuseResult<LearnedSkill[]>>;
  rollbackSkill(skillId: string, expectedRevision: number): Promise<MuseResult<LearnedSkillRollback>>;
  onChanged(listener: () => void): () => void;
}
