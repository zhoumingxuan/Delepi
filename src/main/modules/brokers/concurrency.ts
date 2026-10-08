import { BrokerError } from './contracts';

export function createBrokerConcurrency(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2) throw new BrokerError('INVALID_CONCURRENCY');
  let active = 0;
  const waiters: Array<() => void> = [];
  const lease = () => {
    let released = false;
    return () => { if (released) return; released = true; active--; waiters.shift()?.(); };
  };
  async function acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new BrokerError('CANCELLED');
    if (active < limit && waiters.length === 0) { active++; return lease(); }
    return new Promise<() => void>((resolve, reject) => {
      // Reserve the handed-off slot before waking the Promise; a new arrival cannot steal it.
      const wake = () => { signal.removeEventListener('abort', abort); active++; resolve(lease()); };
      const abort = () => { const index = waiters.indexOf(wake); if (index >= 0) waiters.splice(index, 1); signal.removeEventListener('abort', abort); reject(new BrokerError('CANCELLED')); };
      waiters.push(wake); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  return { acquire, get active() { return active; }, get waiting() { return waiters.length; } };
}
export type BrokerConcurrency = ReturnType<typeof createBrokerConcurrency>;
