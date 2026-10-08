import type { PublicAction, PublicResource } from '@shared/types/autonomy';
import type { TaskRunContext } from '../tasks/types';
import type { OperationOutcome, OperationUsage, PreparedOperation } from '../permissions/authority';

export class BrokerError extends Error {
  constructor(readonly code: string, readonly receivedBytes = 0, readonly started = false) { super(code); }
}
export interface BrokerRunClock {
  signal: AbortSignal;
  registerBranch(branchId: string): void;
  setBranchState(branchId: string, state: 'active' | 'waiting-user' | 'settled'): void;
  assertRemaining(): void;
  remainingMilliseconds(): number;
}
/** Main-process session; no part of this object is accepted through renderer/model arguments. */
export interface BrokerSession {
  readonly context: TaskRunContext;
  readonly signal: AbortSignal;
  readonly branchId: string;
  readonly clock: BrokerRunClock;
  withSlot<T>(operation: () => Promise<T>, operationSignal?: AbortSignal): Promise<T>;
  prepare(action: PublicAction): Promise<PreparedOperation>;
  assertLease(leaseId: string): PreparedOperation;
  markStarted(leaseId: string): void;
  settle(leaseId: string, outcome: OperationOutcome, usage?: OperationUsage): void;
  close(): void;
}
/** A document is minted/validated by the trusted FileBroker, never assembled from arbitrary model text. */
export interface PublicDocument {
  resource: PublicResource;
  text: string;
  contentHash: string;
  sizeBytes: number;
}
export interface PublicAddition {
  id: string;
  text: string;
  contentHash: string;
  goalId: string;
  dataScopeId: string;
  classification: 'public';
}
export interface PublicModelInput {
  anchorRef: string;
  destinationRef: string;
  protocol: 'chat-completions' | 'responses';
  documents: PublicDocument[];
  additions: PublicAddition[];
}
export interface PublicModelResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  operationId: string;
}
export interface PublicFetchResult { resource: PublicResource; finalUrl: string; receivedBytes: number; contentType: string }
