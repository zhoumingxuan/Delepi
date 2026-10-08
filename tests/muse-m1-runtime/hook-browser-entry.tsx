import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useExecutorTaskRecords } from '../../src/renderer/hooks/useExecutorTaskRecords';

const step = (action: string, extra: object = {}): Promise<any> => (window as any).runtimeFixture.step({ action, ...extra });
function check(value: unknown, text: string) { if (!value) throw new Error(text); }
async function until(predicate: () => boolean | Promise<boolean>, label = 'observation') {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Runtime hook fixture timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function run() {
  const results: string[] = [];
  let hook!: ReturnType<typeof useExecutorTaskRecords>;
  let mounted = false;
  function Probe() { hook = useExecutorTaskRecords({ conversationId: 'fixture-conv' }); useEffect(() => { mounted = true; }, []); return <output>{JSON.stringify(hook.taskViews)}</output>; }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); root.render(<Probe />);
  await until(() => mounted, 'React hook mount and subscriptions');
  await step('init'); await until(() => hook.taskViews.D?.taskId === 'T1', 'initial trusted task view');
  try {
    await step('send-mode', { mode: 'lost' });
    const lost = await hook.sendTaskMessage('D', 'same synthetic draft');
    check(!lost.accepted && lost.reason === 'ipc-error' && !!lost.messageId, 'Lost receipt must remain retryable with its original message ID');
    let state = await step('snapshot'); check(state.inbox.length === 1 && state.inbox[0].messageId === lost.messageId, 'Lost receipt must follow actual durable admission');
    const injected = await step('inject'); check(injected.count === 1 && injected.modelMessages.length === 2, 'Original accepted draft must inject once');
    const retry = await hook.sendTaskMessage('D', 'same synthetic draft');
    check(retry.accepted && retry.messageId === lost.messageId && retry.inboxState === 'injected', 'Retry must report the original persisted delivery');
    state = await step('inject'); check(state.count === 0 && state.inbox.length === 1 && state.modelMessages.length === 2, 'Retry must never enqueue or inject a second copy');
    const intentional = await hook.sendTaskMessage('D', 'same synthetic draft');
    state = await step('inject'); check(intentional.accepted && intentional.messageId !== lost.messageId && state.inbox.length === 2 && state.count === 1, 'After definite acceptance, an intentional identical append must have a new ID');
    results.push('lost durable receipt retries exactly one persisted ID and one model injection; intentional append allocates a new ID');

    await step('send-mode', { mode: 'hold' });
    const before = (await step('snapshot')).sends.length;
    const first = hook.sendTaskMessage('D', 'concurrent draft'); const second = hook.sendTaskMessage('D', 'concurrent draft');
    check(first === second, 'Concurrent same draft clicks must share one promise');
    await until(async () => (await step('snapshot')).sends.length === before + 1, 'held concurrent send');
    await step('release-send'); const [one, two] = await Promise.all([first, second]);
    check(one.messageId === two.messageId && (await step('snapshot')).sends.length === before + 1, 'Concurrent clicks must cross production preload/IPC once');
    await step('inject'); results.push('concurrent send reuses one in-flight request through production preload');

    await step('send-mode', { mode: 'lost' });
    const unknown = await hook.sendTaskMessage('D', 'unknown delivery draft'); await step('inject-fault');
    const unknownRetry = await hook.sendTaskMessage('D', 'unknown delivery draft');
    const unknownAgain = await hook.sendTaskMessage('D', 'unknown delivery draft');
    state = await step('inject');
    check(!unknownRetry.accepted && unknownRetry.inboxState === 'delivery_unknown' && unknownRetry.messageId === unknown.messageId, 'Unknown delivery retry must return the persisted uncertainty');
    check(unknownAgain.messageId === unknown.messageId && state.count === 0 && state.inbox.filter((row: any) => row.messageId === unknown.messageId).length === 1, 'Unknown delivery must never replay');
    results.push('actual SQLite delivery-confirmation fault remains delivery_unknown with no replay on retry');

    await step('send-mode', { mode: 'lost' });
    const cancelledDraft = await hook.sendTaskMessage('D', 'cancelled draft');
    await step('inject'); await step('begin-tool');
    await until(() => hook.taskViews.D?.entries.some(entry => entry.kind === 'tool' && entry.status === 'running') === true, 'actual tool still running');
    const beforeGets = (await step('snapshot')).gets.length; await step('stop');
    await until(async () => (await step('snapshot')).gets.length > beforeGets, 'stop authoritative GET');
    check(hook.taskViews.D.status === 'running' && !hook.taskViews.D.finishedAt, 'chat:aborted at stop request must not invent a task terminal time/state');
    check(hook.taskViews.D.entries.some(entry => entry.kind === 'tool' && entry.status === 'running' && !entry.finishedAt), 'Stop request must not invent tool terminal state');
    const rejected = await hook.sendTaskMessage('D', 'new draft while stopping');
    check(!rejected.accepted && rejected.reason === 'stop-requested' && rejected.inboxState === 'rejected', 'Append stays available so actual backend stop rejection is visible');
    await step('settle'); await until(() => hook.taskViews.D.status === 'aborted', 'actual aborted terminal');
    check(!!hook.taskViews.D.finishedAt, 'Real task settlement must provide terminal projection');
    const rejectedRetry = await hook.sendTaskMessage('D', 'new draft while stopping');
    check(!rejectedRetry.accepted && rejectedRetry.messageId !== rejected.messageId && rejectedRetry.inboxState === 'rejected' && rejectedRetry.reason === 'terminal', 'After a definite rejection, a new user click must receive a fresh authoritative terminal result');
    results.push('stop request pulls authoritative records and rejects fresh append; terminal UI follows actual settlement');

    // A different draft replaces the previous pending draft, so create a fresh lost cancelled receipt on a new task.
    hook.openTask('D'); await step('hold-get'); hook.openTask('D');
    await until(async () => await step('has-held-get'), 'old GET held before task switch');
    const oldLatest = hook.taskViews.D.latestSeq; check(oldLatest > 0, 'Old task needs real history for the identity/cursor test');
    await step('next-task'); await new Promise(resolve => setTimeout(resolve, 250)); await step('release-get');
    await until(() => hook.taskViews.D?.taskId === 'T2', 'new trusted task view');
    check(hook.taskViews.D.latestSeq === 0 && hook.taskViews.D.entries.length === 0 && hook.taskViews.D.status === 'running', 'Late old GET must not restore prior history or stale terminal state');
    const newSameDraft = await hook.sendTaskMessage('D', 'new draft while stopping');
    check(newSameDraft.accepted && newSameDraft.messageId !== rejected.messageId, 'New trusted task identity must allocate a new ID even for unchanged draft');
    const identityGets = (await step('snapshot')).gets; check(identityGets[identityGets.length - 1].sinceSeq === 0, 'Reused legacy delegate key must pull the new task from zero');
    await step('old-signal'); await new Promise(resolve => setTimeout(resolve, 250));
    check(hook.taskViews.D.taskId === 'T2', 'Older identity signal must not switch back to the previous task');
    results.push('trusted task identity resets draft/cursor and fences late old query and signal');

    await step('send-mode', { mode: 'lost' });
    const cancel = await hook.sendTaskMessage('D', 'cancel before injection'); await step('stop'); await step('settle');
    const cancelRetry = await hook.sendTaskMessage('D', 'cancel before injection'); const cancelAgain = await hook.sendTaskMessage('D', 'cancel before injection');
    state = await step('snapshot');
    check(!cancelRetry.accepted && cancelRetry.inboxState === 'cancelled' && cancelRetry.messageId === cancel.messageId, 'Unknown receipt retry must first resolve the original actual cancellation');
    check(!cancelAgain.accepted && cancelAgain.reason === 'terminal' && cancelAgain.messageId !== cancel.messageId, 'After confirmed cancellation, another click must receive a fresh terminal rejection');
    check(state.inbox.filter((row: any) => row.messageId === cancel.messageId).length === 1, 'Cancelled retry must not add an inbox row');
    check(cancelledDraft.messageId !== cancel.messageId, 'Different task and draft must not inherit an old ID');
    results.push('cancelled receipt retries preserve actual cancellation with one row');

    await step('next-task'); await until(() => hook.taskViews.D?.taskId === 'T3', 'queue retry task view');
    for (let index = 0; index < 10; index++) check((await hook.sendTaskMessage('D', 'fill queue ' + index)).accepted, 'Ten distinct pending drafts must fit the real queue');
    const queueFull = await hook.sendTaskMessage('D', 'retry after queue drains');
    check(!queueFull.accepted && queueFull.reason === 'queue-full' && queueFull.inboxState === 'rejected', 'Full queue must provide definite persisted rejection');
    check((await step('inject')).count === 10, 'Real queue drain must inject the ten admitted drafts');
    const afterDrain = await hook.sendTaskMessage('D', 'retry after queue drains');
    state = await step('inject');
    check(afterDrain.accepted && afterDrain.messageId !== queueFull.messageId && state.count === 1, 'User retry after definite queue-full must use a new ID and become deliverable');
    check(state.inbox.find((row: any) => row.messageId === queueFull.messageId).state === 'rejected', 'Original queue-full receipt must remain immutable');
    results.push('definite queue-full rejection allows a fresh manual request after queue drain while keeping its original receipt');
    return results;
  } finally { root.unmount(); host.remove(); }
}
(window as any).__runRuntimeHookScenarios = run;
