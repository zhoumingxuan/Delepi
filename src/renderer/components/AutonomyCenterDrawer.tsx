import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, Descriptions, Drawer, Empty, Flex, Input, InputNumber, Modal, Select, Spin, Tabs, Tag, Typography, theme } from 'antd';
import { PlusOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import type { ApprovalPreview, BudgetAmounts, BudgetProjection, ExplorationLimits, ExplorationPlan, ExplorationSession, GrantProjection, ModelDestination, OsPermissionStatus, PermissionPolicy, PublicCapability, PublicGoal, PublicGoalDraft, PublicResource, RulePreview, StandingRule } from '@shared/types/autonomy';
import { PUBLIC_CAPABILITIES } from '@shared/types/autonomy';
import type { MuseResult } from '@shared/types/muse';
import type { BackgroundConfiguration, BackgroundSchedule, LearnedSkill } from '@shared/types/background';

const capabilityNames: Record<PublicCapability, string> = { 'fetch.public': '阅读公开网页', 'model.invoke': '向选定模型发送公开资料', 'file.read_public': '读取已登记的公开资料', 'artifact.publish': '保存本主题成果' };
const legacyNames = { shell: 'Shell 执行', python: 'Python 执行', scriptTools: '经验脚本', dynamicTools: '动态工具', localFiles: '本地文件工具' };
const goalStates = { active: '可手动开始', paused: '已暂停', archived: '已归档' };
const grantStates: Record<string, string> = { active: '生效中', consumed: '已使用', revoked: '已撤回', expired: '已过期', suspended: '已挂起' };
const ruleStates = { active: '生效中', revoked: '已撤回', expired: '已过期', suspended: '已挂起，需重新签发' };
const explorationStates: Record<string, string> = { running: '正在执行', waiting_approval: '等待批准', stop_requested: '正在停止，等待收尾', completed: '已完成', stopped: '已停止', failed: '执行失败', interrupted: '进程中断', outcome_unknown: '回执不明，需复核' };
const phases = { fetching: '读取公开来源', reading: '核验公开副本', summarizing: '生成总结', publishing: '保存成果', settling: '记录结果' };
const stopReasons: Record<string, string> = { MODEL_RESPONSE_INCOMPLETE: '模型返回未完成，请保留本轮记录后重新核对', MODEL_RESPONSE_FAILED: '模型报告本次请求失败', MODEL_RESPONSE_INVALID: '模型返回内容格式无效', USER_STOPPED: '你已请求停止', STOP_REQUESTED: '你已请求停止', CANCELLED: '操作已取消', GOAL_CHANGED: '主题范围已变化', GOAL_INACTIVE: '主题已暂停或归档', PUBLIC_SCOPE_CHANGED: '公开资料范围已变化', DESTINATION_CHANGED: '模型配置已变化', POLICY_CHANGED: '权限策略已变化', POLICY_BLOCKED: '当前权限阻止继续执行', AUTHORIZATION_REVOKED: '批准或规则已撤回', AUTHORIZATION_CHANGED: '批准范围已变化', APPROVAL_REJECTED: '你拒绝了操作', APPROVAL_EXPIRED: '批准等待已过期', BUDGET_EXHAUSTED: '自主阅读预算耗尽', ACTIVE_TIME_EXHAUSTED: '活跃执行时限已到', ABSOLUTE_DEADLINE_EXCEEDED: '本次绝对期限已到', APPLICATION_CLOSED: '应用关闭，请求本次运行收尾', PROCESS_INTERRUPTED: '上次进程中断', PERSISTENCE_FAILED: '结果记录未确认，需复核', OPERATION_RECEIPT_UNKNOWN: '操作回执未确认，需复核' };
const activeExploration = (item: ExplorationSession) => ['running', 'waiting_approval', 'stop_requested'].includes(item.state);
const protocolNames = { 'chat-completions': 'Chat Completions', responses: 'Responses' };
const budgetNames: Record<string, string> = { global: '全局累计', goal: '主题累计', run: '本次运行', day: 'UTC 日预算' };
const publicMessageReasons: Record<string, string> = {
  summarization_started: '总结请求已经开始，请保留补充并在下一轮再次确认', 'summary-already-started': '总结请求已经开始，请保留补充并在下一轮再次确认', MODEL_STARTED: '总结请求已经开始，请保留补充并在下一轮再次确认',
  run_stopped: '本次运行已收尾，请在下一轮再次确认', 'stop-requested': '本次运行正在停止，请在下一轮再次确认', terminal: '本次运行已收尾，请在下一轮再次确认',
  stale_scope: '主题范围已变化，请重新核对补充', 'stale-attempt': '本次运行已失效，请在下一轮再次确认',
  limit_exceeded: '公开补充已达到本次数量或大小上限', 'queue-full': '本次公开补充队列已满，请保留内容并在下一轮再次确认', 'too-long': '公开补充最多 4000 字符且不能超过 4096 个 UTF-8 字节，请缩短内容',
  'message-id-conflict': '这份补充的内容或范围已变化，请重新编辑并确认', 'storage-error': '补充回执未确认，请保留内容并核对活动记录',
  public_confirmation_required: '请重新确认这段补充可以公开发送', 'public-confirmation-required': '请重新确认这段补充可以公开发送', 'empty-or-invalid': '公开补充为空或包含无效字符，请重新编辑', empty: '请填写公开补充内容',
};
type PublicDraft = { messageId: string; text: string; confirmed: boolean };
const publicBytes = (text: string) => new TextEncoder().encode(text).byteLength;
const acceptsPublic = (session: ExplorationSession, ready: boolean) => ready && !!session.destination && activeExploration(session) && session.state !== 'stop_requested' && !['summarizing', 'publishing', 'settling'].includes(session.phase ?? '');
const approvalRunClosed = (preview: ApprovalPreview, sessions: ExplorationSession[]) => {
  const session = sessions.find(item => item.runId === preview.runId);
  return !!session && (!activeExploration(session) || session.state === 'stop_requested' || session.pendingApprovalCount === 0);
};
function AmountDescription({ label, amounts }: { label: string; amounts: BudgetAmounts }) { return <Typography.Text>{label}：模型 {amounts.modelRequests} 次 · 网页 {amounts.fetchRequests} 次 · 下载 {(amounts.downloadBytes / 1048576).toFixed(2)} MiB · 存储 {(amounts.storageBytes / 1048576).toFixed(2)} MiB · Token 保守计账 {amounts.tokenUnits.toLocaleString()}</Typography.Text>; }
const time = (value: string) => new Date(value).toLocaleString();
const defaultLimits: ExplorationLimits = { modelRequests: 6, fetchRequests: 8, downloadBytes: 5 * 1024 * 1024, storageBytes: 5 * 1024 * 1024, tokenUnits: 100000, activeMilliseconds: 300000, absoluteMilliseconds: 900000, maxDocumentBytes: 1024 * 1024, concurrency: 2 };
const newDraft = (): PublicGoalDraft => ({ title: '', topic: '', sourceUrls: [], destinationId: '', expectedOutput: '', stopConditions: '', limits: { ...defaultLimits } });
class AutonomyOperationError extends Error { constructor(readonly code: string, message: string) { super(message); } }
function unwrap<T>(response: MuseResult<T>): T { if (!response.ok) throw new AutonomyOperationError(response.code, response.message); return response.result; }
function LimitDescription({ limits }: { limits: BudgetAmounts | ExplorationLimits }) {
  return <Descriptions size="small" column={1} items={[
    { key: 'model', label: '模型请求上限', children: limits.modelRequests },
    { key: 'fetch', label: '网页请求上限', children: limits.fetchRequests },
    { key: 'download', label: '下载总量', children: `${(limits.downloadBytes / 1024 / 1024).toFixed(2)} MiB` },
    { key: 'storage', label: '保存总量', children: `${(limits.storageBytes / 1024 / 1024).toFixed(2)} MiB` },
    { key: 'token', label: 'Token 保守预留', children: <span>{limits.tokenUnits.toLocaleString()} · 未知实际用量按预留记账</span> },
    ...('absoluteMilliseconds' in limits ? [
      { key: 'active', label: '活跃执行上限', children: `${limits.activeMilliseconds / 60000} 分钟` },
      { key: 'deadline', label: '本次绝对时限', children: `${limits.absoluteMilliseconds / 60000} 分钟` },
      { key: 'document', label: '单份文档上限', children: `${(limits.maxDocumentBytes / 1024 / 1024).toFixed(2)} MiB` },
      { key: 'concurrency', label: '读取并发', children: limits.concurrency },
    ] : []),
  ]} />;
}

/** User-owned scopes and manually confirmed execution, gated by main-process startup readiness. */
export function AutonomyCenterDrawer({ open, onClose, conversationId }: { open: boolean; onClose: () => void; conversationId?: string | null }) {
  const { message, modal } = App.useApp(), { token } = theme.useToken();
  const generation = useRef(0), loadSequence = useRef(0), mutationBusy = useRef(false), ruleSequence = useRef(0);
  const planSequence = useRef(0);
  const fullRefresh = useRef<{ generation: number; pending: boolean; promise: Promise<void> } | undefined>(undefined), changedWhileBusy = useRef(false);
  const progressInFlight = useRef<{ generation: number } | undefined>(undefined), progressSequence = useRef(0);
  const confirmations = useRef(new Set<{ destroy: () => void }>());
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const [clock, setClock] = useState(Date.now);
  const [progressError, setProgressError] = useState<string>();
  const [tab, setTab] = useState('goals'), [goals, setGoals] = useState<PublicGoal[]>([]), [destinations, setDestinations] = useState<ModelDestination[]>([]);
  const [approvals, setApprovals] = useState<ApprovalPreview[]>([]), [rules, setRules] = useState<StandingRule[]>([]), [grants, setGrants] = useState<GrantProjection[]>([]);
  const [policy, setPolicy] = useState<PermissionPolicy>(), [osRows, setOsRows] = useState<OsPermissionStatus[]>([]);
  const [explorationReady, setExplorationReady] = useState(false), [explorations, setExplorations] = useState<ExplorationSession[]>([]), [budget, setBudget] = useState<BudgetProjection>();
  const [planningGoal, setPlanningGoal] = useState<PublicGoal>(), [protocol, setProtocol] = useState<ExplorationPlan['protocol']>('chat-completions'), [explorationPlan, setExplorationPlan] = useState<ExplorationPlan>();
  const [publicDrafts, setPublicDrafts] = useState<Record<string, PublicDraft>>({});
  const currentPublic = useRef<{ ready: boolean; sessions: ExplorationSession[]; drafts: Record<string, PublicDraft> }>({ ready: false, sessions: [], drafts: {} });
  currentPublic.current = { ready: explorationReady, sessions: explorations, drafts: publicDrafts };
  const [draft, setDraft] = useState<PublicGoalDraft>(newDraft), [sourceText, setSourceText] = useState(''), [editorOpen, setEditorOpen] = useState(false), [editing, setEditing] = useState<PublicGoal>();
  const [ruleGoalId, setRuleGoalId] = useState<string>(), [ruleResources, setRuleResources] = useState<PublicResource[]>([]), [selectedResources, setSelectedResources] = useState<string[]>([]);
  const [selectedCapabilities, setSelectedCapabilities] = useState<PublicCapability[]>([]), [ruleHours, setRuleHours] = useState(24), [rulePreview, setRulePreview] = useState<RulePreview>();
  const ruleGoalRef = useRef<string | undefined>(undefined);
  const cardStyle = { border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadiusLG, background: token.colorBgContainer, padding: 16 };

  const readSnapshot = useCallback(async () => {
    const api = window.electronAPI?.autonomy;
    if (!api) { setError('主题与权限入口尚未就绪'); return; }
    const ownGeneration = generation.current, ownSequence = ++loadSequence.current;
    setLoading(true); setError(undefined);
    try {
      const values = await Promise.all([api.listGoals(), api.listDestinations(), api.listApprovals(), api.listRules(), api.listGrants(), api.getPolicy(), api.osStatus(), typeof api.status === 'function' ? api.status() : Promise.resolve({ ok: true as const, result: { explorationReady: false } })]);
      if (generation.current !== ownGeneration || loadSequence.current !== ownSequence) return;
      // A failed member must not publish a mixture of old and new authorization facts.
      const snapshot = { goals: unwrap(values[0]), destinations: unwrap(values[1]), approvals: unwrap(values[2]), rules: unwrap(values[3]), grants: unwrap(values[4]), policy: unwrap(values[5]), os: unwrap(values[6]) };
      const ready = unwrap(values[7]).explorationReady;
      const stage = ready ? await Promise.all([api.listExplorations(), api.budget()]) : undefined;
      if (generation.current !== ownGeneration || loadSequence.current !== ownSequence) return;
      const sessions = stage ? unwrap(stage[0]) : [], accounts = stage ? unwrap(stage[1]) : undefined;
      setGoals(snapshot.goals); setDestinations(snapshot.destinations); setApprovals(snapshot.approvals); setRules(snapshot.rules); setGrants(snapshot.grants); setPolicy(snapshot.policy); setOsRows(snapshot.os);
      setExplorationReady(ready); setExplorations(sessions); setBudget(accounts); setProgressError(undefined);
    } catch (err) { if (generation.current === ownGeneration && loadSequence.current === ownSequence) setError(err instanceof Error ? err.message : '读取主题与权限失败'); }
    finally { if (generation.current === ownGeneration && loadSequence.current === ownSequence) setLoading(false); }
  }, []);
  const load = useCallback((): Promise<void> => {
    const ownGeneration = generation.current;
    if (fullRefresh.current?.generation === ownGeneration) {
      fullRefresh.current.pending = true;
      return fullRefresh.current.promise;
    }
    const job = { generation: ownGeneration, pending: false, promise: Promise.resolve() };
    fullRefresh.current = job;
    job.promise = Promise.resolve().then(async () => {
      do { if (generation.current !== ownGeneration) return; job.pending = false; await readSnapshot(); }
      while (job.pending && generation.current === ownGeneration);
    }).finally(() => { if (fullRefresh.current === job) fullRefresh.current = undefined; });
    return job.promise;
  }, [readSnapshot]);
  useEffect(() => {
    generation.current++; loadSequence.current++; ruleSequence.current++; planSequence.current++; progressSequence.current++; mutationBusy.current = false; changedWhileBusy.current = false;
    setBusy(false); setLoading(false); setGoals([]); setApprovals([]); setRules([]); setGrants([]); setDestinations([]); setPolicy(undefined); setOsRows([]); setError(undefined);
    setEditorOpen(false); setEditing(undefined); setRulePreview(undefined); setRuleGoalId(undefined); ruleGoalRef.current = undefined; setRuleResources([]); setSelectedResources([]); setSelectedCapabilities([]);
    setPlanningGoal(undefined); setExplorationPlan(undefined); setExplorationReady(false); setExplorations([]); setBudget(undefined); setPublicDrafts({}); setProgressError(undefined);
    if (open) void load();
    return () => {
      generation.current++; loadSequence.current++; ruleSequence.current++; planSequence.current++; mutationBusy.current = false;
      for (const confirmation of confirmations.current) confirmation.destroy();
      confirmations.current.clear();
    };
  }, [open, conversationId, load]);
  useEffect(() => {
    if (!open) return;
    return window.electronAPI?.autonomy?.onChanged(() => { if (mutationBusy.current) changedWhileBusy.current = true; else void load(); });
  }, [open, load]);
  const hasActiveRuns = explorations.some(activeExploration);
  useEffect(() => {
    if (!open || !explorationReady || !hasActiveRuns) return;
    const ownGeneration = generation.current;
    const poll = async () => {
      if (generation.current !== ownGeneration || mutationBusy.current || fullRefresh.current?.generation === ownGeneration || progressInFlight.current?.generation === ownGeneration) return;
      const job = { generation: ownGeneration }, ownSequence = ++progressSequence.current, ownLoad = loadSequence.current;
      progressInFlight.current = job;
      try {
        const api = window.electronAPI.autonomy;
        const values = await Promise.all([api.listExplorations(), tab === 'budget' ? api.budget() : undefined, tab === 'approvals' ? api.listApprovals() : undefined]);
        if (generation.current !== ownGeneration || progressSequence.current !== ownSequence || loadSequence.current !== ownLoad || mutationBusy.current) return;
        const sessions = unwrap(values[0]), accounts = values[1] ? unwrap(values[1]) : undefined, cards = values[2] ? unwrap(values[2]) : undefined;
        setExplorations(sessions); if (accounts) setBudget(accounts); if (cards) setApprovals(cards); setProgressError(undefined);
      } catch (err) {
        if (generation.current !== ownGeneration || progressSequence.current !== ownSequence || loadSequence.current !== ownLoad || mutationBusy.current) return;
        if (err instanceof AutonomyOperationError && err.code === 'STAGE_NOT_READY') setExplorationReady(false);
        setProgressError(err instanceof Error ? err.message : '更新运行进度失败，请刷新核对');
      } finally { if (progressInFlight.current === job) progressInFlight.current = undefined; }
    };
    // Read real clock snapshots: waiting_approval can include other active branches, so the renderer must not guess whether active time is paused.
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { window.clearInterval(timer); progressSequence.current++; };
  }, [open, explorationReady, hasActiveRuns, tab]);
  const needsExpiryClock = approvals.some(item => item.state === 'pending' && Date.parse(item.expiresAt) > clock) || Boolean(explorationPlan && Date.parse(explorationPlan.expiresAt) > clock) || Boolean(rulePreview && Date.parse(rulePreview.previewExpiresAt) > clock);
  useEffect(() => {
    if (!open) return;
    setClock(Date.now());
    if (!needsExpiryClock) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, needsExpiryClock]);
  const mutate = async (operation: () => Promise<unknown>, after?: (value: any) => void, ownGeneration = generation.current) => {
    if (mutationBusy.current || generation.current !== ownGeneration) return;
    mutationBusy.current = true; loadSequence.current++; progressSequence.current++; setBusy(true);
    try {
      const value = await operation();
      if (generation.current !== ownGeneration) return;
      after?.(value); await load();
    } catch (err) {
      if (generation.current !== ownGeneration) return;
      message.error(err instanceof Error ? err.message : '操作未完成');
      if (err instanceof AutonomyOperationError && ['REVISION_CONFLICT', 'PLAN_EXPIRED', 'PLAN_CHANGED', 'PLAN_NOT_FOUND', 'EXPLORATION_ACTIVE', 'GOAL_ALREADY_RUNNING', 'STAGE_NOT_READY', 'STALE_TASK_ATTEMPT', 'PUBLIC_MESSAGE_NOT_ACCEPTED', 'PUBLIC_INBOX_SCOPE_CHANGED', 'PUBLIC_INBOX_SCOPE_MISMATCH', 'PUBLIC_INBOX_DEADLINE_EXPIRED', 'APPROVAL_EXPIRED', 'APPROVAL_CHANGED', 'APPROVAL_NOT_PENDING', 'APPROVAL_NOT_FOUND', 'GOAL_CHANGED', 'GOAL_INACTIVE', 'GOAL_NOT_FOUND', 'DESTINATION_CHANGED', 'RESOURCE_CHANGED', 'POLICY_CHANGED', 'UNTRUSTED_CALLER', 'AUTHORIZATION_CHANGED', 'AUTHORIZATION_REVOKED'].includes(err.code)) {
        setRulePreview(undefined); setExplorationPlan(undefined); setEditorOpen(false); await load();
      }
    } finally { if (generation.current === ownGeneration) { mutationBusy.current = false; setBusy(false); if (changedWhileBusy.current) { changedWhileBusy.current = false; void load(); } } }
  };
  const editGoal = (goal?: PublicGoal) => {
    setEditing(goal); setDraft(goal ? { title: goal.title, topic: goal.topic, sourceUrls: [...goal.sourceUrls], destinationId: goal.destinationId, expectedOutput: goal.expectedOutput, stopConditions: goal.stopConditions, limits: { ...goal.limits } } : newDraft());
    setSourceText(goal?.sourceUrls.join('\n') ?? ''); setEditorOpen(true);
  };
  const saveGoal = () => {
    const value = { ...draft, sourceUrls: sourceText.split(/\r?\n/).map(url => url.trim()).filter(Boolean) };
    return mutate(async () => unwrap(await (editing ? window.electronAPI.autonomy.updateGoal(editing.id, editing.revision, value) : window.electronAPI.autonomy.createGoal(value))), () => { setEditorOpen(false); setRulePreview(undefined); });
  };
  const confirm = (options: Parameters<typeof modal.confirm>[0]) => {
    const instance = modal.confirm({ ...options, afterClose: () => { confirmations.current.delete(instance); options.afterClose?.(); } });
    confirmations.current.add(instance);
  };
  const stateGoal = (goal: PublicGoal, state: PublicGoal['state']) => {
    const ownGeneration = generation.current;
    confirm({ title: state === 'paused' ? '暂停这个主题？' : state === 'archived' ? '归档这个主题？' : '恢复手动开始状态？',
      content: state === 'paused' ? '停止接受这个主题的新操作，并请求当前工作收尾。已有记录和成果保留。' : state === 'archived' ? '主题会保留记录，后续不再开始探索。' : '恢复后可准备新一次手动探索，已有任务不会自动重跑。',
      okText: '确认', cancelText: '取消', onOk: () => mutate(async () => unwrap(await window.electronAPI.autonomy.setGoalState(goal.id, goal.revision, state)), () => setRulePreview(undefined), ownGeneration) });
  };
  const decide = (preview: ApprovalPreview, choice: 'once' | 'run' | 'reject') => {
    const ownGeneration = generation.current;
    if (approvalRunClosed(preview, currentPublic.current.sessions)) { message.info('本次运行已结束等待批准，请刷新查看'); void load(); return; }
    if (Date.parse(preview.expiresAt) <= Date.now()) { message.info('批准卡已过期，请刷新查看'); void load(); return; }
    confirm({ title: choice === 'reject' ? '拒绝这个操作？' : choice === 'once' ? '批准这一次操作？' : '批准本次运行中的相同范围？',
      content: <Flex vertical gap={10}><Typography.Text>{preview.action.summary}</Typography.Text><Typography.Text>资源：{preview.resourceLabel}</Typography.Text><Typography.Text>目的地：{preview.destinationLabel ?? '保存在当前主题'}</Typography.Text><Typography.Text>批准卡确认期限：{time(preview.expiresAt)}</Typography.Text><Typography.Text>{choice === 'once' ? '单次批准须在批准后 2 分钟内启动，且不超过本次运行期限。' : '本次运行授权有效至：' + time(preview.authorizationExpiresAt)}</Typography.Text><Typography.Text>本次运行期限：{time(preview.authorizationExpiresAt)}</Typography.Text><LimitDescription limits={preview.action.units} /><Typography.Text type="secondary">本次决定保留在操作范围内。长期规则需要另行预览和签发。</Typography.Text></Flex>,
      okText: choice === 'reject' ? '拒绝' : '确认批准', cancelText: '取消',
      onOk: () => {
        if (generation.current !== ownGeneration) return;
        if (approvalRunClosed(preview, currentPublic.current.sessions)) { message.info('本次运行已结束等待批准，请刷新查看'); void load(); return; }
        if (Date.parse(preview.expiresAt) <= Date.now()) { message.info('批准卡已过期，请刷新查看'); void load(); return; }
        return mutate(async () => unwrap(await window.electronAPI.autonomy.decideApproval(preview.id, preview.revision, choice)), undefined, ownGeneration);
      } });
  };
  const chooseRuleGoal = async (id?: string) => {
    ruleGoalRef.current = id; setRuleGoalId(id); setRulePreview(undefined); setRuleResources([]); setSelectedResources([]); setSelectedCapabilities([]);
    const ownGeneration = generation.current, ownSequence = ++ruleSequence.current;
    if (!id) return;
    try {
      const value = unwrap(await window.electronAPI.autonomy.getGoal(id));
      if (generation.current === ownGeneration && ruleSequence.current === ownSequence && ruleGoalRef.current === id) setRuleResources(value.resources);
    } catch (err) { if (generation.current === ownGeneration && ruleSequence.current === ownSequence) message.error(err instanceof Error ? err.message : '读取主题范围失败'); }
  };
  const previewStandingRule = () => {
    const goal = goals.find(item => item.id === ruleGoalId); if (!goal) return;
    const ownSequence = ruleSequence.current, ownGoalId = goal.id;
    return mutate(async () => unwrap(await window.electronAPI.autonomy.previewRule({ goalId: goal.id, expectedGoalRevision: goal.revision, capabilities: selectedCapabilities, resourceRefs: selectedResources, expiresAt: new Date(Date.now() + ruleHours * 3600000).toISOString(), resumeAfterRestart: false })), value => {
      if (ruleSequence.current === ownSequence && ruleGoalRef.current === ownGoalId) setRulePreview(value);
    });
  };
  const revoke = (item: StandingRule | GrantProjection, kind: 'rule' | 'grant') => {
    const ownGeneration = generation.current;
    confirm({ title: kind === 'rule' ? '撤回这条长期规则？' : '撤回这项临时批准？', content: '新操作会停止获得此项授权，并请求属于此范围的在途操作收尾。成果和活动记录保留。', okText: '撤回', cancelText: '取消',
      onOk: () => mutate(async () => unwrap(await (kind === 'rule' ? window.electronAPI.autonomy.revokeRule(item.id, item.revision) : window.electronAPI.autonomy.revokeGrant(item.id, item.revision))), () => setRulePreview(undefined), ownGeneration) });
  };
  const changeDeny = (kind: 'public' | 'legacy', key: string, deny: boolean) => {
    if (!policy) return;
    const patch = { deniedCapabilities: [...policy.deniedCapabilities], deniedLegacyTools: [...policy.deniedLegacyTools] };
    if (kind === 'public') patch.deniedCapabilities = deny ? [...new Set([...patch.deniedCapabilities, key as PublicCapability])] : patch.deniedCapabilities.filter(item => item !== key);
    else patch.deniedLegacyTools = deny ? [...new Set([...patch.deniedLegacyTools, key as keyof typeof legacyNames])] : patch.deniedLegacyTools.filter(item => item !== key);
    void mutate(async () => unwrap(await window.electronAPI.autonomy.updatePolicy(policy.revision, patch)));
  };
  const requestOs = (row: OsPermissionStatus) => {
    const ownGeneration = generation.current;
    confirm({ title: `申请${row.label}系统权限？`, content: '确认后向当前客户端发起系统申请，最终状态以系统检测和设置为准。', okText: '申请', cancelText: '取消',
      onOk: () => mutate(async () => unwrap(await window.electronAPI.autonomy.requestOs(row.kind)), undefined, ownGeneration) });
  };
  const previewExploration = () => {
    if (!planningGoal || !explorationReady) return;
    const goal = planningGoal, ownSequence = ++planSequence.current;
    return mutate(async () => unwrap(await window.electronAPI.autonomy.planExploration(goal.id, goal.revision, protocol)), value => {
      if (planSequence.current === ownSequence) setExplorationPlan(value);
    });
  };
  const startExploration = () => {
    const plan = explorationPlan;
    if (!plan || !explorationReady) return;
    if (Date.parse(plan.expiresAt) <= Date.now()) { setExplorationPlan(undefined); message.info('探索计划已过期，请重新预览'); return; }
    return mutate(async () => unwrap(await window.electronAPI.autonomy.startExploration(plan.id, plan.revision)), () => {
      setExplorationPlan(undefined); setPlanningGoal(undefined); setTab('explorations');
    });
  };
  const stopExploration = (session: ExplorationSession) => {
    const ownGeneration = generation.current;
    confirm({ title: '停止本次探索？', content: '停止本次运行的新操作并等待网络、文件和记录收尾。已有成果和活动保留，其他主题继续运行。', okText: '请求停止', cancelText: '取消',
      onOk: () => mutate(async () => unwrap(await window.electronAPI.autonomy.stopExploration(session.runId)), () => message.info('已请求停止，最终状态以收尾后的记录为准'), ownGeneration) });
  };
  const appendPublic = (session: ExplorationSession) => {
    const draft = publicDrafts[session.runId], destination = session.destination; if (!draft?.text.trim() || !draft.confirmed || !destination) return;
    if (draft.text.length > 4000 || publicBytes(draft.text) > 4096) { message.info(publicMessageReasons['too-long']); return; }
    const ownGeneration = generation.current;
    confirm({ title: '确认这段补充可以公开发送？', content: <Flex vertical gap={8}><Typography.Text>所属主题：{goals.find(goal => goal.id === session.goalId)?.title ?? session.goalId}{session.goalRevision === undefined ? '' : ` · 本次主题版本 ${session.goalRevision}`}</Typography.Text><Typography.Text>本次模型目的地：{destination.label} · {destination.endpointOrigin} · {destination.model}</Typography.Text><Typography.Paragraph>{draft.text}</Typography.Paragraph><Typography.Text>按提交顺序排队，仅在本次总结请求前的安全点加入公开资料。模型请求开始后的补充需留到下一轮再次确认。</Typography.Text></Flex>, okText: '确认公开并排队', cancelText: '取消',
      onOk: () => {
        if (generation.current !== ownGeneration) return;
        const latest = currentPublic.current.sessions.find(item => item.runId === session.runId), latestDraft = currentPublic.current.drafts[session.runId];
        if (!latest || !acceptsPublic(latest, currentPublic.current.ready) || latest.goalRevision !== session.goalRevision || latest.destination?.revision !== destination.revision || latest.destination?.id !== destination.id || latest.destination?.endpointOrigin !== destination.endpointOrigin || latest.destination?.model !== destination.model || latestDraft?.messageId !== draft.messageId || !latestDraft.confirmed) {
          message.info('补充内容或运行阶段已变化，请核对后再次确认'); return;
        }
        return mutate(async () => {
        const receipt = unwrap(await window.electronAPI.autonomy.appendPublicMessage(session.runId, draft.messageId, draft.text, true));
        if (!receipt.accepted) {
          throw new AutonomyOperationError('PUBLIC_MESSAGE_NOT_ACCEPTED', publicMessageReasons[receipt.reason ?? ''] ?? '本次未接纳公开补充，请保留内容并核对运行状态');
        }
        return receipt;
      }, () => {
        setPublicDrafts(values => values[session.runId]?.messageId === draft.messageId ? { ...values, [session.runId]: { messageId: crypto.randomUUID(), text: '', confirmed: false } } : values);
        message.info('公开补充已排队，模型仅在总结前的安全点读取');
      }, ownGeneration); } });
  };
  useEffect(() => {
    if (!explorationPlan) return;
    const goal = goals.find(item => item.id === explorationPlan.goalId);
    if (!explorationReady || !goal || goal.revision !== explorationPlan.goalRevision || goal.state !== 'active' || explorations.some(item => item.goalId === goal.id && activeExploration(item))) setExplorationPlan(undefined);
  }, [goals, explorations, explorationReady, explorationPlan]);
  useEffect(() => {
    if (!planningGoal) return;
    const latest = goals.find(item => item.id === planningGoal.id);
    if (latest && latest.revision !== planningGoal.revision) { planSequence.current++; setExplorationPlan(undefined); setPlanningGoal(latest); }
  }, [goals, planningGoal]);
  const limitsFields: Array<{ key: keyof ExplorationLimits; label: string; unit: number; max: number }> = [
    { key: 'modelRequests', label: '模型请求上限', unit: 1, max: 20 }, { key: 'fetchRequests', label: '网页请求上限', unit: 1, max: 32 },
    { key: 'downloadBytes', label: '下载总量（MiB）', unit: 1048576, max: 20 }, { key: 'storageBytes', label: '保存总量（MiB）', unit: 1048576, max: 20 },
    { key: 'tokenUnits', label: 'Token 保守预留', unit: 1, max: 1000000 }, { key: 'activeMilliseconds', label: '活跃执行上限（分钟）', unit: 60000, max: 15 },
    { key: 'absoluteMilliseconds', label: '本次绝对时限（分钟）', unit: 60000, max: 60 }, { key: 'maxDocumentBytes', label: '单份文档上限（MiB）', unit: 1048576, max: 1 }, { key: 'concurrency', label: '读取并发', unit: 1, max: 2 },
  ];
  return <Drawer title="主题与权限" open={open} onClose={onClose} size="large" styles={{ body: { padding: 24 } }}>
    <Flex data-testid="autonomy-center" vertical gap={16}>
      <Flex justify="space-between" align="center"><Typography.Text type="secondary">主题、批准与系统权限分别管理</Typography.Text><Button loading={loading} icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button></Flex>
      <Alert type="info" showIcon title={explorationReady ? '可手动开始一次公开探索' : '已开放主题与授权管理'} description={explorationReady ? '先确认来源、模型协议和额度，再开始一轮读取、总结与保存。每项操作按批准范围执行。' : '手动探索将在公开读取与硬额度验证完成后开放。当前修改主题和规则不会发起模型或网页请求。'} />
      {error && <Alert type="error" showIcon title={error} />}
      {progressError && <Alert type="warning" showIcon title={`运行进度暂未更新：${progressError}`} />}
      {loading && !goals.length && <Spin />}
      <Tabs activeKey={tab} onChange={setTab} destroyOnHidden items={[
        { key: 'goals', label: '探索主题', children: <Flex vertical gap={12}>
          <Button icon={<PlusOutlined />} disabled={busy} onClick={() => editGoal()}>新建主题</Button>
          {!loading && !goals.length && <Empty description="添加你想持续了解的公开主题" />}
          {goals.map(goal => <Flex key={goal.id} vertical gap={12} style={cardStyle}>
            <Flex justify="space-between" gap={8}><Typography.Text strong>{goal.title}</Typography.Text><Tag>{goalStates[goal.state]}</Tag></Flex>
            <Typography.Paragraph style={{ margin: 0 }}>{goal.topic}</Typography.Paragraph>
            <Typography.Text type="secondary">来源：{goal.sourceUrls.join('、')}</Typography.Text>
            <Typography.Text type="secondary">模型：{destinations.find(item => item.id === goal.destinationId)?.label ?? '需核实模型目的地'}</Typography.Text>
            <Typography.Text>目标成果：{goal.expectedOutput}</Typography.Text>
            <Typography.Text>停止条件：{goal.stopConditions}</Typography.Text>
            <details><summary>查看本次额度上限</summary><LimitDescription limits={goal.limits} /></details>
            <Flex gap={8} wrap><Button disabled={busy} onClick={() => editGoal(goal)}>编辑</Button><Button disabled={busy || goal.state === 'archived'} onClick={() => stateGoal(goal, goal.state === 'active' ? 'paused' : 'active')}>{goal.state === 'active' ? '暂停主题' : '恢复主题'}</Button><Button disabled={busy || goal.state === 'archived'} onClick={() => stateGoal(goal, 'archived')}>归档</Button><Button disabled={busy || !explorationReady || goal.state !== 'active' || explorations.some(item => item.goalId === goal.id && activeExploration(item))} onClick={() => { planSequence.current++; setExplorationPlan(undefined); setProtocol('chat-completions'); setPlanningGoal(goal); }}>{explorationReady ? '手动探索' : '手动探索（准备中）'}</Button></Flex>
          </Flex>)}
        </Flex> },
        { key: 'background', label: '后台与学习', children: <BackgroundLearningPanel goals={goals} destinations={destinations} explorations={explorations} /> },
        { key: 'explorations', label: '探索进度', children: <Flex vertical gap={12}>
          {!explorationReady && <Alert type="info" title="手动探索尚未就绪" />}
          {!explorations.length && <Empty description="预览并开始一次公开探索后，在这里查看进度" />}
          {explorations.map(session => {
            const pending = activeExploration(session) && session.state !== 'stop_requested' ? Math.max(0, session.pendingApprovalCount ?? approvals.filter(card => card.runId === session.runId && card.state === 'pending' && Date.parse(card.expiresAt) > clock).length) : 0;
            const value = publicDrafts[session.runId];
            const accepts = acceptsPublic(session, explorationReady), byteCount = publicBytes(value?.text ?? '');
            return <Flex key={session.id} vertical gap={10} style={cardStyle}>
              <Flex justify="space-between"><Typography.Text strong>{goals.find(goal => goal.id === session.goalId)?.title ?? '公开探索'}</Typography.Text><Tag>{explorationStates[session.state] ?? '状态待确认'}</Tag></Flex>
              <Typography.Text>{session.phase ? phases[session.phase] : '等待最新阶段记录'} · 已完成来源 {session.sourceCount}{session.sourceTotal === undefined ? '' : ` / ${session.sourceTotal}`}{session.additionCount === undefined ? '' : ` · 已纳入总结补充 ${session.additionCount}`}</Typography.Text>
              {session.destination && <Typography.Text type="secondary">本次模型：{session.destination.label} · {session.destination.endpointOrigin} · {session.destination.model}</Typography.Text>}
              {pending > 0 && <Alert type="warning" title={`有 ${pending} 项操作等待批准`} description={<Button onClick={() => setTab('approvals')}>查看批准卡</Button>} />}
              {session.activeRemainingMilliseconds !== undefined && <Typography.Text type="secondary">活跃执行剩余 {Math.ceil(session.activeRemainingMilliseconds / 1000)} 秒 · 绝对期限剩余 {Math.ceil((session.absoluteRemainingMilliseconds ?? 0) / 1000)} 秒</Typography.Text>}
              {session.stopReason && <Typography.Text>收尾原因：{stopReasons[session.stopReason] ?? '操作已收尾，请在活动记录中核对'}</Typography.Text>}
              <Flex gap={8}><Button disabled={busy || !activeExploration(session) || session.state === 'stop_requested'} onClick={() => stopExploration(session)}>停止本次探索</Button>{session.artifactId && <Button disabled={busy} onClick={() => void mutate(async () => unwrap(await window.electronAPI.muse.openArtifact(session.artifactId!)))}>打开成果</Button>}</Flex>
              {session.artifactId && <Typography.Text type="secondary">成果已登记；验证和接受状态请在成果中心核对。</Typography.Text>}
              {(activeExploration(session) || !!value?.text.trim()) && <Flex vertical gap={8}>
                {!activeExploration(session) && <Typography.Text>尚未发送的公开补充草稿；可复制，在下一轮再次确认。</Typography.Text>}
                <Input.TextArea aria-label={`公开补充-${session.runId}`} placeholder="仅填写你允许发送给本主题模型的公开补充" maxLength={4000} disabled={busy} readOnly={!accepts} value={value?.text ?? ''} onChange={event => {
                  if (accepts) setPublicDrafts(values => ({ ...values, [session.runId]: { messageId: crypto.randomUUID(), text: event.target.value, confirmed: false } }));
                }} />
                <Typography.Text type={byteCount > 4096 ? 'warning' : 'secondary'}>公开补充大小：{byteCount} / 4096 个 UTF-8 字节{byteCount > 4096 ? '，请缩短内容' : ''}</Typography.Text>
                <Checkbox disabled={busy || !accepts} checked={value?.confirmed ?? false} onChange={event => setPublicDrafts(values => ({ ...values, [session.runId]: { messageId: values[session.runId]?.messageId ?? crypto.randomUUID(), text: values[session.runId]?.text ?? '', confirmed: event.target.checked } }))}>我确认这段内容可作为公开资料发送给本主题模型</Checkbox>
                <Button disabled={busy || !accepts || !value?.confirmed || !value.text.trim() || byteCount > 4096} onClick={() => appendPublic(session)}>确认公开补充</Button>
                {!accepts && <Typography.Text type="secondary">{!session.destination ? '本次模型范围尚未确认，请刷新查看后再补充。' : '总结已开始或正在收尾，新补充需留到下一轮再次确认。'}</Typography.Text>}
              </Flex>}
            </Flex>;
          })}
        </Flex> },
        { key: 'budget', label: '自主阅读预算', children: <Flex vertical gap={12}>
          <Alert type="info" title="仅统计自主公开阅读" description="未知用量计入预留。UTC 日预算按 UTC 零点切换，主题和全局累计预算保留。Token 是保守计账；超过接收边界的最后一个网络 chunk 按实际字节记账。" />
          {!budget?.accounts.length && <Empty description={explorationReady ? '首次运行预留后显示账户用量' : '读取与额度模块尚未就绪'} />}
          {budget?.accounts.map(account => <Flex key={account.id} vertical gap={8} style={cardStyle}><Typography.Text strong>{budgetNames[account.scope ?? account.kind] ?? '自主阅读账户'}</Typography.Text>{account.scope === 'goal' && <Typography.Text>主题：{goals.find(goal => goal.id === account.scopeRef)?.title ?? account.scopeRef}</Typography.Text>}{account.timezone === 'UTC' && <Typography.Text>UTC 窗口：{account.windowStart} 至 {account.windowEnd}</Typography.Text>}<AmountDescription label="上限" amounts={account.limits} /><AmountDescription label="已用" amounts={account.used} /><AmountDescription label="预留（含未知用量）" amounts={account.reserved} />{account.remaining && <AmountDescription label="剩余" amounts={account.remaining} />}</Flex>)}
        </Flex> },
        { key: 'approvals', label: `批准卡${approvals.filter(item => item.state === 'pending' && Date.parse(item.expiresAt) > clock && !approvalRunClosed(item, explorations)).length ? `（${approvals.filter(item => item.state === 'pending' && Date.parse(item.expiresAt) > clock && !approvalRunClosed(item, explorations)).length}）` : ''}`, children: <Flex vertical gap={12}>
          {!approvals.length && <Empty description="暂无待确认操作" />}
          {approvals.map(preview => <Flex key={preview.id} vertical gap={10} style={cardStyle}>
            <Flex justify="space-between"><Typography.Text strong>{capabilityNames[preview.action.capability]}</Typography.Text><Tag>{preview.state === 'pending' ? '等待确认' : preview.state === 'approved' ? '已批准' : preview.state === 'rejected' ? '已拒绝' : '已失效'}</Tag></Flex>
            <Typography.Text>{preview.action.summary}</Typography.Text><Typography.Text>资源：{preview.resourceLabel}</Typography.Text><Typography.Text>目的地：{preview.destinationLabel ?? '当前主题成果目录'}</Typography.Text>
            <Typography.Text>批准卡确认期限：{time(preview.expiresAt)}</Typography.Text><Typography.Text>本次运行授权有效至：{time(preview.authorizationExpiresAt)}</Typography.Text><Typography.Text type="secondary">单次批准须在批准后 2 分钟内启动，且不超过本次运行期限。</Typography.Text><LimitDescription limits={preview.action.units} />
            <Flex gap={8} wrap><Button type="primary" disabled={busy || preview.state !== 'pending' || Date.parse(preview.expiresAt) <= clock || approvalRunClosed(preview, explorations)} onClick={() => decide(preview, 'once')}>仅这一次</Button><Button disabled={busy || preview.state !== 'pending' || Date.parse(preview.expiresAt) <= clock || approvalRunClosed(preview, explorations)} onClick={() => decide(preview, 'run')}>本次运行</Button><Button disabled={busy || preview.state !== 'pending' || Date.parse(preview.expiresAt) <= clock || approvalRunClosed(preview, explorations)} onClick={() => decide(preview, 'reject')}>拒绝</Button></Flex>
          </Flex>)}
          {grants.map(grant => <Flex key={grant.id} gap={8} align="center" justify="space-between" style={cardStyle}><Flex vertical gap={4}><Typography.Text>{capabilityNames[grant.capability]} · {grant.scope === 'once' ? '单次批准' : '本次运行批准'}</Typography.Text><Typography.Text type="secondary">资源编号：{grant.resourceRef} · {grantStates[grant.state] ?? '状态待确认'} · {time(grant.expiresAt)}</Typography.Text></Flex><Button disabled={busy || grant.state !== 'active' || Date.parse(grant.expiresAt) <= clock} onClick={() => revoke(grant, 'grant')}>撤回</Button></Flex>)}
        </Flex> },
        { key: 'rules', label: '长期规则', children: <Flex vertical gap={12}>
          <Typography.Text type="secondary">独立签发明确范围的手动规则；单次批准不会自动变成长期开关。后台计划在「后台与学习」确认范围和暂停。</Typography.Text>
          <Select allowClear value={ruleGoalId} placeholder="选择规则所属主题" onChange={value => void chooseRuleGoal(value)} disabled={busy} options={goals.filter(goal => goal.state === 'active').map(goal => ({ value: goal.id, label: goal.title }))} />
          {ruleGoalId && <Flex vertical gap={12} style={cardStyle}>
            <Typography.Text strong>允许的动作</Typography.Text><Checkbox.Group value={selectedCapabilities} options={PUBLIC_CAPABILITIES.map(value => ({ value, label: capabilityNames[value] }))} onChange={values => { ruleSequence.current++; setRulePreview(undefined); setSelectedCapabilities(values as PublicCapability[]); }} disabled={busy} />
            <Select mode="multiple" placeholder="选择已登记的公开资源" value={selectedResources} onChange={values => { ruleSequence.current++; setRulePreview(undefined); setSelectedResources(values); }} options={ruleResources.map(resource => ({ value: resource.id, label: resource.url ?? resource.id }))} disabled={busy} />
            <Flex gap={8} align="center"><Typography.Text>有效时长（小时）</Typography.Text><InputNumber min={1} max={720} value={ruleHours} disabled={busy} onChange={value => { ruleSequence.current++; setRulePreview(undefined); setRuleHours(value ?? 24); }} /></Flex>
            <Button disabled={busy || !selectedCapabilities.length || !selectedResources.length} onClick={() => void previewStandingRule()}>预览长期规则</Button>
          </Flex>}
          {rules.map(rule => <Flex key={rule.id} vertical gap={8} style={cardStyle}><Flex justify="space-between"><Typography.Text strong>{goals.find(goal => goal.id === rule.goalId)?.title ?? '主题规则'} · 版本 {rule.goalRevision}</Typography.Text><Tag>{ruleStates[rule.state]}</Tag></Flex><Typography.Text>{rule.capabilities.map(item => capabilityNames[item]).join('、')}</Typography.Text><Typography.Text>资源编号：{rule.resourceRefs.join('、')}</Typography.Text><Typography.Text>目的地编号：{rule.destinationId}</Typography.Text><Typography.Text>有效至：{time(rule.expiresAt)}</Typography.Text><Typography.Text type="secondary">{rule.resumeAfterRestart ? '后台计划范围：应用重启后可在有限有效期内恢复，由后台计划控制调度。' : '手动规则：应用重启后需要再次确认，不会自动开始。'}</Typography.Text><details><summary>查看规则额度上限</summary><LimitDescription limits={rule.limits} /></details><Button disabled={busy || rule.state !== 'active' || Date.parse(rule.expiresAt) <= clock} onClick={() => revoke(rule, 'rule')}>撤回规则</Button></Flex>)}
        </Flex> },
        { key: 'permissions', label: '权限管理', children: <Flex vertical gap={12}>
          <Alert type="info" title="应用范围与系统授权分别确认" description="系统已授权不代表公开探索可以使用 Shell、私人资料或登录会话。这里的禁用项可以收紧应用调用，取消禁用也不会自行签发探索批准。" />
          {policy?.warnings.map((warning, i) => <Alert key={i} type="warning" title={warning} />)}
          <Typography.Title level={5}>限制公开能力</Typography.Title>
          {PUBLIC_CAPABILITIES.map(capability => <Checkbox key={capability} disabled={busy || !policy} checked={policy?.deniedCapabilities.includes(capability)} onChange={event => changeDeny('public', capability, event.target.checked)}>禁用{capabilityNames[capability]}</Checkbox>)}
          <Typography.Title level={5}>限制现有工具</Typography.Title>
          <Typography.Text type="secondary">禁用现有工具会阻止后续派发；正在执行的工具按其已有停止能力处理。</Typography.Text>
          {(Object.keys(legacyNames) as Array<keyof typeof legacyNames>).map(key => <Checkbox key={key} disabled={busy || !policy} checked={policy?.deniedLegacyTools.includes(key)} onChange={event => changeDeny('legacy', key, event.target.checked)}>禁用{legacyNames[key]}</Checkbox>)}
          <Typography.Title level={5}><SafetyCertificateOutlined /> macOS 系统权限</Typography.Title>
          {osRows.map(row => <Flex key={row.kind} vertical gap={10} style={cardStyle}><Flex justify="space-between"><Typography.Text strong>{row.label}</Typography.Text><Tag color={row.status === 'granted' ? 'success' : row.status === 'not-granted' ? 'warning' : undefined}>{row.status === 'granted' ? '系统已授权' : row.status === 'not-granted' ? '尚未授权' : '需在系统设置确认'}</Tag></Flex><Typography.Text type="secondary">{row.detail}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 12 }}>检测时间：{time(row.checkedAt)}</Typography.Text><Flex gap={8}><Button disabled={busy || !row.requestSupported} onClick={() => requestOs(row)}>申请系统权限</Button><Button disabled={busy || !row.settingsSupported} onClick={() => void mutate(async () => { const value = unwrap(await window.electronAPI.autonomy.openOsSettings(row.kind)); if (!value.opened) throw new Error('设置入口未打开，请手动前往系统设置 → 隐私与安全性'); message.info('已打开系统设置，请在那里确认授权后刷新'); })}>打开系统设置</Button></Flex></Flex>)}
        </Flex> },
      ]} />
    </Flex>
    <Modal title="确认本次公开探索" open={Boolean(planningGoal)} onCancel={() => { planSequence.current++; setPlanningGoal(undefined); setExplorationPlan(undefined); }} footer={null} width={680}>
      {planningGoal && <Flex vertical gap={12}><Typography.Text strong>{planningGoal.title} · 主题版本 {planningGoal.revision}</Typography.Text><Select aria-label="公开模型协议" disabled={busy} value={protocol} options={Object.entries(protocolNames).map(([value, label]) => ({ value, label }))} onChange={value => { planSequence.current++; setProtocol(value); setExplorationPlan(undefined); }} /><Alert type="info" title="预览不会发出请求或开始运行" description="本次只做一轮公开读取、总结和保存；文字停止条件作为总结要求，运行还受额度、期限、撤回与人工停止约束。" />
        <Button disabled={busy || !explorationReady} onClick={() => void previewExploration()}>预览本次探索</Button>
        {explorationPlan && <Flex vertical gap={10}><Typography.Text>公开来源：{explorationPlan.sources.map(source => source.url ?? source.id).join('、')}</Typography.Text><Typography.Text>模型目的地：{explorationPlan.destination.label} · {explorationPlan.destination.endpointOrigin} · {explorationPlan.destination.model}</Typography.Text><Typography.Text>请求协议：{protocolNames[explorationPlan.protocol]}</Typography.Text><Typography.Text>计划确认期限：{time(explorationPlan.expiresAt)}</Typography.Text><LimitDescription limits={explorationPlan.limits} /><Typography.Text type="secondary">开始后按卡片或长期规则核准实际操作。公开 context 仅包含本主题、已登记来源和再次确认公开的本轮补充。</Typography.Text><Button type="primary" disabled={busy || !explorationReady || Date.parse(explorationPlan.expiresAt) <= clock} onClick={() => void startExploration()}>确认范围并开始</Button></Flex>}
      </Flex>}
    </Modal>
    <Modal title={editing ? '编辑探索主题' : '新建探索主题'} open={editorOpen} onCancel={() => setEditorOpen(false)} onOk={() => void saveGoal()} okText="保存主题" cancelText="取消" confirmLoading={busy} width={680}>
      <Flex vertical gap={12}>
        <Alert type="info" title="请仅填写公开问题与公开网址" description="保存主题不会授权读取私人聊天、附件或登录状态。模型目的地与来源在规则预览时再次确认。" />
        <Input aria-label="主题名称" placeholder="主题名称" maxLength={120} value={draft.title} onChange={event => setDraft(value => ({ ...value, title: event.target.value }))} />
        <Input.TextArea aria-label="研究问题" placeholder="想持续了解什么公开问题？" maxLength={4000} value={draft.topic} onChange={event => setDraft(value => ({ ...value, topic: event.target.value }))} />
        <Input.TextArea aria-label="公开来源" placeholder="公开 HTTPS 来源，每行一个网址，最多 8 个" maxLength={16400} value={sourceText} onChange={event => setSourceText(event.target.value)} />
        <Select aria-label="模型目的地" placeholder="选择已配置模型目的地" value={draft.destinationId || undefined} options={destinations.filter(item => item.available).map(item => ({ value: item.id, label: `${item.label} · ${item.endpointOrigin} · ${item.model}` }))} onChange={destinationId => setDraft(value => ({ ...value, destinationId }))} />
        <Input.TextArea aria-label="预期成果" placeholder="预期成果，例如有出处的一页简报" maxLength={1000} value={draft.expectedOutput} onChange={event => setDraft(value => ({ ...value, expectedOutput: event.target.value }))} />
        <Input.TextArea aria-label="停止条件" placeholder="满足什么条件就停止？" maxLength={1000} value={draft.stopConditions} onChange={event => setDraft(value => ({ ...value, stopConditions: event.target.value }))} />
        <Flex gap={12} wrap>{limitsFields.map(field => <Flex key={field.key} vertical gap={4} style={{ width: 'calc(50% - 6px)' }}><Typography.Text>{field.label}</Typography.Text><InputNumber min={1} max={field.max} value={draft.limits[field.key] / field.unit} onChange={number => setDraft(value => ({ ...value, limits: { ...value.limits, [field.key]: Math.round((number ?? 1) * field.unit) } }))} style={{ width: '100%' }} /></Flex>)}</Flex>
      </Flex>
    </Modal>
    <Modal title="确认长期规则范围" open={Boolean(rulePreview)} onCancel={() => setRulePreview(undefined)} footer={null}>
      {rulePreview && <Flex vertical gap={12}><Typography.Text strong>{goals.find(goal => goal.id === rulePreview.goalId)?.title ?? '主题规则'}</Typography.Text><Typography.Text>动作：{rulePreview.capabilities.map(item => capabilityNames[item]).join('、')}</Typography.Text><Typography.Text>公开资源：{rulePreview.resources.map(resource => resource.url ?? resource.id).join('、')}</Typography.Text><Typography.Text>模型目的地：{rulePreview.destination.label} · {rulePreview.destination.endpointOrigin} · {rulePreview.destination.model}</Typography.Text><Typography.Text>规则有效至：{time(rulePreview.expiresAt)}</Typography.Text><Typography.Text>本预览有效至：{time(rulePreview.previewExpiresAt)}</Typography.Text><LimitDescription limits={rulePreview.limits} /><Typography.Text type="secondary">签发后仅适用于上述主题版本和范围；重启不会自动开始探索。</Typography.Text><Flex gap={8} justify="end"><Button onClick={() => setRulePreview(undefined)}>取消</Button><Button type="primary" disabled={busy || Date.parse(rulePreview.previewExpiresAt) <= clock} onClick={() => {
          const preview = rulePreview, ownGeneration = generation.current;
          if (Date.parse(preview.previewExpiresAt) <= Date.now()) { setRulePreview(undefined); message.info('预览已过期，请重新生成'); return; }
          void mutate(async () => unwrap(await window.electronAPI.autonomy.issueRule(preview.id, preview.revision)), () => setRulePreview(undefined), ownGeneration);
        }}>确认签发规则</Button></Flex></Flex>}
    </Modal>
  </Drawer>;
}

const backgroundStates = { enabled: '后台已启用', paused: '已暂停', blocked: '范围失效，已停止', expired: '已过期' };
const backgroundReasons: Record<string, string> = {
  GOAL_CHANGED: '主题范围已变化，请重新配置', GOAL_INACTIVE: '主题已暂停或归档', DESTINATION_CHANGED: '模型配置已变化，请重新配置',
  DESTINATION_UNAVAILABLE: '模型配置尚未就绪', POLICY_CHANGED: '权限策略已变化，请重新配置', POLICY_BLOCKED: '权限策略阻止执行',
  AUTHORIZATION_REVOKED: '范围批准已撤回', AUTHORIZATION_CHANGED: '范围批准已变化', BUDGET_EXHAUSTED: '自主阅读预算不足',
  BACKGROUND_DAILY_LIMIT: '今日轮数已用完，等待下个 UTC 日', DAILY_LIMIT: '今日轮数已用完，等待下个 UTC 日',
  PROCESS_INTERRUPTED: '上轮进程中断，请核对活动记录', OUTCOME_UNKNOWN: '上轮回执不明，请核对活动记录',
  BACKGROUND_RECONFIGURE_REQUIRED: '后台范围已失效，请重新配置', BACKGROUND_RUNNING: '本计划已有轮次在运行，请等待收尾',
  FOREGROUND_BUSY: '专业任务正在执行，后台等待安全空闲时机', AUTHORIZATION_REQUIRED: '后台范围需要重新批准', RESOURCE_CHANGED: '公开来源已变化，请重新配置',
  GOAL_ALREADY_RUNNING: '同主题已有运行，等待收尾', APPLICATION_CLOSED: '应用已请求关闭', EXPIRED: '范围已到期',
};

/** Background controls remain independent from legacy custom skills and professional task configuration. */
export function BackgroundLearningPanel({ goals, destinations, explorations }: { goals: PublicGoal[]; destinations: ModelDestination[]; explorations: ExplorationSession[] }) {
  const { message, modal } = App.useApp(), { token } = theme.useToken();
  const generation = useRef(0), refreshing = useRef<{ generation: number; pending: boolean; promise: Promise<void> } | undefined>(undefined), mutating = useRef(false);
  const confirmations = useRef(new Set<{ destroy: () => void }>());
  const [ready, setReady] = useState(false), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const [schedules, setSchedules] = useState<BackgroundSchedule[]>([]), [skills, setSkills] = useState<LearnedSkill[]>([]);
  const [goalId, setGoalId] = useState<string>(), [intervalMinutes, setIntervalMinutes] = useState(30), [dailyRoundLimit, setDailyRoundLimit] = useState(3), [days, setDays] = useState(7);
  const [protocol, setProtocol] = useState<BackgroundConfiguration['protocol']>('chat-completions'), [learningEnabled, setLearningEnabled] = useState(true), [autoPromote, setAutoPromote] = useState(true), [confirmed, setConfirmed] = useState(false);
  const latest = useRef({ goals, destinations, explorations, schedules, skills, ready }); latest.current = { goals, destinations, explorations, schedules, skills, ready };
  const formRevision = useRef(0);
  const cardStyle = { border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadiusLG, background: token.colorBgContainer, padding: 16 };
  const changeForm = (change: () => void) => { formRevision.current++; setConfirmed(false); change(); };
  const load = useCallback((): Promise<void> => {
    const ownGeneration = generation.current;
    if (refreshing.current?.generation === ownGeneration) { refreshing.current.pending = true; return refreshing.current.promise; }
    const job = { generation: ownGeneration, pending: false, promise: Promise.resolve() }; refreshing.current = job;
    job.promise = Promise.resolve().then(async () => {
      do {
        job.pending = false; if (generation.current !== ownGeneration) return;
        const api = window.electronAPI?.background;
        if (!api) { setReady(false); setError('后台与学习入口尚未就绪'); return; }
        setLoading(true);
        try {
          const status = unwrap(await api.status());
          const values = status.ready ? await Promise.all([api.list(), api.listSkills()]) : undefined;
          if (generation.current !== ownGeneration) return;
          // Publish complete background and learning facts together; never combine a failed member with older authorization.
          const nextSchedules = values ? unwrap(values[0]) : [], nextSkills = values ? unwrap(values[1]) : [];
          setReady(status.ready); setSchedules(nextSchedules); setSkills(nextSkills); setError(undefined);
        } catch (error) { if (generation.current === ownGeneration) { setReady(false); setError(error instanceof Error ? error.message : '读取后台与学习失败'); } }
        finally { if (generation.current === ownGeneration) setLoading(false); }
      } while (job.pending && generation.current === ownGeneration);
    }).finally(() => { if (refreshing.current === job) refreshing.current = undefined; });
    return job.promise;
  }, []);
  useEffect(() => {
    generation.current++; void load();
    const unsubscribe = window.electronAPI?.background?.onChanged(() => { void load(); });
    const timer = window.setInterval(() => { if (!mutating.current && !refreshing.current) void load(); }, 10000);
    return () => { generation.current++; window.clearInterval(timer); unsubscribe?.(); for (const item of confirmations.current) item.destroy(); confirmations.current.clear(); };
  }, [load]);
  const goal = goals.find(item => item.id === goalId), destination = destinations.find(item => item.id === goal?.destinationId);
  const selectedGoalRevision = goal?.revision, selectedDestinationRevision = destination?.revision;
  useEffect(() => { formRevision.current++; setConfirmed(false); }, [goalId, selectedGoalRevision, selectedDestinationRevision]);
  const confirm = (config: Parameters<typeof modal.confirm>[0]) => {
    let handle: { destroy: () => void };
    handle = modal.confirm({ ...config, afterClose: () => { confirmations.current.delete(handle); config.afterClose?.(); } });
    confirmations.current.add(handle);
  };
  const mutate = async (ownGeneration: number, operation: () => Promise<unknown>, success: string) => {
    if (generation.current !== ownGeneration || mutating.current) return;
    mutating.current = true; setBusy(true);
    try { await operation(); if (generation.current === ownGeneration) { message.success(success); await load(); } }
    catch (error) { if (generation.current === ownGeneration) { message.error(error instanceof Error ? error.message : '操作未完成'); await load(); } }
    finally { if (generation.current === ownGeneration) { mutating.current = false; setBusy(false); } }
  };
  const configure = () => {
    if (!goal || !destination?.available || goal.state !== 'active' || !ready || !confirmed) return;
    const ownGeneration = generation.current, ownForm = formRevision.current;
    const chosenGoal = goal, chosenDestination = destination;
    const config: BackgroundConfiguration = { intervalMinutes, dailyRoundLimit, expiresAt: new Date(Date.now() + days * 86400000).toISOString(), protocol, learningEnabled, autoPromote };
    confirm({ title: '确认后台公开范围与学习？', okText: '确认范围并启用', cancelText: '取消',
      content: <Flex vertical gap={8}><Typography.Text>{goal.title} · 主题版本 {goal.revision}</Typography.Text><Typography.Text>仅允许来源：{goal.sourceUrls.join('、')}</Typography.Text><Typography.Text>模型目的地：{destination.label} · {destination.endpointOrigin} · {destination.model}</Typography.Text><Typography.Text>协议：{protocolNames[protocol]} · 每 {intervalMinutes} 分钟检查 · UTC 每天最多 {dailyRoundLimit} 轮 · 有效至 {time(config.expiresAt)}</Typography.Text><LimitDescription limits={goal.limits} /><Typography.Text>允许阅读已登记公开来源、向上述模型发送本主题公开资料、保存成果。重启后在相同范围和有效期内恢复计划；范围变化立即停止。</Typography.Text><Typography.Text>{learningEnabled ? `从本轮成果提取纯文本方法，${autoPromote ? '通过格式、来源和范围校验后自动启用新版本' : '仅保留候选'}` : '本计划不提取学习候选'}。候选正确性仍需核对；不执行代码、不修改应用、不覆盖已有自定义 skills。</Typography.Text></Flex>,
      onOk: () => {
        if (generation.current !== ownGeneration || formRevision.current !== ownForm) return;
        const currentGoal = latest.current.goals.find(item => item.id === chosenGoal.id), currentDestination = latest.current.destinations.find(item => item.id === chosenDestination.id);
        if (!latest.current.ready || currentGoal?.revision !== chosenGoal.revision || currentGoal.state !== 'active' || currentDestination?.revision !== chosenDestination.revision || !currentDestination.available || Date.parse(config.expiresAt) <= Date.now()) { message.info('主题或模型范围已变化，请重新确认'); void load(); return; }
        return mutate(ownGeneration, async () => unwrap(await window.electronAPI.background.configure(chosenGoal.id, chosenGoal.revision, config)), '后台计划已保存，实际进度以运行记录为准');
      } });
  };
  const scheduleAction = (schedule: BackgroundSchedule, action: 'pause' | 'resume' | 'now' | 'stop') => {
    const ownGeneration = generation.current, sourceGoal = goals.find(item => item.id === schedule.goalId);
    const titles = { pause: '暂停后台并请求本轮收尾？', resume: '恢复同一范围的后台计划？', now: '立即开始一轮公开探索？', stop: '停止本轮后台探索？' };
    confirm({ title: titles[action], okText: action === 'pause' ? '暂停并收尾' : action === 'resume' ? '恢复后台' : action === 'stop' ? '请求停止' : '立即运行', cancelText: '取消',
      content: <Flex vertical gap={8}><Typography.Text>{sourceGoal?.title ?? schedule.goalId} · 主题版本 {schedule.goalRevision}</Typography.Text><Typography.Text>{action === 'pause' ? '暂停未来调度并等待属于此计划的本轮操作收尾。已有成果与版本保留。' : action === 'stop' ? '停止当前轮次并等待收尾。后台计划保持有效，下一轮仍按计划执行；要停止后续轮次，请暂停后台。' : `沿用已确认公开范围与预算，UTC 每天最多 ${schedule.dailyRoundLimit} 轮，有效至 ${time(schedule.expiresAt)}。`}</Typography.Text></Flex>,
      onOk: () => {
        if (generation.current !== ownGeneration) return;
        const current = latest.current.schedules.find(item => item.id === schedule.id), currentGoal = latest.current.goals.find(item => item.id === schedule.goalId);
        if (!latest.current.ready || current?.revision !== schedule.revision || (action !== 'pause' && action !== 'stop' && (currentGoal?.revision !== schedule.goalRevision || currentGoal.state !== 'active' || Date.parse(schedule.expiresAt) <= Date.now()))) { message.info('计划或主题已变化，请刷新后重新确认'); void load(); return; }
        if (action === 'stop' && (!schedule.lastRunId || !latest.current.explorations.some(item => item.runId === schedule.lastRunId && activeExploration(item) && item.state !== 'stop_requested'))) { message.info('本轮已在收尾或结束，请刷新查看'); void load(); return; }
        return mutate(ownGeneration, async () => unwrap<unknown>(await (action === 'stop' ? window.electronAPI.autonomy.stopExploration(schedule.lastRunId!) : action === 'now' ? window.electronAPI.background.runNow(schedule.id, schedule.revision) : window.electronAPI.background.setEnabled(schedule.id, schedule.revision, action === 'resume'))), action === 'pause' ? '后台已请求暂停，最终状态以收尾记录为准' : action === 'stop' ? '已请求停止本轮，请查看探索进度' : action === 'now' ? '已提交本轮运行，请查看探索进度' : '后台计划已恢复');
      } });
  };
  const rollback = (skill: LearnedSkill) => {
    const ownGeneration = generation.current;
    confirm({ title: '回退学习版本？', okText: '回退版本', cancelText: '取消', content: `「${skill.title}」当前为第 ${skill.activeOrdinal ?? 1} 版。回退到上一可用版本；没有上一版时停用该学习记录。来源、历史版本和已有自定义 skills 保留。`,
      onOk: () => {
        if (generation.current !== ownGeneration) return;
        const current = latest.current.skills.find(item => item.id === skill.id);
        if (!latest.current.ready || current?.revision !== skill.revision || current.activeVersionId !== skill.activeVersionId) { message.info('学习版本已变化，请刷新后重新确认'); void load(); return; }
        return mutate(ownGeneration, async () => unwrap(await window.electronAPI.background.rollbackSkill(skill.id, skill.revision)), '学习版本已回退，请核对当前生效版本');
      } });
  };
  return <Flex vertical gap={12} data-testid="background-learning">
    <Alert type="info" title="后台公开探索与纯文本学习" description="应用需要保持运行，关闭窗口可留在后台；退出应用或电脑睡眠时不执行。唤醒只处理最新到期轮次，不补跑整个离线期间。自动学习仅保存有来源的纯文本方法，不执行代码。" />
    <Flex justify="space-between"><Typography.Text>{ready ? '后台入口已就绪' : '后台与学习尚未就绪'}</Typography.Text><Button loading={loading} onClick={() => void load()}>刷新后台与学习</Button></Flex>
    {error && <Alert type="error" title={error} />}
    <Flex vertical gap={10} style={cardStyle}>
      <Typography.Text strong>确认一个主题的后台范围</Typography.Text>
      <Select aria-label="后台所属主题" placeholder="选择公开探索主题" disabled={busy || !ready} value={goalId} options={goals.filter(item => item.state === 'active').map(item => ({ value: item.id, label: item.title }))} onChange={value => changeForm(() => setGoalId(value))} />
      <Flex gap={12} wrap><Flex vertical><Typography.Text>间隔（分钟，30–1440）</Typography.Text><InputNumber aria-label="后台间隔" min={30} max={1440} precision={0} disabled={busy || !ready} value={intervalMinutes} onChange={value => changeForm(() => setIntervalMinutes(value ?? 30))} /></Flex><Flex vertical><Typography.Text>UTC 每天最多轮数（1–3）</Typography.Text><InputNumber aria-label="后台每日轮数" min={1} max={3} precision={0} disabled={busy || !ready} value={dailyRoundLimit} onChange={value => changeForm(() => setDailyRoundLimit(value ?? 1))} /></Flex><Flex vertical><Typography.Text>有效天数（7–30）</Typography.Text><InputNumber aria-label="后台有效天数" min={7} max={30} precision={0} disabled={busy || !ready} value={days} onChange={value => changeForm(() => setDays(value ?? 7))} /></Flex></Flex>
      <Select aria-label="后台模型协议" disabled={busy || !ready} value={protocol} options={Object.entries(protocolNames).map(([value, label]) => ({ value, label }))} onChange={value => changeForm(() => setProtocol(value))} />
      <Checkbox disabled={busy || !ready} checked={learningEnabled} onChange={event => changeForm(() => { setLearningEnabled(event.target.checked); if (!event.target.checked) setAutoPromote(false); })}>从成果提取纯文本 skills 候选</Checkbox>
      <Checkbox disabled={busy || !ready || !learningEnabled} checked={autoPromote} onChange={event => changeForm(() => setAutoPromote(event.target.checked))}>通过格式、来源与范围校验后自动启用新版本</Checkbox>
      {goal && <><Typography.Text>来源：{goal.sourceUrls.join('、')}</Typography.Text><Typography.Text>模型：{destination?.label ?? '尚未配置'} · {destination?.endpointOrigin} · {destination?.model}</Typography.Text><Typography.Text type="secondary">本主题每轮预算及全局累计预算继续生效。纯文本校验不等于内容正确性验证。</Typography.Text></>}
      <Checkbox disabled={busy || !ready || !goal || !destination?.available} checked={confirmed} onChange={event => setConfirmed(event.target.checked)}>我确认公开来源、模型目的地、有限期限与自动学习范围</Checkbox>
      <Button disabled={busy || !ready || !confirmed || !goal || !destination?.available || intervalMinutes < 30 || intervalMinutes > 1440 || dailyRoundLimit < 1 || dailyRoundLimit > 3 || days < 7 || days > 30} onClick={configure}>确认范围并启用后台</Button>
    </Flex>
    {!schedules.length && <Empty description="尚未设置后台计划，当前没有自动探索轮次" />}
    {schedules.map(schedule => {
      const running = explorations.find(item => item.runId === schedule.lastRunId && activeExploration(item));
      const expired = Date.parse(schedule.expiresAt) <= Date.now(), canRun = ready && schedule.state === 'enabled' && !expired && !running && schedule.roundsToday < schedule.dailyRoundLimit;
      return <Flex key={schedule.id} vertical gap={8} style={cardStyle} data-testid={`background-${schedule.id}`}><Flex justify="space-between"><Typography.Text strong>{goals.find(item => item.id === schedule.goalId)?.title ?? schedule.goalId} · 主题版本 {schedule.goalRevision}</Typography.Text><Tag>{expired ? '已过期' : backgroundStates[schedule.state]}</Tag></Flex><Typography.Text>每 {schedule.intervalMinutes} 分钟检查 · UTC 今天已用 {schedule.roundsToday} / {schedule.dailyRoundLimit} 轮 · 有效至 {time(schedule.expiresAt)}</Typography.Text><Typography.Text>下一次检查：{time(schedule.nextDueAt)} · {running ? '本轮仍在执行或收尾' : schedule.lastOutcome ? explorationStates[schedule.lastOutcome] ?? '最近轮次已记录' : '尚未运行'}</Typography.Text><Typography.Text>下一步：{expired ? '重新确认后台范围' : schedule.state === 'paused' ? '恢复后台后等待下一轮' : schedule.state === 'blocked' ? '核对原因并重新配置范围' : running ? '等待本轮收尾，可停止本轮或暂停后台' : schedule.roundsToday >= schedule.dailyRoundLimit ? '等待下个 UTC 日额度' : '等待到期或立即运行一轮'}</Typography.Text>{schedule.reasonCode && <Alert type="warning" title={backgroundReasons[schedule.reasonCode] ?? '本计划需要核对活动记录后继续'} />}<Typography.Text type="secondary">范围规则：{schedule.ruleId} · {schedule.learningEnabled ? schedule.autoPromote ? '学习并自动启用通过校验的版本' : '仅记录学习候选' : '不提取学习候选'}</Typography.Text><Flex gap={8} wrap><Button disabled={busy || !ready || schedule.state === 'paused' || expired} onClick={() => scheduleAction(schedule, 'pause')}>暂停后台</Button><Button disabled={busy || !ready || schedule.state !== 'paused' || expired} onClick={() => scheduleAction(schedule, 'resume')}>恢复后台</Button><Button disabled={busy || !canRun} onClick={() => scheduleAction(schedule, 'now')}>立即运行一轮</Button><Button disabled={busy || !ready || !running || running.state === 'stop_requested'} onClick={() => scheduleAction(schedule, 'stop')}>停止本轮</Button></Flex></Flex>;
    })}
    <Typography.Title level={5}>学习成果与版本</Typography.Title>
    <Typography.Text type="secondary">通过校验的方法仅在对应公开主题的后续探索中使用。原有自定义 skills 保留；已有运行保持其启动时的版本快照。</Typography.Text>
    {!skills.length && <Empty description="暂无学习候选或生效版本。需本轮成果包含有来源的可复用方法；不会为了填满列表生成技能。" />}
    {skills.map(skill => <Flex key={skill.id} vertical gap={8} style={cardStyle}><Flex justify="space-between"><Typography.Text strong>{skill.title}</Typography.Text><Tag>{skill.latestStatus === 'active' ? '纯文本与来源校验通过' : skill.latestStatus === 'candidate' ? '候选，尚未启用' : skill.latestStatus === 'quarantined' ? '已隔离，尚未启用' : '已停用'}</Tag></Flex><Typography.Text>主题：{goals.find(item => item.id === skill.goalId)?.title ?? skill.goalId} · 当前生效版本：{skill.activeOrdinal ? `第 ${skill.activeOrdinal} 版` : '无'} · 历史 {skill.versionCount} 版 · 候选 {skill.candidateCount} 个</Typography.Text>{skill.summary && <Typography.Paragraph>{skill.summary}</Typography.Paragraph>}<Typography.Text type="secondary">来源：{skill.sourceRefs?.join('、') || '请通过对应主题成果核对'}{skill.sourceRunId ? ` · 运行 ${skill.sourceRunId}` : ''}{skill.sourceArtifactId ? ` · 成果 ${skill.sourceArtifactId}` : ''}</Typography.Text><Typography.Text type="secondary">更新于 {time(skill.updatedAt)}。格式和来源校验不验证建议的正确性；保留出处供你复核。</Typography.Text><Button disabled={busy || !ready || !skill.activeVersionId} onClick={() => rollback(skill)}>回退学习版本</Button></Flex>)}
  </Flex>;
}
