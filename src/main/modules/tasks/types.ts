/** Main-process identities only. Never reconstructed from model arguments or renderer input. */
export type TaskState = 'running' | 'stop_requested' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type TerminalTaskState = Exclude<TaskState, 'running' | 'stop_requested'>;
export interface TaskRunContext {
  readonly runId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly conversationId: string;
  readonly generation: number;
  readonly ownerId: string;
  readonly parentAttemptId?: string;
  readonly delegateCallId?: string;
}
export interface RunRecord {
  id: string; conversationId: string; rootAttemptId: string; state: TaskState;
  generation: number; revision: number; createdAt: string; updatedAt: string; settledAt?: string;
}
export interface AttemptRecord {
  id: string; runId: string; taskId: string; parentAttemptId?: string; delegateCallId?: string;
  state: TaskState; generation: number; startedAt: string; settledAt?: string; resultKind?: string;
}
export interface ActivityRecord {
  eventId: number; runId: string; attemptId?: string; conversationId: string; kind: string;
  details: Record<string, string | number | boolean>; occurredAt: string; committedAt: string;
}
export type InboxState = 'accepted' | 'injecting' | 'injected' | 'rejected' | 'cancelled' | 'delivery_unknown';
export interface InboxRecord {
  id: number; runId: string; attemptId: string; messageId: string; generation: number;
  state: InboxState; reasonCode?: string; createdAt: string; updatedAt: string; injectedAt?: string;
}
export interface InboxDeliveryRecord extends InboxRecord { text: string; contentHash: string }
export interface ActivityQuery {
  runId?: string; conversationId?: string; afterEventId?: number; throughEventId?: number; limit?: number;
}
export interface ActivityPage {
  events: ActivityRecord[]; throughEventId: number; nextAfterEventId: number; hasMore: boolean;
}
