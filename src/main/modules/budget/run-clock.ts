import { performance } from 'node:perf_hooks';

export type RunBranchState = 'active' | 'waiting-user' | 'settled';
export class RunClockError extends Error {
  constructor(readonly code: string) { super(code); }
}
export interface RunClockOptions {
  activeMilliseconds: number;
  /** The immutable deadline already recorded by bindRun; constructing a clock never renews it. */
  deadlineAt: string;
  monotonicNow?: () => number;
  wallNow?: () => number;
  timers?: { setTimeout(callback: () => void, milliseconds: number): unknown; clearTimeout(handle: unknown): void };
}
export interface RunClockSnapshot {
  activeUsedMilliseconds: number;
  activeRemainingMilliseconds: number;
  absoluteRemainingMilliseconds: number;
  deadlineAt: string;
  branches: { active: number; waitingUser: number; settled: number };
  state: 'running' | 'stopped' | 'disposed';
  stopReason?: string;
}
export interface RunClock {
  readonly signal: AbortSignal;
  registerBranch(branchId: string): void;
  setBranchState(branchId: string, state: RunBranchState): void;
  assertRemaining(): void;
  /** Maximum remaining wall duration for the current execution state, including absolute deadline. */
  remainingMilliseconds(): number;
  snapshot(): RunClockSnapshot;
  stop(reason?: string | Error): void;
  dispose(): void;
}

/** Active time is the union of active branches, not their sum. Only user waits pause it.
 * Approval-card TTL belongs to Authority and is never managed or extended by this clock.
 * Every instance is process-local: interrupted Runs create no resumed clock or renewed deadline. */
export function createRunClock(options: RunClockOptions): RunClock {
  if (!Number.isSafeInteger(options.activeMilliseconds) || options.activeMilliseconds < 1
    || typeof options.deadlineAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(options.deadlineAt)
    || !Number.isFinite(Date.parse(options.deadlineAt)) || new Date(options.deadlineAt).toISOString() !== options.deadlineAt) throw new RunClockError('CLOCK_INVALID');
  const deadline = Date.parse(options.deadlineAt), monotonicNow = options.monotonicNow ?? (() => performance.now()), wallNow = options.wallNow ?? Date.now;
  const timers = options.timers ?? {
    setTimeout(callback: () => void, milliseconds: number) { const timer = setTimeout(callback, milliseconds); timer.unref(); return timer; },
    clearTimeout(handle: unknown) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
  };
  const controller = new AbortController(), branches = new Map<string, RunBranchState>();
  let lastMonotonic = monotonicNow(), lastWall = wallNow(), activeUsed = 0, activeCount = 0;
  let timer: unknown, state: RunClockSnapshot['state'] = 'running', stopReason: string | undefined;
  if (!Number.isFinite(lastMonotonic) || !Number.isFinite(lastWall)) throw new RunClockError('CLOCK_INVALID');
  const clearTimer = () => { if (timer !== undefined) { timers.clearTimeout(timer); timer = undefined; } };
  const stop = (reason: string | Error = 'CLOCK_STOPPED') => {
    if (state !== 'running') return;
    state = 'stopped'; stopReason = typeof reason === 'string' ? reason : reason instanceof RunClockError ? reason.code : reason.message;
    clearTimer(); controller.abort(typeof reason === 'string' ? new RunClockError(reason) : reason);
  };
  const sample = () => {
    if (state !== 'running') return;
    const monotonic = monotonicNow(), wall = wallNow();
    if (!Number.isFinite(monotonic) || !Number.isFinite(wall) || monotonic < lastMonotonic) { stop('CLOCK_INVALID'); return; }
    const elapsed = monotonic - lastMonotonic;
    if (activeCount > 0) activeUsed = Math.min(options.activeMilliseconds, activeUsed + elapsed);
    lastMonotonic = monotonic;
    // A wall-clock rollback cannot extend an already captured absolute deadline.
    lastWall = Math.max(lastWall + elapsed, wall);
    if (lastWall >= deadline) stop('ABSOLUTE_DEADLINE_EXCEEDED');
    else if (activeUsed >= options.activeMilliseconds) stop('ACTIVE_TIME_EXHAUSTED');
  };
  const schedule = () => {
    clearTimer(); sample(); if (state !== 'running') return;
    // Recheck wall time at least once a second, so a forward system-clock jump also aborts
    // without another admission. Monotonic active time is unaffected by wall-clock changes.
    const remaining = Math.min(deadline - lastWall, activeCount > 0 ? options.activeMilliseconds - activeUsed : Infinity, 1000);
    timer = timers.setTimeout(() => { timer = undefined; schedule(); }, Math.max(1, Math.ceil(remaining)));
  };
  const assertRemaining = () => {
    sample(); if (controller.signal.aborted) throw controller.signal.reason;
    if (state === 'disposed') throw new RunClockError('CLOCK_DISPOSED');
  };
  const validBranch = (branchId: string) => { if (typeof branchId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(branchId)) throw new RunClockError('CLOCK_INVALID'); };
  const clock: RunClock = {
    signal: controller.signal, assertRemaining,
    registerBranch(branchId) {
      assertRemaining(); validBranch(branchId); if (branches.has(branchId)) throw new RunClockError('CLOCK_BRANCH_EXISTS');
      branches.set(branchId, 'active'); activeCount++; schedule();
    },
    setBranchState(branchId, next) {
      validBranch(branchId); if (!['active', 'waiting-user', 'settled'].includes(next)) throw new RunClockError('CLOCK_INVALID');
      const previous = branches.get(branchId); if (!previous) throw new RunClockError('CLOCK_BRANCH_NOT_FOUND');
      if (previous === 'settled' && next !== 'settled') throw new RunClockError('CLOCK_BRANCH_SETTLED');
      // Terminal cleanup remains usable after an abort; it never resets consumed time or signal.
      if (next !== 'settled') assertRemaining(); else sample();
      if (previous === next) return;
      if (previous === 'active') activeCount--;
      if (next === 'active') activeCount++;
      branches.set(branchId, next); schedule();
    },
    remainingMilliseconds() {
      sample(); if (state !== 'running') return 0;
      return Math.max(0, Math.min(deadline - lastWall, activeCount > 0 ? options.activeMilliseconds - activeUsed : Infinity));
    },
    snapshot() {
      sample();
      return { activeUsedMilliseconds: activeUsed, activeRemainingMilliseconds: Math.max(0, options.activeMilliseconds - activeUsed),
        absoluteRemainingMilliseconds: Math.max(0, deadline - lastWall), deadlineAt: options.deadlineAt,
        branches: { active: activeCount, waitingUser: [...branches.values()].filter(value => value === 'waiting-user').length, settled: [...branches.values()].filter(value => value === 'settled').length },
        state, ...(stopReason ? { stopReason } : {}) };
    },
    stop(reason) { sample(); stop(reason); },
    dispose() { if (state === 'disposed') return; sample(); stop('CLOCK_DISPOSED'); clearTimer(); state = 'disposed'; },
  };
  schedule(); return clock;
}
