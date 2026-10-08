import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AutonomyCenterDrawer } from '../../src/renderer/components/AutonomyCenterDrawer';
const ok = (result: any) => ({ ok: true, result });
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(yes => { resolve = yes; }); return { promise, resolve }; }
function check(value: unknown, text: string) { if (!value) throw new Error(text); }
async function until(predicate: () => boolean) { const started = Date.now(); while (!predicate()) { if (Date.now() - started > 3500) throw new Error('Autonomy UI timeout: ' + document.body.textContent); await new Promise(resolve => setTimeout(resolve, 5)); } }
const flush = () => new Promise(resolve => setTimeout(resolve, 30));
function button(host: HTMLElement, title: string) { const found = [...host.querySelectorAll('button')].find(item => item.textContent === title); if (!found) throw new Error('Missing button ' + title); return found; }
function select(host: HTMLElement, label: string, values: string[]) { const field = host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement; check(field, 'Missing select ' + label); for (const option of field.options) option.selected = values.includes(option.value); field.dispatchEvent(new Event('change', { bubbles: true })); }
const limits = { modelRequests: 6, fetchRequests: 8, downloadBytes: 5242880, storageBytes: 5242880, tokenUnits: 100000, activeMilliseconds: 300000, absoluteMilliseconds: 900000, maxDocumentBytes: 1048576, concurrency: 2 };
const destination = { id: 'destination-1', label: '公开模型', endpointOrigin: 'https://model.example.com', model: 'fixture-model', revision: 1, available: true };
const goal = (id = 'goal-1', revision = 1) => ({ id, revision, state: 'active', title: '主题 ' + id, topic: '公开问题', sourceUrls: ['https://example.com/' + id], destinationId: destination.id, expectedOutput: '带出处简报', stopConditions: '完成简报停止', limits, dataScopeId: 'public-' + id, createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z' });
const resource = (id = 'resource-1', goalId = 'goal-1') => ({ id, goalId, dataScopeId: 'public-' + goalId, kind: 'public_url', url: 'https://example.com/' + id, contentHash: 'fixture-hash', sizeBytes: 0, revision: 1 });
const approval = (expiresAt = new Date(Date.now() + 60000).toISOString()) => ({ id: 'approval-1', revision: 1, state: 'pending', goalId: 'goal-1', goalRevision: 1, runId: 'run-1', attemptId: 'attempt-1', action: { capability: 'model.invoke', resourceRef: 'resource-1', resourceVersion: '1', destinationRef: destination.id, summary: '发送一份已登记公开资料', units: limits }, resourceLabel: 'https://example.com/resource-1', destinationLabel: 'https://model.example.com · fixture-model', expiresAt, authorizationExpiresAt: new Date(Date.now() + 900000).toISOString(), createdAt: '2030-01-01T00:00:00.000Z' });
const preview = (goalId = 'goal-1') => ({ id: 'rule-preview-1', revision: 1, goalId, goalRevision: 1, capabilities: ['fetch.public'], resources: [resource('resource-' + goalId, goalId)], destination, limits, expiresAt: new Date(Date.now() + 3600000).toISOString(), previewExpiresAt: new Date(Date.now() + 60000).toISOString(), resumeAfterRestart: false });
const explorationPlan = (protocol = 'chat-completions', revision = 1, goalRevision = 1) => ({ id: 'exploration-plan-1', revision, goalId: 'goal-1', goalRevision, protocol, sources: [resource()], destination, limits, expiresAt: new Date(Date.now() + 60000).toISOString() });
const exploration = (state = 'running', phase = 'fetching') => ({ id: 'exploration-1', goalId: 'goal-1', goalRevision: 1, destination, runId: 'exploration-run-1', state, phase, sourceCount: 0, sourceTotal: 1, additionCount: 0, activeRemainingMilliseconds: 300000, absoluteRemainingMilliseconds: 900000, createdAt: new Date().toISOString() });
function input(host: HTMLElement, label: string, value: string) { const field = host.querySelector(`textarea[aria-label="${label}"]`) as HTMLTextAreaElement; check(field, 'Missing field ' + label); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); }
async function mounted(overrides: any = {}) {
  const confirms: any[] = [], calls: Array<{ name: string; args: any[] }> = [], errors: string[] = [], infos: string[] = [];
  let wake: () => void = () => {}, listCount = 0;
  (window as any).__autonomyUiServices = { message: { error: (value: string) => errors.push(value), info: (value: string) => infos.push(value) }, modal: { confirm: (options: any) => { confirms.push(options); return { destroy: () => { options.destroyed = true; } }; } } };
  const api: any = {
    status: async () => ok({ explorationReady: false }), budget: async () => ok({ accounts: [] }), listExplorations: async () => ok([]),
    planExploration: async (_id: string, _revision: number, protocol: string) => ok(explorationPlan(protocol)), stopExploration: async () => ok(undefined), appendPublicMessage: async () => ok({ accepted: true }),
    listGoals: async () => { listCount++; return ok([goal(), goal('goal-2')]); }, listDestinations: async () => ok([destination]), listApprovals: async () => ok([approval()]), listRules: async () => ok([]), listGrants: async () => ok([]),
    getPolicy: async () => ok({ revision: 1, deniedCapabilities: [], deniedLegacyTools: [], warnings: ['禁用不会自动授权其他能力'] }),
    osStatus: async () => ok([{ kind: 'fullDisk', label: '完全磁盘访问', status: 'unknown', querySupported: false, requestSupported: false, settingsSupported: true, checkedAt: '2030-01-01T00:00:00.000Z', detail: '没有可靠查询，请在系统设置确认' }, { kind: 'camera', label: '摄像头', status: 'unknown', querySupported: true, requestSupported: true, settingsSupported: true, checkedAt: '2030-01-01T00:00:00.000Z', detail: '尚未向系统申请' }]),
    getGoal: async (id: string) => ok({ goal: goal(id), resources: [resource('resource-' + id, id)] }),
    previewRule: async () => ok(preview()), issueRule: async () => ok({}), decideApproval: async () => ok({ revision: 2 }), setGoalState: async () => ok({}), updateGoal: async () => ok({}), createGoal: async () => ok({}), revokeRule: async () => ok(undefined), revokeGrant: async () => ok(undefined), updatePolicy: async () => ok({}), requestOs: async () => ok({ status: 'unknown' }), openOsSettings: async () => ok({ opened: true }),
    startExploration: async () => { throw Error('A/B must not execute exploration'); }, onChanged: (callback: () => void) => { wake = callback; return () => { wake = () => {}; }; },
    ...overrides,
  };
  for (const name of ['previewRule', 'issueRule', 'decideApproval', 'setGoalState', 'updateGoal', 'createGoal', 'requestOs', 'openOsSettings', 'planExploration', 'startExploration', 'stopExploration', 'appendPublicMessage']) { const original = api[name]; api[name] = (...args: any[]) => { calls.push({ name, args }); return original(...args); }; }
  (window as any).electronAPI = { autonomy: api, muse: { openArtifact: async (id: string) => { calls.push({ name: 'openArtifact', args: [id] }); return ok(undefined); } } };
  let setConversation!: (id: string) => void, setOpen!: (open: boolean) => void;
  function Harness() { const [conversation, setCurrent] = useState('conversation-1'), [open, setVisible] = useState(true); setConversation = setCurrent; setOpen = setVisible; return <AutonomyCenterDrawer open={open} onClose={() => setVisible(false)} conversationId={conversation} />; }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); root.render(<Harness />);
  await until(() => host.textContent?.includes('主题 goal-1') === true); await flush();
  return { host, api, confirms, calls, errors, infos, setConversation, setOpen, wake: () => wake(), listCount: () => listCount, unmount: () => { root.unmount(); host.remove(); } };
}
async function setupRule(f: Awaited<ReturnType<typeof mounted>>) {
  button(f.host, '长期规则').click(); await flush(); select(f.host, '选择规则所属主题', ['goal-1']); await until(() => f.host.querySelector('option[value="resource-goal-1"]') !== null);
  (f.host.querySelector('input[value="fetch.public"]') as HTMLInputElement).click(); await flush(); select(f.host, '选择已登记的公开资源', ['resource-goal-1']); await flush();
}
async function run() {
  const results: string[] = [];
  {
    const f = await mounted(); check(button(f.host, '手动探索（准备中）').disabled, 'Exploration must stay disabled'); button(f.host, '暂停主题').click(); check(f.calls.length === 0, 'Pause must require user modal');
    await f.confirms[0].onOk(); check(f.calls[0].args[0] === 'goal-1' && f.calls[0].args[1] === 1 && f.calls[0].args[2] === 'paused', 'Pause must carry captured revision');
    f.unmount(); results.push('A/B exploration disabled and goal pause requires explicit CAS confirmation');
  }
  {
    const pending = deferred(); let reads = 0;
    const f = await mounted({ listGoals: () => { reads++; return reads === 2 ? pending.promise : Promise.resolve(ok([goal(reads > 2 ? 'goal-new' : 'goal-1')])); } });
    button(f.host, '刷新').click(); await until(() => reads === 2); f.setConversation('conversation-2'); await until(() => f.host.textContent?.includes('主题 goal-new') === true);
    pending.resolve(ok([goal('goal-stale')])); await flush(); check(!f.host.textContent?.includes('goal-stale'), 'Late old load must not enter new scope'); f.setOpen(false); await flush(); check(!f.host.querySelector('[data-drawer]'), 'Close removes scope'); f.unmount();
    results.push('late load after conversation switch and close cannot publish stale scopes');
  }
  {
    const f = await mounted(); f.api.listGoals = async () => ok([goal('goal-partial')]); f.api.osStatus = async () => ({ ok: false, code: 'OPERATION_FAILED', message: '系统读取失败', retryable: true });
    button(f.host, '刷新').click(); await until(() => f.host.textContent?.includes('系统读取失败') === true); check(f.host.textContent?.includes('主题 goal-1'), 'Old coherent snapshot retained'); check(!f.host.textContent?.includes('goal-partial'), 'Partial successful load must not publish'); f.unmount();
    results.push('failed aggregate refresh preserves the complete prior authorization snapshot');
  }
  {
    const oldResources = deferred(), f = await mounted({ getGoal: (id: string) => id === 'goal-1' ? oldResources.promise : Promise.resolve(ok({ goal: goal(id), resources: [resource('resource-new', id)] })) });
    button(f.host, '长期规则').click(); await flush(); select(f.host, '选择规则所属主题', ['goal-1']); await flush(); select(f.host, '选择规则所属主题', ['goal-2']); await until(() => f.host.querySelector('option[value="resource-new"]') !== null);
    oldResources.resolve(ok({ goal: goal(), resources: [resource('resource-old')] })); await flush(); check(!f.host.querySelector('option[value="resource-old"]'), 'Late resources from previous goal must not replace current'); f.unmount();
    results.push('rule resources remain bound to the latest selected goal');
  }
  {
    const pending = deferred(), f = await mounted({ previewRule: () => pending.promise }); await setupRule(f); button(f.host, '预览长期规则').click(); await until(() => f.calls.length === 1);
    f.setConversation('conversation-new'); await until(() => !(f.host.querySelector('select[aria-label="选择规则所属主题"]') as HTMLSelectElement)?.disabled); pending.resolve(ok(preview())); await flush();
    check(!f.host.querySelector('[data-modal="确认长期规则范围"]'), 'Late preview cannot reopen after scope changed'); check(!f.calls.some(item => item.name === 'issueRule'), 'Preview never grants'); f.unmount();
    results.push('late rule preview cannot reopen in another conversation or issue a rule');
  }
  {
    const f = await mounted(); await setupRule(f); button(f.host, '预览长期规则').click(); await until(() => Boolean(f.host.querySelector('[data-modal="确认长期规则范围"]')));
    const modal = f.host.querySelector('[data-modal="确认长期规则范围"]')!; const text = modal.textContent ?? '';
    check(text.includes('https://example.com/resource-goal-1') && text.includes('https://model.example.com') && text.includes('fixture-model') && text.includes('规则有效至') && text.includes('Token 保守预留') && text.includes('本次绝对时限'), 'Rule preview must show resource/destination/expiry/all limits');
    check(f.calls.length === 1 && f.calls[0].name === 'previewRule', 'Preview is separate from issuance'); button(f.host, '确认签发规则').click(); await until(() => f.calls.length === 2); check(f.calls[1].name === 'issueRule' && f.calls[1].args[1] === 1, 'Explicit rule issuance carries preview revision'); f.unmount();
    results.push('long-term rule uses distinct preview and issuance with visible resource, model, expiry and limits');
  }
  {
    const f = await mounted(); button(f.host, '批准卡（1）').click(); await flush(); button(f.host, '仅这一次').click();
    const text = JSON.stringify(f.confirms[0].content); check(text.includes('https://example.com/resource-1') && text.includes('https://model.example.com') && text.includes('批准卡确认期限') && text.includes('本次运行期限') && text.includes('2 分钟'), 'Approval confirmation displays scope and separate confirmation/authorization TTLs');
    f.setConversation('conversation-2'); await flush(); check(f.confirms[0].destroyed === true, 'Scope switch must close old approval modal'); await f.confirms[0].onOk(); check(f.calls.length === 0, 'Stale approval modal must not invoke');
    button(f.host, '仅这一次').click(); f.api.decideApproval = async (...args: any[]) => { f.calls.push({ name: 'decideApproval', args }); return { ok: false, code: 'REVISION_CONFLICT', message: '范围已更新', retryable: true }; };
    const beforeReads = f.listCount(); await f.confirms[1].onOk(); await flush(); check(f.calls.length === 1 && f.errors[0] === '范围已更新' && f.listCount() > beforeReads, 'Conflict refreshes but never retries decision'); f.unmount();
    results.push('scope-changed approval does nothing and conflicts refresh without automatic reapproval');
  }
  {
    const expiresAt = new Date(Date.now() + 1600).toISOString(), f = await mounted({ listApprovals: async () => ok([approval(expiresAt)]) }); button(f.host, '批准卡（1）').click(); await flush(); button(f.host, '仅这一次').click();
    await new Promise(resolve => setTimeout(resolve, 1800)); await f.confirms[0].onOk(); check(f.calls.length === 0 && f.infos.some(text => text.includes('过期')), 'Expiry checked again at confirmation time');
    await until(() => button(f.host, '仅这一次').disabled); f.unmount(); results.push('approval expiry disables controls and rechecks before executing modal confirmation');
  }
  {
    const f = await mounted(); button(f.host, '权限管理').click(); await flush(); const text = f.host.textContent ?? '';
    check(text.includes('需在系统设置确认') && text.includes('没有可靠查询') && ![...f.host.querySelectorAll('span')].some(item => item.textContent === '系统已授权'), 'Unknown TCC must stay unknown'); const requestButtons = [...f.host.querySelectorAll('button')].filter(item => item.textContent === '申请系统权限');
    check(requestButtons[0].disabled && !requestButtons[1].disabled, 'Only supported explicit request is actionable'); check(f.calls.length === 0, 'Panel viewing performs no prompts/settings actions'); requestButtons[1].click(); check(f.calls.length === 0, 'System request has explicit confirm'); await f.confirms[0].onOk(); check(f.calls[0].name === 'requestOs' && f.calls[0].args[0] === 'camera', 'User system confirmation invokes only chosen permission');
    check(![...f.host.querySelectorAll('span')].some(item => item.textContent === '系统已授权'), 'Request response does not forge grant status'); button(f.host, '打开系统设置').click(); await until(() => f.calls.length === 2); check(f.calls[1].name === 'openOsSettings' && f.calls[1].args[0] === 'fullDisk', 'Settings opens only explicitly chosen fixed kind'); f.unmount();
    results.push('unknown OS status stays truthful; prompts and settings require explicit user controls');
  }
  {
    let sessions: any[] = [];
    const f = await mounted({ status: async () => ok({ explorationReady: true }), listExplorations: async () => ok(sessions), startExploration: async () => { sessions = [exploration()]; return ok(sessions[0]); } });
    button(f.host, '手动探索').click(); await flush(); check(f.calls.length === 0, 'Opening planner cannot invoke model or create Run'); select(f.host, '公开模型协议', ['responses']); await flush(); button(f.host, '预览本次探索').click(); await until(() => f.host.textContent?.includes('计划确认期限') === true);
    check(f.calls.length === 1 && f.calls[0].name === 'planExploration' && f.calls[0].args[2] === 'responses', 'Plan explicitly selects protocol');
    const text = f.host.querySelector('[data-modal="确认本次公开探索"]')!.textContent ?? ''; check(text.includes('https://example.com/resource-1') && text.includes('https://model.example.com') && text.includes('Responses') && text.includes('Token 保守预留'), 'Static plan must display exact scope');
    button(f.host, '确认范围并开始').click(); await until(() => f.host.textContent?.includes('正在执行') === true); check(f.calls[1].name === 'startExploration' && f.calls[1].args[0] === 'exploration-plan-1' && f.calls[1].args[1] === 1, 'Start must only use plan ID/revision'); f.unmount();
    results.push('D static plan explicitly selects protocol and starts only after scoped confirmation');
  }
  {
    const pending = deferred(), f = await mounted({ status: async () => ok({ explorationReady: true }), planExploration: () => pending.promise });
    button(f.host, '手动探索').click(); await flush(); button(f.host, '预览本次探索').click(); await until(() => f.calls.length === 1); f.setConversation('conversation-new'); await flush(); pending.resolve(ok(explorationPlan())); await flush();
    check(!f.host.querySelector('[data-modal="确认本次公开探索"]') && !f.calls.some(item => item.name === 'startExploration'), 'Late plan cannot reopen or start after scope change'); f.unmount();
    results.push('D late plan preview cannot reopen or execute across scope changes');
  }
  {
    let revision = 1;
    const f = await mounted({ status: async () => ok({ explorationReady: true }), listGoals: async () => ok([goal('goal-1', revision)]), startExploration: async () => { revision = 2; return { ok: false, code: 'REVISION_CONFLICT', message: '计划范围已经更新', retryable: true }; }, planExploration: async (_id: string, goalRevision: number) => ok(explorationPlan('chat-completions', 1, goalRevision)) });
    button(f.host, '手动探索').click(); await flush(); button(f.host, '预览本次探索').click(); await until(() => Boolean(f.host.textContent?.includes('计划确认期限'))); button(f.host, '确认范围并开始').click(); await until(() => f.errors.includes('计划范围已经更新')); await flush();
    check(!f.host.textContent?.includes('计划确认期限'), 'Conflict clears stale plan'); check(f.calls.filter(item => item.name === 'startExploration').length === 1, 'Conflict cannot replay start'); button(f.host, '预览本次探索').click(); await until(() => f.calls.filter(item => item.name === 'planExploration').length === 2);
    check(f.calls.at(-1)?.args[1] === 2, 'Fresh user preview uses refreshed goal revision'); f.unmount(); results.push('D conflicting start clears the old plan and requires a new explicit preview with refreshed CAS');
  }
  {
    const expired = { ...explorationPlan(), expiresAt: new Date(Date.now() - 1).toISOString() }, f = await mounted({ status: async () => ok({ explorationReady: true }), planExploration: async () => ok(expired) });
    button(f.host, '手动探索').click(); await flush(); button(f.host, '预览本次探索').click(); await until(() => f.host.textContent?.includes('计划确认期限') === true); check(button(f.host, '确认范围并开始').disabled, 'Expired plan cannot start'); check(!f.calls.some(item => item.name === 'startExploration'), 'Expired plan makes no start call'); f.unmount();
    results.push('D expired static plans remain non-executable');
  }
  {
    let sessions = [{ ...exploration('waiting_approval'), pendingApprovalCount: 2 }];
    const f = await mounted({ status: async () => ok({ explorationReady: true }), listExplorations: async () => ok(sessions), stopExploration: async () => { sessions = [{ ...exploration('stop_requested'), stopReason: 'STOP_REQUESTED' }]; return ok(undefined); } });
    button(f.host, '探索进度').click(); await flush(); check(f.host.textContent?.includes('有 2 项操作等待批准'), 'Waiting cards visible'); button(f.host, '停止本次探索').click(); check(f.calls.length === 0, 'Stop needs explicit confirmation'); await f.confirms[0].onOk(); await flush();
    check(f.host.textContent?.includes('正在停止，等待收尾') && !f.host.textContent?.includes('已停止') && f.host.textContent?.includes('你已请求停止'), 'Stop acknowledgement cannot claim settled and actual reason is understandable'); check(f.calls[0].args[0] === 'exploration-run-1', 'Stop targets exact Run'); sessions = [{ ...exploration('stopped'), stopReason: 'STOP_REQUESTED' }]; f.wake(); await until(() => f.host.textContent?.includes('已停止') === true); check(button(f.host, '停止本次探索').disabled, 'Settled Run stop disabled'); f.unmount();
    results.push('D approval waiting and stop_requested are distinct from durable stopped state');
  }
  {
    const sessions = [exploration()]; let attempt = 0;
    const f = await mounted({ status: async () => ok({ explorationReady: true }), listDestinations: async () => ok([{ ...destination, revision: 2, endpointOrigin: 'https://changed-model.example.com', model: 'new-config-model' }]), listExplorations: async () => ok(sessions), appendPublicMessage: async () => ++attempt === 1 ? { ok: false, code: 'OPERATION_FAILED', message: '临时记录失败', retryable: true } : ok({ accepted: true }) });
    button(f.host, '探索进度').click(); await flush(); input(f.host, '公开补充-exploration-run-1', '这是一段可公开的补充'); await flush(); check(button(f.host, '确认公开补充').disabled, 'Unconfirmed text cannot queue'); const checkbox = [...f.host.querySelectorAll('label')].find(item => item.textContent?.includes('我确认这段内容'))!.querySelector('input')!; checkbox.click(); await flush(); button(f.host, '确认公开补充').click(); check(f.calls.length === 0, 'Public message requires separate confirmation'); await f.confirms[0].onOk(); await flush();
    const scopeText = JSON.stringify(f.confirms[0].content); check(scopeText.includes('https://model.example.com') && scopeText.includes('fixture-model') && scopeText.includes('本次主题版本') && !scopeText.includes('https://changed-model.example.com') && !scopeText.includes('new-config-model'), 'Public confirmation uses original Run scope, not current model configuration');
    const first = f.calls[0]; check(first.args[3] === true && first.args[2] === '这是一段可公开的补充', 'Explicit classification passed'); check((f.host.querySelector('textarea') as HTMLTextAreaElement).value === first.args[2], 'Failed queue preserves text'); button(f.host, '确认公开补充').click(); await f.confirms[1].onOk(); await flush(); check(f.calls[1].args[1] === first.args[1], 'Retry retains same message ID for FIFO dedup'); check(f.infos.some(text => text.includes('已排队')) && !f.infos.some(text => text.includes('模型已收到')), 'Queued receipt does not claim model injection');
    input(f.host, '公开补充-exploration-run-1', '晚到的未发送草稿'); await flush(); sessions[0] = exploration('running', 'summarizing'); f.wake(); await flush(); check(button(f.host, '确认公开补充').disabled, 'No additions after summarize safe point');
    sessions[0] = exploration('completed', 'settling'); f.wake(); await flush(); const lateDraft = f.host.querySelector('textarea') as HTMLTextAreaElement; check(lateDraft?.value === '晚到的未发送草稿' && lateDraft.readOnly && !lateDraft.disabled && f.host.textContent?.includes('可复制，在下一轮再次确认'), 'Terminal Run retains visible selectable draft without permitting an automatic send'); f.unmount();
    results.push('D explicit public FIFO queue retains stable message ID on retry and stops accepting after summarization');
  }
  {
    const amounts = { modelRequests: 1, fetchRequests: 2, downloadBytes: 3, storageBytes: 4, tokenUnits: 5 };
    const f = await mounted({ status: async () => ok({ explorationReady: true }), listExplorations: async () => ok([{ ...exploration('completed', 'settling'), additionCount: undefined, sourceCount: 1, artifactId: 'artifact-scoped' }]), budget: async () => ok({ accounts: [{ id: 'utc-fixture', kind: 'day', scope: 'day', limits, used: amounts, reserved: amounts, remaining: amounts, timezone: 'UTC', windowStart: '2030-01-01T00:00:00.000Z', windowEnd: '2030-01-02T00:00:00.000Z' }] }) });
    button(f.host, '自主阅读预算').click(); await flush(); check(f.host.textContent?.includes('UTC 窗口：2030-01-01') && f.host.textContent?.includes('预留（含未知用量）') && f.host.textContent?.includes('剩余'), 'UTC budget and unknown use labels visible'); button(f.host, '探索进度').click(); await flush(); button(f.host, '打开成果').click(); await until(() => f.calls.some(item => item.name === 'openArtifact')); check(f.calls[0].args[0] === 'artifact-scoped', 'Open only registered artifact ID'); check(f.host.textContent?.includes('验证和接受状态请在成果中心核对'), 'Saved does not claim validation or acceptance'); check(!f.host.textContent?.includes('已纳入总结补充'), 'Missing terminal count must not be displayed as a false zero'); f.unmount();
    results.push('D autonomous UTC budget shows remaining and unknown reservation; artifact opens only by registered ID');
  }
  {
    const f = await mounted({ status: async () => ok({ explorationReady: true }), listExplorations: async () => ok([exploration()]) });
    button(f.host, '探索进度').click(); await flush(); input(f.host, '公开补充-exploration-run-1', '仅当前范围可公开'); await flush(); [...f.host.querySelectorAll('label')].find(item => item.textContent?.includes('我确认这段内容'))!.querySelector('input')!.click(); await flush(); button(f.host, '确认公开补充').click();
    f.setConversation('conversation-2'); await flush(); check(f.confirms[0].destroyed, 'Scope switch destroys old public consent'); await f.confirms[0].onOk(); check(!f.calls.some(item => item.name === 'appendPublicMessage'), 'Stale public consent cannot enqueue');
    button(f.host, '停止本次探索').click(); f.setOpen(false); await flush(); check(f.confirms[1].destroyed, 'Closing destroys old stop confirmation'); await f.confirms[1].onOk(); check(!f.calls.some(item => item.name === 'stopExploration'), 'Stale stop confirmation cannot affect another scope'); f.unmount();
    results.push('D scope changes invalidate captured public consent and stopping confirmations before any IPC effect');
  }
  {
    const slow = deferred(), stale = deferred(); let reads = 0, budgetReads = 0;
    const f = await mounted({ status: async () => ok({ explorationReady: true }), listApprovals: async () => ok([]), budget: async () => { budgetReads++; return ok({ accounts: [] }); }, listExplorations: () => {
      reads++; if (reads === 2) return slow.promise; if (reads === 3) return stale.promise;
      return Promise.resolve(ok([{ ...exploration(reads > 3 ? 'completed' : 'waiting_approval'), activeRemainingMilliseconds: 5000, absoluteRemainingMilliseconds: 10000 }]));
    } });
    button(f.host, '探索进度').click(); await flush(); check(f.host.textContent?.includes('活跃执行剩余 5 秒 · 绝对期限剩余 10 秒'), 'Initial real clock snapshot shown'); const baseReads = f.listCount();
    await until(() => reads === 2); await new Promise(resolve => setTimeout(resolve, 1200)); check(reads === 2, 'Slow progress poll cannot overlap another request');
    slow.resolve(ok([{ ...exploration('waiting_approval'), activeRemainingMilliseconds: 5000, absoluteRemainingMilliseconds: 8000 }])); await until(() => f.host.textContent?.includes('活跃执行剩余 5 秒 · 绝对期限剩余 8 秒') === true);
    check(f.listCount() === baseReads && budgetReads === 1, 'Progress poll does not repeatedly pull configuration, OS permissions or hidden budget');
    await until(() => reads === 3); button(f.host, '刷新').click(); await until(() => f.host.textContent?.includes('已完成') === true); stale.resolve(ok([exploration('running')])); await flush();
    check(f.host.textContent?.includes('已完成') && !f.host.textContent?.includes('正在执行'), 'Late progress poll cannot replace a newer full snapshot'); f.unmount();
    results.push('review live clock snapshots refresh during approval waiting without overlapping polls or guessing active-time pauses');
  }
  {
    const slow = deferred(); let reads = 0;
    const f = await mounted({ listGoals: () => { reads++; return reads === 2 ? slow.promise : Promise.resolve(ok([goal('goal-1', reads > 2 ? 2 : 1)])); } });
    f.wake(); await until(() => reads === 2); for (let n = 0; n < 50; n++) f.wake(); await flush(); check(reads === 2, 'Notification storm shares one in-flight full refresh');
    slow.resolve(ok([goal()])); await until(() => reads === 3); await flush(); check(reads === 3, 'Notification storm produces one trailing refresh');
    button(f.host, '暂停主题').click(); await f.confirms[0].onOk(); check(f.calls[0].args[1] === 2, 'Coalesced refresh still publishes the latest CAS revision'); f.unmount();
    results.push('review advisory notification storms coalesce into one trailing coherent refresh with the newest CAS');
  }
  {
    const lastRead = deferred(); let reads = 0;
    const f = await mounted({ listGoals: () => { reads++; return reads === 2 ? lastRead.promise : Promise.resolve(ok([{ ...goal('goal-1', reads > 2 ? 2 : 1), state: reads > 2 ? 'paused' : 'active' }])); } });
    button(f.host, '暂停主题').click(); const operation = f.confirms[0].onOk(); await until(() => reads === 2); f.wake(); lastRead.resolve(ok([goal()])); await operation;
    await until(() => f.host.textContent?.includes('已暂停') === true); check(reads === 3 && f.calls.filter(item => item.name === 'setGoalState').length === 1, 'Advisory arriving during final mutation refresh cannot be dropped or redispatched'); f.unmount();
    results.push('review committed changes arriving during an outstanding mutation refresh are retained and pulled afterwards');
  }
  {
    let sessions = [exploration()], attempts = 0;
    const f = await mounted({ status: async () => ok({ explorationReady: true }), listExplorations: async () => ok(sessions), appendPublicMessage: async () => { attempts++; sessions = [exploration('running', 'summarizing')]; return ok({ accepted: false, reason: 'queue-full' }); } });
    button(f.host, '探索进度').click(); await flush(); input(f.host, '公开补充-exploration-run-1', '中'.repeat(1500)); await flush(); [...f.host.querySelectorAll('label')].find(item => item.textContent?.includes('我确认这段内容'))!.querySelector('input')!.click(); await flush();
    check(button(f.host, '确认公开补充').disabled && f.host.textContent?.includes('4500 / 4096 个 UTF-8 字节'), 'Multibyte content under character limit must still obey byte bound'); check(attempts === 0 && f.confirms.length === 0, 'Oversized public text is not dispatched or silently truncated');
    input(f.host, '公开补充-exploration-run-1', '保留这段公开补充'); await flush(); [...f.host.querySelectorAll('label')].find(item => item.textContent?.includes('我确认这段内容'))!.querySelector('input')!.click(); await flush(); button(f.host, '确认公开补充').click();
    const first = f.confirms[0].onOk(), duplicate = f.confirms[0].onOk(); await Promise.all([first, duplicate]); await flush(); check(attempts === 1 && f.errors.some(text => text.includes('队列已满')), 'Actual FIFO reason has clear safe feedback and duplicate confirmation does not dispatch twice');
    check((f.host.querySelector('textarea') as HTMLTextAreaElement).value === '保留这段公开补充' && button(f.host, '确认公开补充').disabled, 'Refusal preserves text and refreshes summarization phase'); await f.confirms[0].onOk(); check(attempts === 1, 'A retained confirmation cannot dispatch after summarization starts'); f.unmount();
    results.push('review UTF-8 public bounds, real FIFO refusal reasons, draft preservation and repeated consent remain safe');
  }
  {
    let sessions = [{ ...exploration(), pendingApprovalCount: 0 }, ...['MODEL_RESPONSE_INCOMPLETE', 'MODEL_RESPONSE_FAILED', 'MODEL_RESPONSE_INVALID'].map((stopReason, n) => ({ ...exploration('failed', 'settling'), id: 'model-failure-' + n, runId: 'failed-run-' + n, stopReason, pendingApprovalCount: 2 }))];
    const f = await mounted({ status: async () => ok({ explorationReady: true }), listExplorations: async () => ok(sessions), listApprovals: async () => ok([{ ...approval(), runId: 'exploration-run-1' }]) });
    button(f.host, '探索进度').click(); await flush(); check(!f.host.textContent?.includes('项操作等待批准'), 'Authoritative pending count zero overrides an old pending approval list');
    check(f.host.textContent?.includes('模型返回未完成') && f.host.textContent?.includes('模型报告本次请求失败') && f.host.textContent?.includes('模型返回内容格式无效'), 'Model protocol failures have distinct safe user-facing reasons');
    button(f.host, '批准卡').click(); await flush(); check(button(f.host, '仅这一次').disabled, 'Old pending card cannot be executed when authoritative Run count is zero'); button(f.host, '探索进度').click(); await flush();
    sessions = sessions.map(row => ({ ...row, state: 'completed', pendingApprovalCount: 7 })); f.wake(); await until(() => f.host.textContent?.includes('正在执行') === false); check(!f.host.textContent?.includes('项操作等待批准'), 'Terminal Run cannot show an actionable approval alert even with old pending rows'); f.unmount();
    results.push('review authoritative zero pending and terminal states suppress ghost approval alerts while model failures remain specific');
  }
  return results;
}
(window as any).__runAutonomyScenarios = run;
