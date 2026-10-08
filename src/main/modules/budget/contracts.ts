import type { BudgetAmounts, PublicAction } from '@shared/types/autonomy';
import type { OperationOutcome, OperationUsage } from '../permissions/authority';
import type { TaskRunContext } from '../tasks/types';

const MiB = 1024 * 1024;
export interface TrustedBudgetCaps {
  /** Cumulative autonomous-reading accounts; never reset at the start of a Run. */
  readonly global: Readonly<BudgetAmounts>;
  readonly goal: Readonly<BudgetAmounts>;
  /** M2 uses UTC windows. A renderer or model cannot choose another timezone. */
  readonly day: Readonly<BudgetAmounts>;
}
export const DEFAULT_PUBLIC_BUDGET_CAPS: TrustedBudgetCaps = Object.freeze({
  global: Object.freeze({ modelRequests: 200, fetchRequests: 256, downloadBytes: 200 * MiB, storageBytes: 200 * MiB, tokenUnits: 4000000 }),
  goal: Object.freeze({ modelRequests: 100, fetchRequests: 128, downloadBytes: 100 * MiB, storageBytes: 100 * MiB, tokenUnits: 2000000 }),
  day: Object.freeze({ modelRequests: 40, fetchRequests: 64, downloadBytes: 40 * MiB, storageBytes: 40 * MiB, tokenUnits: 1000000 }),
});

export interface BudgetAccountProjection {
  id: string;
  scope: 'global' | 'goal' | 'run' | 'day';
  scopeRef: string;
  windowKey: string;
  /** Present for day accounts and retained for historical/unknown reservations. */
  windowStart?: string;
  windowEnd?: string;
  timezone?: 'UTC';
  limits: BudgetAmounts;
  used: BudgetAmounts;
  reserved: BudgetAmounts;
  remaining: BudgetAmounts;
  revision: number;
}

/** Trusted main-process construction only. No secret, account ID or cap comes from an action. */
export interface BudgetLedgerOptions {
  caps: TrustedBudgetCaps;
  now?: () => number;
  uuid?: () => string;
}

/** Implementation is gated on the independent A/B release. All hooks are synchronous. */
export interface BudgetLedger {
  reserveInTransaction(operationId: string, action: PublicAction, context: TaskRunContext): string;
  settleInTransaction(operationId: string, outcome: OperationOutcome, usage?: OperationUsage): void;
  /** Called by Authority before its interrupted journals are converted to outcome_unknown. */
  reconcileInterruptedInTransaction(): void;
  listAccounts(context?: TaskRunContext): BudgetAccountProjection[];
}
