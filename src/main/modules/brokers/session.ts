import { randomUUID } from 'node:crypto';
import type { PublicAction } from '@shared/types/autonomy';
import type { TaskRunContext } from '../tasks/types';
import type { PermissionAuthority } from '../permissions/authority';
import { BrokerError, type BrokerRunClock, type BrokerSession } from './contracts';
import type { BrokerConcurrency } from './concurrency';

export function createBrokerSession(options: { context: TaskRunContext; authority: PermissionAuthority; clock: BrokerRunClock; concurrency: BrokerConcurrency; signal: AbortSignal; callerId: number; branchId?: string; interactiveApproval?: boolean }): BrokerSession {
  const branchId = options.branchId ?? randomUUID();
  const localController = new AbortController();
  const signal = AbortSignal.any([options.signal, options.clock.signal, localController.signal]);
  let closed = false;
  let slots = 0;
  let preparing = false;
  options.clock.registerBranch(branchId);
  const current = () => { if (closed) throw new BrokerError('BROKER_SESSION_CLOSED'); if (signal.aborted) throw new BrokerError('CANCELLED'); options.clock.assertRemaining(); };
  return {
    context: options.context, signal, branchId, clock: options.clock,
    async withSlot(operation, operationSignal) { current(); const slotSignal = operationSignal ? AbortSignal.any([signal, operationSignal]) : signal;
      const release = await options.concurrency.acquire(slotSignal); slots++; try { current(); if (slotSignal.aborted) throw new BrokerError('CANCELLED'); return await operation(); } finally { slots--; release(); } },
    async prepare(action: PublicAction) {
      current();
      if (slots > 0) throw new BrokerError('BROKER_PREPARE_IN_SLOT');
      if (preparing) throw new BrokerError('BROKER_SESSION_BUSY');
      preparing = true;
      try {
      try { return options.authority.prepare(options.context, action); }
      catch (error) {
        if (!(error instanceof Error) || (error as { code?: string }).code !== 'AUTHORIZATION_REQUIRED') throw error;
        if (options.interactiveApproval === false) throw error;
      }
      const preview = options.authority.previewAction(options.context, action, options.callerId);
      options.clock.setBranchState(branchId, 'waiting-user');
      try { await options.authority.waitForDecision(preview.id, signal, { preview, context: options.context }); }
      finally { if (!closed) { if (signal.aborted) { closed = true; options.clock.setBranchState(branchId, 'settled'); } else options.clock.setBranchState(branchId, 'active'); } }
      current();
      return options.authority.prepare(options.context, action);
      } finally { preparing = false; }
    },
    assertLease(leaseId) { current(); return options.authority.assertLease(leaseId, options.context); },
    markStarted(leaseId) { current(); options.authority.markStarted(leaseId, options.context); },
    // A terminal receipt is valid after cancellation. Authority checks full owner identity and ledger retains unknown usage.
    settle(leaseId, outcome, usage) { options.authority.settle(leaseId, options.context, outcome, usage); },
    close() { if (closed) return; closed = true; localController.abort(new BrokerError('BROKER_SESSION_CLOSED')); options.clock.setBranchState(branchId, 'settled'); },
  };
}
