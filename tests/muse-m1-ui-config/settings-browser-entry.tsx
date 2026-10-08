import React from 'react';
import { createRoot } from 'react-dom/client';
import { useSettings } from '../../src/renderer/hooks/useSettings';

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function check(value: unknown, text: string) { if (!value) throw new Error(text); }
async function until(predicate: () => boolean) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > 3000) throw new Error('Hook fixture timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function mounted() {
  const reads: Deferred<any>[] = [], writes: Array<Deferred<any> & { kind: string; params: any }> = [];
  (window as any).electronAPI = { config: {
    get: () => { const next = deferred<any>(); reads.push(next); return next.promise; },
    save: (params: any) => { const next = { ...deferred<any>(), kind: 'single', params }; writes.push(next); return next.promise; },
    saveBatch: (params: any) => { const next = { ...deferred<any>(), kind: 'batch', params }; writes.push(next); return next.promise; },
    reload: async () => {},
  } };
  let hook!: ReturnType<typeof useSettings>;
  function Harness() { hook = useSettings(); return <output>{JSON.stringify(hook.config)}</output>; }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); root.render(<Harness />);
  await until(() => reads.length === 1);
  return { reads, writes, get hook() { return hook; }, unmount: () => { root.unmount(); host.remove(); } };
}

async function run() {
  const results: string[] = [];
  {
    const f = await mounted();
    const pending = f.hook.saveConfig('mainModelName', 'new-model');
    await until(() => f.hook.config.mainModelName === 'new-model');
    check(f.writes.length === 0, 'Save must wait for the initial config read');
    f.reads[0].resolve({ revision: 1, settings: { mainModelName: 'old-model', executorModelName: 'preserved-executor' } });
    await until(() => f.writes.length === 1);
    check(f.writes[0].params.expectedRevision === 1, 'Initial read revision must drive first CAS');
    check(f.hook.config.mainModelName === 'new-model', 'Initial read must retain optimistic draft');
    f.writes[0].resolve({ revision: 2 }); await pending;
    await until(() => f.hook.config.executorModelName === 'preserved-executor');
    check(f.hook.config.mainModelName === 'new-model', 'Successful save must retain new config');
    const reload = f.hook.reloadConfig(); await until(() => f.reads.length === 2);
    const next = f.hook.saveConfig('mainModelName', 'newer-model');
    f.reads[1].resolve({ revision: 1, settings: { mainModelName: 'stale-model', executorModelName: 'stale-executor' } }); await reload;
    await until(() => f.writes.length === 2);
    check(f.writes[1].params.expectedRevision === 2, 'Stale GET must not lower the CAS revision');
    f.writes[1].resolve({ revision: 3 }); await next;
    await until(() => f.hook.config.mainModelName === 'newer-model');
    check(f.hook.config.executorModelName === 'preserved-executor', 'Stale GET must not overwrite unrelated config');
    f.unmount(); results.push('initial read/save serialization and stale GET cannot overwrite successful config/revision');
  }
  {
    const f = await mounted();
    f.reads[0].resolve({ revision: 4, settings: { mainModelName: 'stored-model', visionLlmModel: 'preserved-vision' } });
    await until(() => !f.hook.loading);
    const first = f.hook.saveConfig('mainModelName', 'will-fail').then(() => false, () => true);
    const second = f.hook.saveAllConfig({ mainModelName: 'queued-model', mainThinkingLevel: '' });
    await until(() => f.writes.length === 1);
    f.writes[0].reject(new Error('fixture save fault')); await until(() => f.reads.length === 2);
    check(f.hook.config.mainModelName === 'queued-model', 'Rollback must retain later pending draft');
    f.reads[1].resolve({ revision: 4, settings: { mainModelName: 'stored-model', visionLlmModel: 'preserved-vision' } });
    check(await first, 'First failed save must reject'); await until(() => f.writes.length === 2);
    check(f.writes[1].kind === 'batch', 'Multi-key save must use exactly one batch API');
    check(f.writes[1].params.expectedRevision === 4, 'Queued save must use rollback read revision');
    check(f.writes[1].params.patch.mainThinkingLevel === '', 'Empty thinking level must remain in batch');
    f.writes[1].resolve({ revision: 5 }); await second;
    await until(() => f.hook.config.mainModelName === 'queued-model');
    check(f.hook.config.mainThinkingLevel === '', 'Successful queued draft must appear after rollback');
    check(f.hook.config.visionLlmModel === 'preserved-vision', 'Rollback must retain stored unrelated keys');
    check(f.writes.length === 2, 'Batch API must not be decomposed into per-key writes');
    f.unmount(); results.push('failed save rollback preserves the next queued batch and provider-default thinking');
  }
  return results;
}
(window as any).__runSettingsHookScenarios = run;
