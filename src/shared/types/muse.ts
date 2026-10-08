/** Plain data only. Renderer cannot supply execution identities or file paths. */
export interface MuseRequest<T> { requestId: string; expectedRevision?: number; payload: T }
export type MuseResult<T> = { ok: true; result: T } | { ok: false; code: string; message: string; retryable: boolean; currentRevision?: number };
export interface MuseRun {
  id: string; conversationId: string; rootAttemptId: string; state: string;
  generation: number; revision: number; createdAt: string; updatedAt: string; settledAt?: string;
}
export interface MuseAttempt {
  id: string; runId: string; taskId: string; parentAttemptId?: string; delegateCallId?: string;
  state: string; generation: number; startedAt: string; settledAt?: string; resultKind?: string;
}
export interface MuseActivityEvent {
  eventId: number; runId: string; attemptId?: string; conversationId: string;
  kind: string; details: Record<string, unknown>; occurredAt: string; committedAt: string;
}
export interface MuseActivityPage { events: MuseActivityEvent[]; throughEventId: number; nextAfterEventId: number; hasMore: boolean }
export interface MuseInboxItem {
  id: number; runId: string; attemptId: string; messageId: string; generation: number;
  state: string; reasonCode?: string; createdAt: string; updatedAt: string; injectedAt?: string;
}
export interface MuseArtifact {
  id: string; title: string; runId?: string; attemptId?: string; conversationId?: string;
  contentHash: string; sizeBytes: number;
  saveState: 'staging' | 'saved' | 'failed' | 'missing' | 'quarantined';
  validationState: 'pending' | 'passed' | 'failed' | 'not_applicable';
  acceptanceState: 'unreviewed' | 'accepted' | 'rejected';
  revision: number; createdAt: string; updatedAt: string; needsReview: boolean;
}
export interface MuseArtifactPage { items: MuseArtifact[]; nextCursor?: string }
export interface MuseApi {
  appInfo(): Promise<MuseResult<{ version: string; platform: string }>>;
  listRuns(payload?: { conversationId?: string; limit?: number }): Promise<MuseResult<MuseRun[]>>;
  getRun(runId: string): Promise<MuseResult<{ run: MuseRun | null; attempts: MuseAttempt[] }>>;
  listActivity(payload?: { runId?: string; conversationId?: string; afterEventId?: number; throughEventId?: number; limit?: number }): Promise<MuseResult<MuseActivityPage>>;
  listInbox(runId: string): Promise<MuseResult<MuseInboxItem[]>>;
  listArtifacts(payload?: { conversationId?: string; runId?: string; limit?: number; cursor?: string }): Promise<MuseResult<MuseArtifactPage>>;
  getArtifact(artifactId: string): Promise<MuseResult<MuseArtifact | null>>;
  openArtifact(artifactId: string): Promise<MuseResult<void>>;
  acceptArtifact(payload: { artifactId: string; accepted: boolean; expectedRevision: number }): Promise<MuseResult<MuseArtifact>>;
  indexLegacyArtifacts(payload?: { cursor?: string; limit?: number }): Promise<MuseResult<{ scanned: number; indexed: number; skipped: number; errors: number; done: boolean; nextCursor?: string }>>;
  onChanged(listener: (cursor: number) => void): () => void;
  onOpenSettings(listener: () => void): () => void;
}
