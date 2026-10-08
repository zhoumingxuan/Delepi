import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MuseCenterDrawer } from '../../src/renderer/components/MuseCenterDrawer';

const ok = (result: any) => ({ ok: true, result });
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(yes => { resolve = yes; }); return { promise, resolve }; }
function check(value: unknown, text: string) { if (!value) throw new Error(text); }
async function until(predicate: () => boolean) { const start = Date.now(); while (!predicate()) { if (Date.now() - start > 3000) throw new Error('Drawer fixture timed out: ' + document.body.textContent); await new Promise(resolve => setTimeout(resolve, 5)); } }
async function flush() { await new Promise(resolve => setTimeout(resolve, 25)); }
const artifact = (id: string, revision = 1) => ({ id, title: id, sizeBytes: 1, contentHash: 'fixture-hash', saveState: 'saved', validationState: 'not_applicable', acceptanceState: 'unreviewed', revision, createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z', needsReview: false });
function button(host: HTMLElement, title: string) { const found = [...host.querySelectorAll('button')].find(item => item.textContent === title); if (!found) throw new Error('Missing button: ' + title); return found; }

async function mounted(tab = 'artifacts', activity = false) {
  const details: Array<{ id: string; resolve: (value: any) => void }> = [], accepts: Array<{ params: any; resolve: (value: any) => void }> = [], pages: Array<{ params: any; resolve: (value: any) => void }> = [], confirms: any[] = [], activityQueries: any[] = [], artifactQueries: any[] = [], errors: string[] = [];
  let wake: () => void = () => {};
  (window as any).__museUiServices = { message: { error: (text: string) => { errors.push(text); }, info: () => {} }, modal: { confirm: (options: any) => { confirms.push(options); return { destroy: () => {} }; } } };
  (window as any).electronAPI = { muse: {
    listRuns: async () => ok([]),
    listActivity: async (params: any) => {
      activityQueries.push(params);
      if (!activity) return ok({ events: [], throughEventId: 0, nextAfterEventId: 0, hasMore: false });
      const event = (eventId: number) => ({ eventId, runId: 'run-fixture', conversationId: 'conversation-old', kind: 'run.started', details: {}, occurredAt: `2030-01-01T00:00:0${eventId}.000Z`, committedAt: `2030-01-01T00:00:0${eventId}.000Z` });
      return params.afterEventId === 0 ? ok({ events: [event(1)], throughEventId: 2, nextAfterEventId: 1, hasMore: true })
        : params.afterEventId === 1 ? ok({ events: [event(1), event(2)], throughEventId: 2, nextAfterEventId: 2, hasMore: false })
        : ok({ events: [event(3)], throughEventId: 3, nextAfterEventId: 3, hasMore: false });
    },
    listArtifacts: async (params: any) => {
      artifactQueries.push(params);
      if (params.cursor) { const pending = deferred(); pages.push({ params, resolve: pending.resolve }); return pending.promise; }
      return ok({ items: [artifact(params.conversationId === 'conversation-new' ? 'artifact-new' : 'artifact-old')], nextCursor: 'fixture-cursor' });
    },
    listInbox: async () => ok([]),
    getArtifact: (id: string) => { const pending = deferred(); details.push({ id, resolve: pending.resolve }); return pending.promise; },
    acceptArtifact: (params: any) => { const pending = deferred(); accepts.push({ params, resolve: pending.resolve }); return pending.promise; },
    openArtifact: async () => ok(undefined),
    onChanged: (callback: () => void) => { wake = callback; return () => { wake = () => {}; }; },
  } };
  let setConversation!: (value: string) => void;
  function Harness() { const [conversation, setCurrent] = useState('conversation-old'); setConversation = setCurrent; return <MuseCenterDrawer open onClose={() => {}} conversationId={conversation} initialTab={tab} />; }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); root.render(<Harness />);
  await until(() => host.textContent?.includes(tab === 'activity' && activity ? '继续读取活动' : 'artifact-old') === true); await flush();
  return { host, details, accepts, pages, confirms, activityQueries, artifactQueries, errors, wake: () => wake(), setConversation, unmount: () => { root.unmount(); host.remove(); } };
}

async function run() {
  const results: string[] = [];
  {
    const f = await mounted(); button(f.host, '详情').click(); await until(() => f.details.length === 1);
    f.setConversation('conversation-new'); await until(() => f.host.textContent?.includes('artifact-new') === true);
    f.details[0].resolve(ok(artifact('artifact-old'))); await flush();
    check(!f.host.querySelector('[data-drawer="成果详情"]'), 'Late detail must not reopen in another conversation');
    button(f.host, '详情').click(); await until(() => f.details.length === 2); f.details[1].resolve(ok(artifact('artifact-new')));
    await until(() => Boolean(f.host.querySelector('[data-drawer="成果详情"]')));
    button(f.host, '接受').click(); check(f.confirms.length === 1, 'Accept must require an explicit modal');
    const pendingAccept = f.confirms[0].onOk(); await until(() => f.accepts.length === 1);
    f.setConversation('conversation-old'); await until(() => f.host.textContent?.includes('artifact-old') === true);
    f.accepts[0].resolve(ok(artifact('artifact-new', 2))); await pendingAccept; await flush();
    check(!f.host.querySelector('[data-drawer="成果详情"]'), 'Late acceptance must not reopen detail in another conversation');
    check(!f.host.textContent?.includes('artifact-new'), 'Late acceptance must not inject an old-scope artifact');
    const more = button(f.host, '更多成果'); more.click(); more.click(); await until(() => f.pages.length === 1);
    f.setConversation('conversation-new'); await until(() => f.host.textContent?.includes('artifact-new') === true);
    f.pages[0].resolve(ok({ items: [artifact('artifact-stale-page')], nextCursor: undefined })); await flush();
    check(f.pages.length === 1, 'Repeated pagination must have one in-flight request');
    check(!f.host.textContent?.includes('artifact-stale-page'), 'Late page must not enter another scope');
    f.unmount(); results.push('late artifact detail, acceptance and pagination remain isolated to the original scope');
  }
  {
    const f = await mounted();
    button(f.host, '更多成果').click(); await until(() => f.pages.length === 1);
    f.pages[0].resolve(ok({ items: [artifact('artifact-old'), artifact('artifact-extra')], nextCursor: undefined }));
    await until(() => f.host.textContent?.includes('artifact-extra') === true);
    check(f.host.querySelectorAll('.test-tabs li').length === 2, 'Duplicate artifact IDs must not add another card');
    [...f.host.querySelectorAll('button')].find(item => item.textContent === '详情')!.click(); await until(() => f.details.length === 1);
    f.details[0].resolve(ok(artifact('artifact-old'))); await until(() => Boolean(f.host.querySelector('[data-drawer="成果详情"]')));
    button(f.host, '接受').click(); f.setConversation('conversation-new'); await until(() => f.host.textContent?.includes('artifact-new') === true);
    await f.confirms[0].onOk(); check(f.accepts.length === 0, 'A scope-changed approval must not mutate a stale artifact');
    f.unmount(); results.push('artifact pagination deduplicates and stale approval does not mutate');
  }
  {
    const f = await mounted('activity', true); f.wake(); await until(() => f.host.textContent?.includes('有新活动') === true);
    button(f.host, '继续读取活动').click(); await until(() => f.activityQueries.length === 2); await until(() => !f.host.textContent?.includes('继续读取活动'));
    check(f.activityQueries[1].afterEventId === 1 && f.activityQueries[1].throughEventId === 2, 'Paging must preserve its captured upper cursor');
    check(f.host.textContent?.includes('有新活动'), 'Wake beyond the current page must stay visible until a fresh pull');
    button(f.host, '刷新').click(); await until(() => f.activityQueries.length === 3); await flush();
    check(f.activityQueries[2].afterEventId === 2 && f.activityQueries[2].throughEventId === undefined, 'Fresh pull must resume from the durable cursor without the old upper bound');
    check(f.host.querySelectorAll('.test-tabs li').length === 3, 'Activity overlap must be deduplicated by event ID');
    f.unmount(); results.push('activity paging fixes the upper bound, preserves wake reminders and deduplicates overlap');
  }
  {
    const f = await mounted(); button(f.host, '详情').click(); await until(() => f.details.length === 1);
    f.details[0].resolve(ok(artifact('artifact-old'))); await until(() => Boolean(f.host.querySelector('[data-drawer="成果详情"]')));
    button(f.host, '接受').click(); const decision = f.confirms[0].onOk(); await until(() => f.accepts.length === 1);
    f.accepts[0].resolve({ ok: false, code: 'REVISION_CONFLICT', message: '内容已更新，请刷新后再操作', retryable: true, currentRevision: 2 });
    await until(() => f.details.length === 2);
    f.details[1].resolve(ok({ ...artifact('artifact-old', 2), needsReview: true })); await decision; await flush();
    check(f.errors[0] === '内容已更新，请刷新后再操作', 'Conflict must provide a useful message');
    check(f.accepts.length === 1, 'Refreshing a conflict must not automatically accept a new revision');
    check(f.host.textContent?.includes('需要复核'), 'The latest detail must expose its review state');
    button(f.host, '接受').click(); const nextDecision = f.confirms[1].onOk(); await until(() => f.accepts.length === 2);
    check(f.accepts[1].params.expectedRevision === 2, 'A new explicit decision must use the refreshed revision');
    f.accepts[1].resolve(ok({ ...artifact('artifact-old', 3), acceptanceState: 'accepted' })); await nextDecision;
    f.unmount(); results.push('stale acceptance refreshes detail without replay and requires a fresh decision');
  }
  {
    const f = await mounted('artifacts', true); button(f.host, '更多成果').click(); await until(() => f.pages.length === 1);
    f.pages[0].resolve(ok({ items: [artifact('artifact-extra')], nextCursor: undefined })); await until(() => f.host.textContent?.includes('artifact-extra') === true);
    const before = f.artifactQueries.length;
    button(f.host, '活动').click(); await until(() => f.host.textContent?.includes('继续读取活动') === true);
    button(f.host, '继续读取活动').click(); await until(() => f.activityQueries.length === 2); await flush();
    check(f.artifactQueries.length === before, 'Activity paging must not refetch or reset artifact pages');
    button(f.host, '成果').click(); await until(() => f.host.textContent?.includes('artifact-extra') === true);
    f.unmount(); results.push('activity paging makes one read and preserves already loaded artifact pages');
  }
  {
    const f = await mounted(); button(f.host, '详情').click(); await until(() => f.details.length === 1);
    f.details[0].resolve(ok({ ...artifact('artifact-old'), saveState: 'failed', validationState: 'failed', needsReview: true }));
    await until(() => Boolean(f.host.querySelector('[data-drawer="成果详情"]')));
    const text = f.host.textContent ?? '';
    check(text.includes('保存失败') && text.includes('验证未通过') && text.includes('需要复核'), 'Separate artifact facts and review flags must be visible');
    check(button(f.host, '接受').disabled, 'A failed save cannot be accepted');
    f.unmount(); results.push('artifact save, validation failure and needs-review have distinct visible states');
  }
  {
    const f = await mounted(); button(f.host, '详情').click(); await until(() => f.details.length === 1);
    f.details[0].resolve(ok(artifact('artifact-old'))); await until(() => Boolean(f.host.querySelector('[data-drawer="成果详情"]')));
    button(f.host, '接受').click(); const decision = f.confirms[0].onOk(); await until(() => f.accepts.length === 1);
    f.accepts[0].resolve({ ok: false, code: 'REVISION_CONFLICT', message: '内容已更新，请刷新后再操作', retryable: true });
    await until(() => f.details.length === 2);
    f.setConversation('conversation-new'); await until(() => f.host.textContent?.includes('artifact-new') === true); await flush();
    const reads = f.artifactQueries.length;
    f.details[1].resolve(ok(artifact('artifact-old', 2))); await decision; await flush();
    check(f.artifactQueries.length === reads, 'Old conflict continuation must not start an old-scope load');
    check(!f.host.textContent?.includes('artifact-old'), 'Old conflict must not contaminate the new conversation');
    f.unmount(); results.push('scope switch during conflict detail refresh cancels its old continuation');
  }
  return results;
}
(window as any).__runMuseDrawerScenarios = run;
