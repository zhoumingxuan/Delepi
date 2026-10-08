import React from 'react';
import { createRoot } from 'react-dom/client';
import { useExecutorTaskRecords } from '../../src/renderer/hooks/useExecutorTaskRecords';

const step = (action: string, extra: object = {}): Promise<any> => (window as any).runtimeFixture.step({ action, ...extra });
function check(value: unknown, reason: string) { if (!value) throw new Error(reason); }
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Independent hook queue observation timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function run() {
  let hook!: ReturnType<typeof useExecutorTaskRecords>;
  function Probe() { hook = useExecutorTaskRecords({ conversationId: 'fixture-conv' }); return <output>{JSON.stringify(hook.taskViews)}</output>; }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); root.render(<Probe />);
  try {
    await until(() => !!hook); await new Promise(resolve => setTimeout(resolve, 10));
    await step('init'); await until(() => hook.taskViews.D?.taskId === 'T1');
    for (let index=0;index<10;index++) {
      const accepted=await hook.sendTaskMessage('D', `synthetic fill ${index}`);
      check(accepted.accepted, 'Queue fixture admission failed before its documented capacity');
    }
    const rejected=await hook.sendTaskMessage('D', 'retry after queue full');
    check(!rejected.accepted && rejected.reason === 'queue-full' && rejected.inboxState === 'rejected', 'Full queue must persist a definite rejected receipt');
    const drained=await step('inject');
    check(drained.count === 10, 'Actual safe point must drain all ten accepted messages');
    const retry=await hook.sendTaskMessage('D', 'retry after queue full');
    check(retry.accepted, 'Queue was drained, but unchanged draft still reused its permanently rejected ID');
    check(retry.messageId !== rejected.messageId, 'Fresh user retry after a definite queue-full rejection needs a new ID');
    const confirmed=await step('inject');
    check(confirmed.count === 1, 'Only the newly admitted retry should inject');
    const state=await step('snapshot');
    check(state.inbox.filter((row:any)=>row.messageId===rejected.messageId && row.state==='rejected').length===1, 'Original rejection receipt must remain intact');
    check(state.inbox.filter((row:any)=>row.messageId===retry.messageId && row.state==='injected').length===1, 'Retry has its own confirmed delivery receipt');
    return ['independent real React/preload/SQLite queue-full retry succeeds after safe-point drain while original rejection stays immutable'];
  } finally { root.unmount(); host.remove(); }
}
(window as any).__runRuntimeHookScenarios = run;
