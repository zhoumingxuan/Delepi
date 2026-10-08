import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BackgroundLearningPanel } from '../../src/renderer/components/AutonomyCenterDrawer';
const ok = (result: any) => ({ ok: true, result });
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(yes => { resolve = yes; }); return { promise, resolve }; }
function check(value: unknown, text: string) { if (!value) throw new Error(text); }
async function until(predicate: () => boolean) { const started = Date.now(); while (!predicate()) { if (Date.now() - started > 3500) throw new Error('Background UI timeout: ' + document.body.textContent); await new Promise(resolve => setTimeout(resolve, 5)); } }
const flush = () => new Promise(resolve => setTimeout(resolve, 25));
function button(host: HTMLElement, title: string) { const found = [...host.querySelectorAll('button')].find(item => item.textContent === title); if (!found) throw new Error('Missing button ' + title); return found; }
function select(host: HTMLElement, label: string, value: string) { const field = host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement; check(field, 'Missing select ' + label); for (const option of field.options) option.selected = option.value === value; field.dispatchEvent(new Event('change', { bubbles: true })); }
function checkbox(host: HTMLElement, label: string) { const found = [...host.querySelectorAll('label')].find(item => item.textContent === label)?.querySelector('input') as HTMLInputElement; check(found, 'Missing checkbox ' + label); return found; }
const limits = { modelRequests: 6, fetchRequests: 8, downloadBytes: 5242880, storageBytes: 5242880, tokenUnits: 100000, activeMilliseconds: 300000, absoluteMilliseconds: 900000, maxDocumentBytes: 1048576, concurrency: 2 };
const destination = (revision = 1) => ({ id: 'destination-1', label: '公开模型', endpointOrigin: 'https://model.example.com', model: 'fixture-model', revision, available: true });
const goal = (revision = 1) => ({ id: 'goal-1', revision, state: 'active', title: '公开研究主题', topic: '公开问题', sourceUrls: ['https://example.com/public'], destinationId: 'destination-1', expectedOutput: '带出处简报', stopConditions: '完成简报停止', limits, dataScopeId: 'public-goal-1', createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z' });
const schedule = (patch: any = {}) => ({ id: 'schedule-1', revision: 1, goalId: 'goal-1', goalRevision: 1, state: 'enabled', intervalMinutes: 30, dailyRoundLimit: 3, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), protocol: 'chat-completions', learningEnabled: true, autoPromote: true, nextDueAt: new Date(Date.now() + 1800000).toISOString(), ruleId: 'rule-1', roundsToday: 0, createdAt: '2030-01-01T00:00:00.000Z', ...patch });
const exploration = (state = 'running') => ({ id: 'exploration-1', goalId: 'goal-1', goalRevision: 1, destination: destination(), runId: 'run-1', state, phase: 'fetching', sourceCount: 0, sourceTotal: 1, createdAt: new Date().toISOString() });
const skill = (revision = 1) => ({ id: 'skill-1', goalId: 'goal-1', goalRevision: 1, title: '有来源的方法', summary: '纯文本摘要', revision, activeVersionId: 'version-' + revision, activeOrdinal: revision, versionCount: revision, candidateCount: 0, latestStatus: 'active', sourceRunId: 'run-source', sourceArtifactId: 'artifact-source', sourceRefs: ['source-1'], updatedAt: new Date().toISOString() });
async function mounted(overrides: any = {}, props: any = {}) {
  const confirms: any[] = [], calls: Array<{ name: string; args: any[] }> = [], errors: string[] = [], infos: string[] = [], successes: string[] = [];
  let wake: () => void = () => {}, listReads = 0, unsubscribed = false;
  (window as any).__autonomyUiServices = { message: { error: (value: string) => errors.push(value), info: (value: string) => infos.push(value), success: (value: string) => successes.push(value) }, modal: { confirm: (options: any) => { confirms.push(options); return { destroy: () => { options.destroyed = true; } }; } } };
  const api: any = {
    status: async () => ok({ ready: true, appMustRemainRunning: true }), list: async () => { listReads++; return ok([]); }, listSkills: async () => ok([]),
    configure: async () => ok(schedule()), setEnabled: async () => ok(schedule()), runNow: async () => ok(schedule()), rollbackSkill: async () => ok({ skillId: 'skill-1', revision: 2, status: 'inactive' }),
    onChanged: (callback: () => void) => { wake = callback; return () => { unsubscribed = true; wake = () => {}; }; },
    ...overrides,
  };
  for (const name of ['configure', 'setEnabled', 'runNow', 'rollbackSkill']) { const original = api[name]; api[name] = (...args: any[]) => { calls.push({ name, args }); return original(...args); }; }
  (window as any).electronAPI = { background: overrides.absent ? undefined : api, autonomy: { stopExploration: async (...args: any[]) => { calls.push({ name: 'stopExploration', args }); return ok(undefined); } } };
  let setProps!: (value: any) => void;
  function Harness() { const [current, setCurrent] = useState({ goals: [goal()], destinations: [destination()], explorations: [], ...props }); setProps = (value: any) => setCurrent((old: any) => ({ ...old, ...value })); return <BackgroundLearningPanel {...current as any} />; }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); root.render(<Harness />);
  await until(() => host.textContent?.includes(overrides.absent ? '入口尚未就绪' : overrides.notReady ? '后台与学习尚未就绪' : '后台入口已就绪') === true); await flush();
  return { host, api, confirms, calls, errors, infos, successes, setProps, wake: () => wake(), listReads: () => listReads, unsubscribed: () => unsubscribed, unmount: () => { root.unmount(); host.remove(); } };
}
async function prepare(f: Awaited<ReturnType<typeof mounted>>) {
  select(f.host, '后台所属主题', 'goal-1'); await flush(); checkbox(f.host, '我确认公开来源、模型目的地、有限期限与自动学习范围').click(); await flush();
}
async function run() {
  const results: string[] = [];
  {
    const f = await mounted({ absent: true }); check(button(f.host, '确认范围并启用后台').disabled, 'Missing bridge keeps execution disabled'); check(f.calls.length === 0, 'Missing background cannot dispatch'); check(f.host.textContent?.includes('退出应用或电脑睡眠时不执行') && f.host.textContent.includes('不执行代码'), 'Runtime constraints stay explicit'); f.unmount(); results.push('missing background API remains honest and disabled with app/sleep/text-only limits');
  }
  {
    const f = await mounted(); select(f.host, '后台所属主题', 'goal-1'); await flush(); check(button(f.host, '确认范围并启用后台').disabled, 'Scope consent required'); select(f.host, '后台模型协议', 'responses'); await flush(); checkbox(f.host, '我确认公开来源、模型目的地、有限期限与自动学习范围').click(); await flush();
    button(f.host, '确认范围并启用后台').click(); check(f.calls.length === 0, 'Opening confirmation never enables'); const c = f.confirms[0]; check(c.title === '确认后台公开范围与学习？', 'Scope modal displayed'); await c.onOk(); check(f.calls.length === 1 && f.calls[0].name === 'configure', 'One explicit activation'); const args = f.calls[0].args; check(args[0] === 'goal-1' && args[1] === 1 && args[2].intervalMinutes === 30 && args[2].dailyRoundLimit === 3 && args[2].protocol === 'responses' && args[2].learningEnabled && args[2].autoPromote, 'Narrow revision/period/protocol defaults'); check(Date.parse(args[2].expiresAt) - Date.now() > 6.99 * 86400000 && Date.parse(args[2].expiresAt) - Date.now() <= 7 * 86400000, 'Finite 7 day authorization'); f.unmount(); results.push('explicit finite public scope activation carries trusted goal CAS and selected model protocol');
  }
  {
    const f = await mounted(); await prepare(f); button(f.host, '确认范围并启用后台').click(); f.setProps({ goals: [goal(2)] }); await flush(); await f.confirms[0].onOk(); check(f.calls.length === 0 && button(f.host, '确认范围并启用后台').disabled, 'Stale goal confirmation cancelled and consent reset'); f.unmount(); results.push('goal revision changes invalidate activation and reset public scope consent');
  }
  {
    const f = await mounted(); await prepare(f); button(f.host, '确认范围并启用后台').click(); select(f.host, '后台模型协议', 'responses'); await flush(); await f.confirms[0].onOk(); check(f.calls.length === 0, 'Editing protocol invalidates captured confirmation'); check(button(f.host, '确认范围并启用后台').disabled, 'Changed protocol requires renewed checkbox'); f.unmount(); results.push('editing any configuration invalidates an older modal confirmation');
  }
  {
    let revision = 1, reads = 0;
    const f = await mounted({ list: async () => { reads++; return ok([schedule({ revision })]); }, configure: async () => { revision = 2; return { ok: false, code: 'REVISION_CONFLICT', message: '范围已经变化', retryable: true }; } });
    await prepare(f); button(f.host, '确认范围并启用后台').click(); const before = reads; await f.confirms[0].onOk(); check(f.errors.includes('范围已经变化') && reads > before && f.calls.length === 1, 'Conflict refreshes facts without replay'); check(f.successes.length === 0, 'No false success on rejected activation'); f.unmount(); results.push('CAS rejection refreshes facts and never automatically retries activation');
  }
  {
    let row = schedule({ lastRunId: 'run-1', roundsToday: 1 });
    const f = await mounted({ list: async () => ok([row]), setEnabled: async (_id: string, revision: number, enabled: boolean) => { row = schedule({ revision: revision + 1, state: enabled ? 'enabled' : 'paused', lastRunId: 'run-1', roundsToday: 1 }); return ok(row); } }, { explorations: [exploration()] });
    check(button(f.host, '立即运行一轮').disabled, 'No overlapping runNow while active'); button(f.host, '暂停后台').click(); check(f.calls.length === 0, 'Pause requires explicit modal'); await f.confirms[0].onOk(); check(f.calls[0].name === 'setEnabled' && f.calls[0].args[1] === 1 && f.calls[0].args[2] === false, 'Pause carries captured schedule CAS'); await until(() => button(f.host, '暂停后台').disabled && !button(f.host, '恢复后台').disabled);  f.setProps({ explorations: [] }); await flush(); button(f.host, '恢复后台').click(); await f.confirms[1].onOk(); check(f.calls[1].args[1] === 2 && f.calls[1].args[2] === true, 'Resume carries updated revision'); f.unmount(); results.push('pause drains the owning plan; resume uses the fresh schedule CAS');
  }
  {
    const f = await mounted({ list: async () => ok([schedule({ lastRunId: 'run-1' })]) }, { explorations: [exploration()] });
    button(f.host, '停止本轮').click(); f.setProps({ explorations: [exploration('completed')] }); await flush(); await f.confirms[0].onOk(); check(f.calls.length === 0 && button(f.host, '停止本轮').disabled, 'Completed Run cannot receive stale stop'); check(f.infos.some(text => text.includes('收尾或结束')), 'Terminal confirmation tells user facts'); f.unmount(); results.push('terminal exploration facts invalidate an already-open stop confirmation');
  }
  {
    let row = skill(), reads = 0;
    const f = await mounted({ listSkills: async () => { reads++; return ok([row]); }, rollbackSkill: async () => ok({ skillId: 'skill-1', revision: 3, status: 'inactive' }) });
    check(f.host.textContent?.includes('纯文本与来源校验通过') && f.host.textContent.includes('source-1') && f.host.textContent.includes('run-source') && f.host.textContent.includes('artifact-source'), 'Text validator and source provenance visible'); button(f.host, '回退学习版本').click(); row = skill(2); f.wake(); await until(() => f.host.textContent?.includes('第 2 版') === true); await f.confirms[0].onOk(); check(f.calls.length === 0 && f.infos.some(text => text.includes('学习版本已变化')), 'Stale rollback cannot affect new version'); button(f.host, '回退学习版本').click(); const before = reads; await f.confirms[1].onOk(); check(f.calls[0].name === 'rollbackSkill' && f.calls[0].args[1] === 2 && reads > before, 'User fresh rollback uses pointer CAS'); f.unmount(); results.push('learning provenance is displayed and rollback binds the current active pointer revision');
  }
  {
    const pending = deferred(); let reads = 0;
    const f = await mounted({ list: () => { reads++; return reads === 2 ? pending.promise : Promise.resolve(ok([schedule()])); } });
    button(f.host, '立即运行一轮').click(); f.wake(); await until(() => reads === 2); f.unmount(); pending.resolve(ok([schedule({ state: 'paused' })])); await f.confirms[0].onOk(); await flush(); check(f.calls.length === 0 && f.confirms[0].destroyed && f.unsubscribed(), 'Unmount cancels stale facts, confirmations and own subscription'); check(!document.body.querySelector('[data-testid="background-learning"]'), 'Closed panel stays closed'); results.push('unmount invalidates pending pulls and open dialogs and removes only its subscription');
  }
  {
    let row = schedule(), fail = false, reads = 0;
    const slow = deferred(); const f = await mounted({ list: () => { reads++; return reads === 2 ? slow.promise : Promise.resolve(ok([row])); }, listSkills: async () => fail ? { ok: false, code: 'OPERATION_FAILED', message: '学习读取失败', retryable: true } : ok([]) });
    f.wake(); await until(() => reads === 2); for (let n = 0; n < 20; n++) f.wake(); await flush(); check(reads === 2, 'Notification burst coalesces'); slow.resolve(ok([row])); await until(() => reads === 3); check(reads === 3, 'Only one trailing pull'); row = schedule({ state: 'paused' }); fail = true; f.wake(); await until(() => f.host.textContent?.includes('学习读取失败') === true); check(f.host.textContent?.includes('后台已启用') && !f.host.textContent?.includes('已暂停'), 'Failed aggregate preserves prior coherent facts'); check(button(f.host, '立即运行一轮').disabled, 'Read failure closes mutation readiness'); f.unmount(); results.push('coalesced refresh avoids overlap and failed snapshots preserve facts while closing admission');
  }
  return results;
}
(window as any).__runBackgroundScenarios = run;
