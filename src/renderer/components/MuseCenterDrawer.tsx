import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Descriptions, Drawer, Empty, Flex, List, Select, Spin, Switch, Tabs, Tag, Typography } from 'antd';
import { CheckOutlined, CloseOutlined, FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons';
import type { MuseActivityEvent, MuseArtifact, MuseInboxItem, MuseRun, MuseResult } from '@shared/types/muse';

const stateLabels: Record<string, string> = {
  running: '执行中', stop_requested: '停止请求中', completed: '执行已收尾', failed: '执行失败', cancelled: '已停止', interrupted: '中断，待核实',
  accepted: '已接受', injected: '已进入上下文', injecting: '正在注入', rejected: '未接受', delivery_unknown: '送达待核实', unreviewed: '待查看',
  staging: '保存中', saved: '已保存', missing: '文件缺失', quarantined: '文件待核实', pending: '尚未验证', passed: '验证通过', not_applicable: '不适用',
};
const inboxLabels: Record<string, string> = { accepted: '已受理', injected: '已进入上下文', injecting: '正在注入', rejected: '未受理', cancelled: '已取消', delivery_unknown: '送达待核实' };
const saveLabels: Record<MuseArtifact['saveState'], string> = { staging: '保存中', saved: '已保存', failed: '保存失败', missing: '文件缺失', quarantined: '文件待核实' };
const validationLabels: Record<MuseArtifact['validationState'], string> = { pending: '尚未验证', passed: '验证通过', failed: '验证未通过', not_applicable: '不适用' };
const acceptanceLabels: Record<MuseArtifact['acceptanceState'], string> = { unreviewed: '待查看', accepted: '已接受', rejected: '未接受' };
const activityLabels: Record<string, string> = {
  'run.started': '开始执行', 'run.stop_requested': '收到停止请求', 'run.settled': '执行收尾', 'run.interrupted': '运行中断',
  'attempt.started': '任务开始', 'attempt.stop_requested': '请求停止任务', 'attempt.settled': '任务收尾', 'attempt.interrupted': '任务中断',
  'tool.started': '工具开始', 'tool.settled': '工具收尾', 'inbox.accepted': '追加已受理', 'inbox.injecting': '追加正在注入',
  'inbox.injected': '追加已进入上下文', 'inbox.rejected': '追加未受理', 'inbox.cancelled': '追加已取消', 'inbox.delivery_unknown': '追加送达待核实',
  'artifact.saved': '成果已保存', 'artifact.accepted': '成果已接受', 'artifact.rejected': '成果未接受', 'artifact.review_required': '成果需要复核',
};
const color = (value: string) => value === 'failed' || value === 'quarantined' ? 'error' : value === 'completed' || value === 'saved' || value === 'passed' || value === 'accepted' ? 'success' : value === 'running' || value === 'staging' ? 'processing' : 'default';
class MuseOperationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function result<T>(response: MuseResult<T>): T { if (!response.ok) throw new MuseOperationError(response.code, response.message); return response.result; }
const time = (value: string) => new Date(value).toLocaleString();

export function MuseCenterDrawer({ open, onClose, conversationId, initialTab = 'activity' }: { open: boolean; onClose: () => void; conversationId: string | null; initialTab?: string }) {
  const { message, modal } = App.useApp();
  const [tab, setTab] = useState(initialTab), [allConversations, setAllConversations] = useState(false);
  const [runs, setRuns] = useState<MuseRun[]>([]), [runId, setRunId] = useState<string>();
  const [events, setEvents] = useState<MuseActivityEvent[]>([]), [artifacts, setArtifacts] = useState<MuseArtifact[]>([]);
  const [inbox, setInbox] = useState<MuseInboxItem[]>([]), [selectedArtifact, setSelectedArtifact] = useState<MuseArtifact | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState<string>(), [hasMore, setHasMore] = useState(false), [artifactCursor, setArtifactCursor] = useState<string>();
  const [newActivity, setNewActivity] = useState(false);
  const [indexCursor, setIndexCursor] = useState<string>(), [indexLoading, setIndexLoading] = useState(false);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const generation = useRef(0), activityCursor = useRef(0), throughCursor = useRef<number | undefined>(undefined), busy = useRef(false);
  const artifactBusy = useRef(false), indexBusy = useRef(false), selectedArtifactId = useRef<string | null>(null), detailRequest = useRef(0);
  const filter = !allConversations && conversationId ? { conversationId } : {};
  const filterKey = `${allConversations ? '*' : conversationId ?? '*'}:${runId ?? '*'}`;

  const load = useCallback(async (reset = false, more = false) => {
    const api = window.electronAPI?.muse;
    if (!api || busy.current || artifactBusy.current) return;
    const ownGeneration = generation.current; busy.current = true; setLoading(true); setError(undefined); if (!more) setNewActivity(false);
    const scope = { ...(!allConversations && conversationId ? { conversationId } : {}), ...(runId ? { runId } : {}) };
    try {
      const [runResponse, pageResponse, artifactResponse] = await Promise.all([
        more ? undefined : api.listRuns({ ...(!allConversations && conversationId ? { conversationId } : {}), limit: 100 }),
        api.listActivity({ ...scope, afterEventId: reset ? 0 : activityCursor.current, ...(more && throughCursor.current !== undefined ? { throughEventId: throughCursor.current } : {}), limit: 100 }),
        more ? undefined : api.listArtifacts({ ...scope, limit: 100 }),
      ]);
      const page = result(pageResponse);
      if (generation.current !== ownGeneration) return;
      if (runResponse) setRuns(result(runResponse));
      if (artifactResponse) { const artifactPage = result(artifactResponse); setArtifacts(artifactPage.items); setArtifactCursor(artifactPage.nextCursor); }
      activityCursor.current = page.nextAfterEventId; throughCursor.current = page.throughEventId;
      setEvents(previous => {
        const indexed = new Map((reset ? [] : previous).map(event => [event.eventId, event]));
        for (const event of page.events) indexed.set(event.eventId, event);
        return [...indexed.values()].sort((left, right) => right.eventId - left.eventId);
      });
      setHasMore(page.hasMore);
      if (runId && !more) { const additions = result(await api.listInbox(runId)); if (generation.current === ownGeneration) setInbox(additions); }
      else if (!runId) setInbox([]);
    } catch (err) { if (generation.current === ownGeneration) setError(err instanceof Error ? err.message : '读取记录失败'); }
    finally { if (generation.current === ownGeneration) { busy.current = false; setLoading(false); } }
  }, [allConversations, conversationId, runId]);

  useEffect(() => {
    generation.current++; busy.current = false; activityCursor.current = 0; throughCursor.current = undefined;
    artifactBusy.current = false; detailRequest.current++; selectedArtifactId.current = null;
    setEvents([]); setArtifacts([]); setArtifactCursor(undefined); setArtifactLoading(false); setInbox([]); setSelectedArtifact(null); setHasMore(false); setNewActivity(false); setError(undefined);
    if (open) { setTab(initialTab); void load(true); }
    return () => { generation.current++; busy.current = false; };
  }, [open, filterKey, load, initialTab]);
  useEffect(() => { setRunId(undefined); }, [conversationId]);
  useEffect(() => {
    if (!open) return;
    return window.electronAPI?.muse?.onChanged(() => {
      if (busy.current || artifactBusy.current || hasMore) setNewActivity(true); else void load(false);
    });
  }, [open, hasMore, load]);

  const accept = (artifact: MuseArtifact, accepted: boolean) => {
    const ownGeneration = generation.current;
    return modal.confirm({
    title: accepted ? '接受这份成果？' : '记录为未接受？',
    content: accepted ? '这是你的查看结论。保存状态和验证结果会继续单独保留。' : '文件和执行记录会保留，可稍后重新查看。',
    okText: accepted ? '接受' : '未接受', cancelText: '取消',
    onOk: async () => {
      if (generation.current !== ownGeneration || selectedArtifactId.current !== artifact.id) return;
      try {
        const updated = result(await window.electronAPI.muse.acceptArtifact({ artifactId: artifact.id, expectedRevision: artifact.revision, accepted }));
        if (generation.current !== ownGeneration) return;
        setArtifacts(previous => previous.map(item => item.id === updated.id ? updated : item));
        if (selectedArtifactId.current === updated.id) setSelectedArtifact(updated);
      } catch (err) {
        if (generation.current !== ownGeneration) return;
        if (generation.current === ownGeneration) {
          message.error(err instanceof Error ? err.message : '操作未完成');
          if (err instanceof MuseOperationError && err.code === 'REVISION_CONFLICT') {
            if (selectedArtifactId.current === artifact.id) await showArtifact(artifact);
            if (generation.current !== ownGeneration) return;
            await load(false, hasMore);
            // Close the outdated confirmation. A new decision must use the refreshed detail.
            return;
          }
          await load(false, hasMore);
        }
        throw err;
      }
    },
  }); };
  const showArtifact = async (artifact: MuseArtifact) => {
    const ownGeneration = generation.current, ownRequest = ++detailRequest.current;
    selectedArtifactId.current = artifact.id;
    setSelectedArtifact(null);
    try {
      const detail = result(await window.electronAPI.muse.getArtifact(artifact.id));
      if (generation.current === ownGeneration && detailRequest.current === ownRequest && selectedArtifactId.current === artifact.id) {
        setSelectedArtifact(detail);
        if (detail) setArtifacts(previous => previous.map(item => item.id === detail.id ? detail : item));
      }
    } catch (err) { if (generation.current === ownGeneration && detailRequest.current === ownRequest) message.error(err instanceof Error ? err.message : '读取成果失败'); }
  };
  const openArtifact = async (artifact: MuseArtifact) => {
    const ownGeneration = generation.current;
    try { result(await window.electronAPI.muse.openArtifact(artifact.id)); }
    catch (err) { if (generation.current === ownGeneration) message.error(err instanceof Error ? err.message : '打开成果失败'); }
  };
  const moreArtifacts = async () => {
    if (artifactBusy.current || busy.current || !artifactCursor) return;
    const ownGeneration = generation.current;
    artifactBusy.current = true; setArtifactLoading(true);
    try {
      const page = result(await window.electronAPI.muse.listArtifacts({ ...filter, ...(runId ? { runId } : {}), limit: 100, cursor: artifactCursor }));
      if (generation.current !== ownGeneration) return;
      setArtifacts(previous => { const indexed = new Map(previous.map(item => [item.id, item])); for (const item of page.items) indexed.set(item.id, item); return [...indexed.values()]; });
      setArtifactCursor(page.nextCursor);
    } catch (err) { if (generation.current === ownGeneration) message.error(err instanceof Error ? err.message : '读取成果失败'); }
    finally { if (generation.current === ownGeneration) { artifactBusy.current = false; setArtifactLoading(false); } }
  };

  return <Drawer title="活动与成果" open={open} onClose={onClose} size="large" styles={{ body: { padding: 24 } }}>
    <Flex data-testid="muse-workspace" vertical gap={16}>
      <Flex justify="space-between" align="center" gap={8} wrap>
        <Flex align="center" gap={8}><Switch checked={allConversations} onChange={value => { setAllConversations(value); setRunId(undefined); }} size="small" /><Typography.Text>所有对话</Typography.Text></Flex>
        <Button icon={<ReloadOutlined />} onClick={() => void load(false, hasMore)} loading={loading}>刷新</Button>
      </Flex>
      <Select allowClear placeholder="全部运行" value={runId} onChange={setRunId} options={runs.map(run => ({ value: run.id, label: `${time(run.createdAt)} · ${stateLabels[run.state] ?? run.state}` }))} />
      {runId && runs.find(run => run.id === runId) && <Alert type="info" title={stateLabels[runs.find(run => run.id === runId)!.state] ?? '运行记录'} description="执行收尾与业务验收分别记录；中断的任务需要核实，重启不会自动重跑工具。" />}
      {error && <Alert type="error" title={error} showIcon />}
      {newActivity && <Alert type="info" title={hasMore ? '有新活动；先继续读取当前记录，再刷新查看。' : '有新活动，点击刷新查看。'} />}
      <Tabs activeKey={tab} onChange={setTab} items={[
        { key: 'activity', label: '活动', children: <Flex vertical gap={12}>
          {!loading && !events.length && <Empty description="暂无活动记录" />}
          <List dataSource={events} renderItem={event => <List.Item key={event.eventId}>
            <Flex vertical gap={6} style={{ width: '100%' }}>
              <Flex justify="space-between" gap={12}><Typography.Text strong>{activityLabels[event.kind] ?? '运行事件'}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 12 }}>{time(event.occurredAt)}</Typography.Text></Flex>
              <Flex gap={6} wrap>{Boolean(event.details.toolName) && <Tag>{String(event.details.toolName)}</Tag>}{Boolean(event.details.state) && <Tag color={color(String(event.details.state))}>{stateLabels[String(event.details.state)] ?? String(event.details.state)}</Tag>}{typeof event.details.success === 'boolean' && <Tag color={event.details.success ? 'success' : 'error'}>{event.details.success ? '操作完成' : '操作失败'}</Tag>}{Boolean(event.details.inboxState) && <Tag>{inboxLabels[String(event.details.inboxState)] ?? String(event.details.inboxState)}</Tag>}</Flex>
              {event.details.needsReview === true && <Tag color="warning">需要复核</Tag>}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>运行 {event.runId.slice(0, 8)}{event.attemptId ? ` · 任务 ${event.attemptId.slice(0, 8)}` : ''}</Typography.Text>
            </Flex>
          </List.Item>} />
          {hasMore && <Button onClick={() => void load(false, true)} loading={loading}>继续读取活动</Button>}
          {runId && inbox.length > 0 && <><Typography.Title level={5}>任务追加</Typography.Title><List dataSource={inbox} renderItem={item => <List.Item key={item.id}><Typography.Text>{time(item.createdAt)}</Typography.Text><Tag>{inboxLabels[item.state] ?? item.state}</Tag></List.Item>} /></>}
        </Flex> },
        { key: 'artifacts', label: '成果', children: <Flex vertical gap={12}>
          <Button loading={indexLoading} onClick={() => modal.confirm({
            title: '登记已有成果', content: '扫描 Delepi 成果目录，登记可查看文件并保留来源信息。历史成果会显示在“所有对话”中。', okText: indexCursor ? '继续登记' : '开始登记', cancelText: '取消',
            onOk: async () => {
              if (indexBusy.current) return;
              const ownGeneration = generation.current;
              indexBusy.current = true; setIndexLoading(true);
              try {
                const indexed = result(await window.electronAPI.muse.indexLegacyArtifacts({ ...(indexCursor ? { cursor: indexCursor } : {}), limit: 100 }));
                if (generation.current !== ownGeneration) return;
                setIndexCursor(indexed.nextCursor);
                message.info(`本批登记 ${indexed.indexed} 份，跳过 ${indexed.skipped} 份${indexed.errors ? `，${indexed.errors} 份需核实` : ''}${indexed.done ? '；扫描完成' : '；可继续登记下一批'}`);
                if (!allConversations || runId) { setAllConversations(true); setRunId(undefined); }
                else await load(false);
              } catch (err) { if (generation.current === ownGeneration) message.error(err instanceof Error ? err.message : '登记失败'); }
              finally { indexBusy.current = false; setIndexLoading(false); }
            },
          })}>{indexCursor ? '继续登记已有成果' : '登记已有成果'}</Button>
          <List locale={{ emptyText: <Empty description="暂无登记成果" /> }} dataSource={artifacts} renderItem={artifact => <List.Item actions={[<Button key="details" type="link" onClick={() => void showArtifact(artifact)}>详情</Button>]}>
            <Flex vertical gap={8}><Typography.Text strong>{artifact.title}</Typography.Text><Flex gap={6} wrap><Tag color={color(artifact.saveState)}>{saveLabels[artifact.saveState]}</Tag><Tag color={color(artifact.validationState)}>{validationLabels[artifact.validationState]}</Tag><Tag color={color(artifact.acceptanceState)}>{acceptanceLabels[artifact.acceptanceState]}</Tag>{artifact.needsReview && <Tag color="warning">需要复核</Tag>}</Flex><Typography.Text type="secondary" style={{ fontSize: 12 }}>{time(artifact.createdAt)}</Typography.Text></Flex>
          </List.Item>} />
          {artifactCursor && <Button loading={artifactLoading} onClick={() => void moreArtifacts()}>更多成果</Button>}
        </Flex> },
      ]} />
      {loading && !events.length && <Spin />}
    </Flex>
    <Drawer title="成果详情" open={Boolean(selectedArtifact)} onClose={() => { selectedArtifactId.current = null; detailRequest.current++; setSelectedArtifact(null); }} size="default">
      {selectedArtifact && <Flex vertical gap={20}>
        <Typography.Title level={4}>{selectedArtifact.title}</Typography.Title>
        {selectedArtifact.needsReview && <Alert type="warning" showIcon title="需要复核" description="该成果的来源、运行或文件状态需要核实。请核对内容与来源后，再记录你的接受结论。" />}
        <Descriptions column={1} items={[
          { key: 'save', label: '保存', children: saveLabels[selectedArtifact.saveState] },
          { key: 'validation', label: '验证', children: validationLabels[selectedArtifact.validationState] },
          { key: 'acceptance', label: '你的接受状态', children: acceptanceLabels[selectedArtifact.acceptanceState] },
          { key: 'size', label: '大小', children: `${selectedArtifact.sizeBytes.toLocaleString()} 字节` },
          { key: 'created', label: '登记时间', children: time(selectedArtifact.createdAt) },
          { key: 'source', label: '来源运行', children: selectedArtifact.runId ?? '历史已有成果' },
          { key: 'hash', label: '内容指纹', children: <Typography.Text copyable style={{ overflowWrap: 'anywhere', fontSize: 12 }}>{selectedArtifact.contentHash}</Typography.Text> },
        ]} />
        <Button icon={<FolderOpenOutlined />} disabled={selectedArtifact.saveState !== 'saved'} onClick={() => void openArtifact(selectedArtifact)}>打开成果</Button>
        <Flex gap={8}><Button type="primary" icon={<CheckOutlined />} disabled={selectedArtifact.saveState !== 'saved'} onClick={() => accept(selectedArtifact, true)}>接受</Button><Button icon={<CloseOutlined />} onClick={() => accept(selectedArtifact, false)}>未接受</Button></Flex>
      </Flex>}
    </Drawer>
  </Drawer>;
}
