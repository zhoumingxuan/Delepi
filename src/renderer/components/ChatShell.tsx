/**
 * ChatShell 主聊天容器（编排层）
 * 组合 ChatHeader + ChatArea + SenderBox + Sidebar + ConfigDrawer
 *
 * 适配 Delepi 后端实现（替换 Next.js + SSE → Delepi Electron IPC）：
 * - 数据获取：fetchWithAuth('/api/...') + useRouter → window.electronAPI.* IPC 调用
 * - 事件流：parseSseJsonStream → useChat hook 内置 IPC 事件订阅
 * - 状态管理：自维护 messages/toolSnapshots/conversations → useChat 统一管理
 * - 文件上传：内置 /api/uploads → useFileUpload 本地预览
 * - 用户认证：fetchWithAuth + MissingStoredAuthError + router → Delepi 单窗口无需登录态路由
 *
 * 样式对齐：
 * - 侧边栏 280px 固定宽度（borderRight: 1px solid）
 * - 内容区 flex:1, minWidth:0, minHeight:0, overflow:hidden
 * - 三色头像：AI #2563eb（蓝）/ User #16a34a（绿）/ Tool 无头像
 *
 * 业务逻辑保留（不准动）：
 * - useChat 内部 sendMessage / abortChat 五重守卫
 * - useChat 内部 11 个 IPC 事件订阅
 * - useSettings / useFileUpload hooks 接口签名
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, App as AntApp, Flex, theme } from 'antd';
import { ChatArea } from './ChatArea';
import { ChatHeader } from './ChatHeader';
import { ConfigDrawer } from './ConfigDrawer';
import { Sidebar } from './Sidebar';
import { SenderBox } from './SenderBox';
import { useChat } from '../hooks/useChat';
import {
  useExecutorTaskRecords,
  EXECUTOR_RECORD_PANEL_ENABLED,
} from '../hooks/useExecutorTaskRecords';
import { ExecutorRecordDrawer } from './ExecutorRecordDrawer';
import { useFileUpload } from '../hooks/useFileUpload';
import { useSettings } from '../hooks/useSettings';
import type { SidebarConversation } from './Sidebar';
import type { ConfigMissingItem } from '@shared/types/config';
import { ConfigCheckModal } from './ConfigCheckModal';
import { useConfigReadiness } from '../hooks/useConfigReadiness';

export function ChatShell() {
  const screens = useMemo(() => ({ lg: true }), []); // 适配原 ai_fr Grid.useBreakpoint 简化为桌面端
  const { token } = theme.useToken();
  const { message: messageApi } = AntApp.useApp();

  const {
    messages,
    /** ★ 对齐 ai_fr：消息加载过渡态（Spin 过渡显示） */
    messageLoading,
    conversationId,
    conversations,
    isStreaming,
    sendMessage,
    abortChat,
    createConversation,
    deleteConversation,
    switchConversation,
    /** Phase 3 P1 + P3：守卫 + 状态相关 */
    isConversationSending,
    isConversationRunning,
    /** ★ D3 修复：当前会话 error 状态（sendMessage catch 活跃会话命中时写入），错误条消费 */
    error,
    clearError,
    /** Phase 3 P3-3 滚动状态相关 */
    showScrollToBottom,
    setShowScrollToBottom,
    stickToBottomRef,
    /** ★ BUG3 修复：取消待收口标记查询 / 可重发通知订阅 */
    isConversationCancelPendingSettle,
    onCancelPendingSettleReissue,
  } = useChat({ messageApi: { error: (content: string) => messageApi.error(content) } });

  // ★ 新版方案 §7.7：executor 任务记录显示侧数据 hook（订阅 executor:record-signal + 增量拉取；
  //   挂载点与任务卡徽标分支统一受 EXECUTOR_RECORD_PANEL_ENABLED 纯显示开关控制）
  const executorRecords = useExecutorTaskRecords({ conversationId });

  const { config, loading: configLoading, saveConfig, saveAllConfig, reloadConfig } =
    useSettings();
  // ============================================================
  // ★ 上传链路直通重构（粘贴即落盘）：无会话粘贴前置建会话 + 批次级用户反馈注入
  // ============================================================
  // 无会话粘贴 → 前置创建会话（复用 useChat.createConversation：在途去重/R2 基准判定均沿用）
  const ensureConversationForUpload = useCallback(async (): Promise<string | null> => {
    const conv = await createConversation();
    return conv?.id ?? null;
  }, [createConversation]);
  // 粘贴批次级用户反馈（预筛跳过 / 会话创建失败 / 批次聚合失败 toast，接 messageApi）
  const notifyUpload = useCallback(
    (level: 'warning' | 'error', text: string) => {
      if (level === 'error') messageApi.error(text);
      else messageApi.warning(text);
    },
    [messageApi],
  );
  const {
    pendingFiles,
    addPendingFiles,
    removePendingFile,
    clearLocalOnly,
    savingCount: fileSavingCount,
    setConversationId: setUploadConversationId,
  } = useFileUpload({ ensureConversation: ensureConversationForUpload, notify: notifyUpload });

  // 无会话 id（conversationId === null）发送流程的哨兵键：null 在途期间发送流程会异步创建会话，
  // 期间二次点击可能重复建会话/重复发送，故该键在途时保持与原全局锁一致的全局拦截语义
  const NO_CONVERSATION_FLIGHT_KEY = '__no_conversation_in_flight__';
  const sendInFlightConversationIdsRef = useRef<Set<string>>(new Set()); // 防重入（按会话隔离）：记录在途发送的会话 id，拦截同会话重复触发
  // ★ BUG3 修复（取消后窗口内发送排队重发）：取消窗口内暂存的待发文本（按会话 ID 键控）。
  //   flightKey 命中且该会话存在"取消待收口"标记时暂存原文本；flightKey 释放（前序
  //   chat:send promise settle）后自动以原内容重走完整 handleSend 流程（仍过全部现有
  //   发送守卫）。附件不入暂存：重发时按 pendingFiles 现状走既有上传/附件流程，与正常
  //   发送同源。取走即删保证至多重发一次。
  const queuedResendTextsRef = useRef<Map<string, string>>(new Map());
  // ★ BUG3 修复：handleSend 最新引用（排队重发经此调用，规避 useCallback 自引用依赖；
  //   渲染期同步赋值，模式对齐 messageApiRef/conversationsRef）
  const handleSendRef = useRef<((senderTextOrQueued?: string | { text: string; conversationId: string | null }) => Promise<void>) | null>(null);

  const [inputValue, setInputValue] = useState('');
  // ★ R1 草稿会话级隔离：按会话 ID 缓存未发送草稿（键 null = 无会话列表态）
  const draftsRef = useRef<Map<string | null, string>>(new Map());
  // 草稿保存/恢复的切换边界判定基准（上一会话 ID）
  const prevDraftConversationIdRef = useRef<string | null>(conversationId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [hoveredConversationId, setHoveredConversationId] = useState<string | null>(null);

const [configDrawerActiveTab, setConfigDrawerActiveTab] = useState<'model' | 'python'>('model');
const [showConfigCheckModal, setShowConfigCheckModal] = useState(false);
const [configCheckMissingItems, setConfigCheckMissingItems] = useState<ConfigMissingItem[]>([]);


const { check, canCheck } = useConfigReadiness({
  config,
  configLoading,
});

  const messageListRef = useRef<HTMLDivElement | null>(null);

  // 适配 Sidebar 组件的 conversations 数据结构
  const sidebarConversations: SidebarConversation[] = useMemo(
    () =>
      conversations.map((conv) => ({
        id: conv.id,
        title: conv.title,
        isRunning: conv.isRunning,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
      })),
    [conversations],
  );

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === conversationId) ?? null,
    [conversations, conversationId],
  );

  // ============================================================
  // ★ R1 草稿会话级隔离：conversationId 变化 = 会话切换边界 ——
  //   离开会话：保存当前输入草稿到 draftsRef[离开会话ID]（空草稿不落 Map）
  //   进入会话：恢复 draftsRef[进入会话ID]（无草稿 → 空串）
  //   useLayoutEffect（paint 前换装）：避免旧会话草稿闪现一帧
  //   幂等：prevId === conversationId 直接返回（StrictMode 双执行 / 依赖重跑安全）
  // ============================================================
  useLayoutEffect(() => {
    const prevId = prevDraftConversationIdRef.current;
    if (prevId === conversationId) return;
    // 会话已删除（含删除活跃会话触发的 →null 切换）不保存其草稿，防已删会话草稿残留
    const prevStillExists = prevId === null || conversations.some((c) => c.id === prevId);
    if (prevStillExists) {
      if (inputValue.trim().length > 0) {
        draftsRef.current.set(prevId, inputValue);
      } else {
        draftsRef.current.delete(prevId); // 空草稿不落 Map：Map 体量上界=有草稿的会话数
      }
    }
    setInputValue(draftsRef.current.get(conversationId) ?? '');
    prevDraftConversationIdRef.current = conversationId;
  }, [conversationId, inputValue, conversations]);

  // ============================================================
  // P5 适配：useFileUpload 需要知道当前会话 ID 才能调用 file:upload
  // conversationId 变化（包括新建会话、切换会话）时同步给 useFileUpload；
  // 切会话清理由 hook 内 setConversationId 规则承担（A→B/A→null 清空本地列表，
  // 磁盘文件保留；已随消息发送的文件不再拉回输入框）
  // ============================================================
  useEffect(() => {
    setUploadConversationId(conversationId);
  }, [conversationId, setUploadConversationId]);

  // ============================================================
  // P5 适配：落盘窗口中的文件数取自 useFileUpload.savingCount
  // 避免出现「useChat 的 uploadingCount 始终为 0 + useFileUpload 直通落盘中」的不一致
  // ============================================================
  const uploading = fileSavingCount > 0;

  // ============================================================
  // Phase 3 P3-3 滚动状态
  // - stickToBottomRef：粘底滚动开关（useChat 拥有 + 切换会话时重置）
  // - showScrollToBottom：向下滚动按钮可见性
  // ============================================================

  // ============================================================
  // Phase 3 P3-1 守卫判定（沿用 useChat 内部实现，组件层仅做 UI 反馈）
  // ============================================================
  const activeConversationRunning = isConversationRunning(conversationId);
  const activeConversationSending = isConversationSending(conversationId);
  // ★ P5 适配：uploading 已通过 useEffect 块从 useFileUpload.fileSavingCount 计算
  const showCancel = activeConversationSending || activeConversationRunning;
  // ============================================================
  // Phase 5 BUG-1：配置完成性校验
  // 检查 mainModelApiKey 和 mainModelName 是否已填写
  // 对齐 ai_fr chat-shell.tsx L692-695 currentAgentConfigured 机制
  // ============================================================
  const configConfigured = useMemo(() => {
    if (configLoading) return true; // 加载中不拦截
    return (
      (config.mainModelApiKey?.trim() ?? '').length > 0 &&
      (config.mainModelName?.trim() ?? '').length > 0
    );
  }, [config.mainModelApiKey, config.mainModelName, configLoading]);

  // ============================================================
  // ★ P0-B 渲染范围收敛：6 个低频内联回调 useCallback 化（引用稳定，
  //   流式期间 ChatHeader/Sidebar/SenderBox/ConfigDrawer/ConfigCheckModal
  //   的 memo 不再被内联新引用击穿；依赖见各行，行为与原内联闭包一致）
  // ============================================================
  const handleMenuClick = useCallback(() => setSidebarOpen((v) => !v), []);
  const handleSettingsClick = useCallback(() => setSettingsOpen(true), []);
  // ConfigDrawer onClose；依赖 configConfigured——流式期间该值稳定，引用稳定
  const handleCloseConfigDrawer = useCallback(() => {
    if (!configConfigured) return;
    setSettingsOpen(false);
  }, [configConfigured]);
  const handleConfigDrawerTabChange = useCallback(
    (tab: string) => setConfigDrawerActiveTab(tab as 'model' | 'python'),
    [],
  );
  const handleCloseConfigCheckModal = useCallback(() => setShowConfigCheckModal(false), []);
  const handleGoToConfig = useCallback((tab: string) => {
    setConfigDrawerActiveTab(tab as 'model' | 'python');
    setSettingsOpen(true);
  }, []);

  const canSend =
    !showCancel &&
    !uploading &&
    configConfigured &&
    (inputValue.trim().length > 0 ||
      pendingFiles.length > 0);

  // ============================================================
  // 交互事件（不准动 Delepi 原有 sendMessage / abortChat 逻辑）
  // - handleSend：转发到 useChat.sendMessage
  // - handleAbort：转发到 useChat.abortChat
  // ============================================================
  // ============================================================
  // P5 适配：仅发送已落盘就绪的文件（uploadStatus === 'ready'）
  // - 落盘窗口内的文件（saving）由场景c 拦截发送；error 项不随消息发送（场景d 提示）
  // - sendMessage 第二参数为 SendAttachment[]（来自 file:upload 已落盘元数据，粘贴时已产生）
  // ============================================================
  const handleSend = useCallback(async (senderTextOrQueued?: string | { text: string; conversationId: string | null }) => {
    // ★ BUG3 修复：queued 非空=取消窗口内排队重发（text/conversationId 均为暂存时的原快照）；
    //   SenderBox 常规调用只传 string（该实参本就不参与发送内容组装），沿用 inputValue，
    //   全部行为不变
    const queued = typeof senderTextOrQueued === 'object' ? senderTextOrQueued : undefined;
    // ── ★ M3（一个对话一个 is_running 标志位）：在任何 await 之前捕获目标会话 ID。
    //    本函数内一切守卫/停止/上传/发送一律以该捕获值为唯一身份依据，消除
    //    conversationIdRef.current 在 await 期间被切会话改写导致的身份漂移：
    //    B 的消息只发往 B、停止动作只作用于用户按下那一刻所在的目标会话 ──
    const targetConversationId = queued ? queued.conversationId : conversationId;
    // ★ BUG3 修复：发送文本统一取 sendText（正常= inputValue；queued 重发=原文本快照）
    const sendText = queued ? queued.text : inputValue;

    // ── 配置就绪守卫：未就绪则弹出 ConfigCheckModal 阻断发送 ──
    if (canCheck) {
      const result = check();
      if (!result.isReady) {
        setConfigCheckMissingItems(result.missingItems);
        setShowConfigCheckModal(true);
        return;
      }
    }

    // ★ BUG3 修复：queued 重发是程序触发的发送动作，不是"点发送=停止"的用户手势；
    //   且重发仅在前序 chat:send promise settle（目标会话运行态已复位）后发生
    if (!queued && showCancel) {
      // ★ M3：停止动作绑定捕获的目标会话 ID——即便此间会话被切换，
      //   也只中止用户按下发送/停止那一刻的目标会话，不误伤其他运行中会话
      abortChat(targetConversationId);
      return;
    }
    // ── 场景c：文件上传中 → 明确提示（原为 canSend=false 静默 return）──
    if (fileSavingCount > 0 || pendingFiles.some((f) => f.uploadStatus === 'saving')) {
      messageApi.warning('文件上传中，请稍候再发送');
      return;
    }
    // ★ BUG3 修复：queued 重发不做 canSend 渲染闭包判定——canSend 基于当前会话/当前
    //   输入框计算，与重发目标（暂存快照）无关；其内容非空性由暂存前提保证（暂存仅发生
    //   在 canSend=true 的发送尝试上），showCancel/上传中/配置守卫已在上方对 queued
    //   逐项生效，重发仍通过全部现有发送守卫
    if (!queued && !canSend) return;
    // 防重入（按会话隔离，双击/回车连击）：同会话在途则拦截；无会话 id（null→创建会话流程）在途时保持原全局拦截语义
    // ★ M3：flightKey 直接复用进入时捕获的 targetConversationId（与守卫/发送同源，杜绝二次读取状态漂移）
    const flightConversationId = targetConversationId; // 捕获进入 handleSend 时的会话 id：finally 释放必须用此捕获值，防会话切换后误删他话
    const flightKey = flightConversationId ?? NO_CONVERSATION_FLIGHT_KEY;
    if (sendInFlightConversationIdsRef.current.has(flightKey)) {
      // ★ BUG3 修复：命中防重入时按"取消待收口"标记区分——
      //   a) 标记存在（用户已取消、前序 chat:send promise 尚未 settle，flightKey 未释放
      //      窗口）：暂存本次待发原文本，flightKey 释放后自动重发（不静默丢弃）；
      //   b) 无标记（普通连击）：保持原静默防重入行为完全不变。
      //   无会话 id（null→创建会话流程）不参与排队（标记仅按具体会话 ID 键控）。
      if (
        flightConversationId !== null &&
        isConversationCancelPendingSettle(flightConversationId)
      ) {
        queuedResendTextsRef.current.set(flightConversationId, sendText);
      }
      return;
    }
    sendInFlightConversationIdsRef.current.add(flightKey);
    try {
      // ★ R3：目标会话解析结果提升到 try 顶部（粘贴即落盘后不再有发送时建会话/补传分支）
      const resolvedConversationId = targetConversationId;
      const readyItems = pendingFiles.filter((i) => i.uploadStatus === 'ready' && i.uploadedFile);
      const errorItems = pendingFiles.filter((i) => i.uploadStatus === 'error');
      // ── 场景d：上传失败文件 → 明确提示，不随消息发送（对齐 ai_fr 失败提示策略）──
      if (errorItems.length > 0) {
        messageApi.warning(`${errorItems.length} 个文件上传失败，将不随消息发送`);
      }
      const attachments = readyItems.map((item) => ({
        id: item.uploadedFile!.id,
        name: item.uploadedFile!.name,
        size: item.uploadedFile!.size,
        contentType: item.uploadedFile!.contentType,
        storageKey: item.uploadedFile!.storageKey,
      }));
      // 发送即清空输入框附件（clearLocalOnly 仅清本地 state，不触发 file:delete，保留磁盘文件）——原 L232-233 语义原样保留
      clearLocalOnly();
      setInputValue(''); // ★修复：对齐 ai_fr chat-shell.tsx L2171-2173——消息受理即清空输入框。闭包 inputValue 已捕获原文本，下行 sendMessage 发送内容不受影响
      // ★ M1+M3/R3：第三参显式传入已解析的目标会话 ID（进入时捕获值；粘贴即落盘后发送流程不再建会话/补传）——
      //   sendMessage 内部五重守卫与 IPC 投递均按该 ID 判定/路由，不再依赖 await 后的 conversationIdRef.current
      // ★ BUG3 修复：发送文本统一取 sendText（queued 重发=原文本快照，正常= inputValue 不变）
      const sent = await sendMessage(sendText, attachments, resolvedConversationId);
      if (!sent && !queued) {
        // ★ 受理失败（守卫拦截 / 创建在途去重 / 投递失败）：恢复草稿，杜绝文本静默丢失
        //   （替代原 creatingConversation 在途拦截对输入文本的隐式保护副作用）
        setInputValue(sendText);
      }
    } finally {
      sendInFlightConversationIdsRef.current.delete(flightKey); // 释放进入时捕获的键：禁用 finally 时刻的 conversationId 状态变量（会话切换后已变值会误删他话）
      // ★ BUG3 修复：flightKey 已释放（=前序 chat:send promise settle 之后；渲染层 abort
      //   归一化（chat:aborted 处理器）与 conversation:updated 合并由主进程在 chat:abort
      //   内先于 settle 推送、渲染层按序先行完成），此时若该会话存在取消窗口暂存的待发
      //   内容，取走即删并自动以原内容重走完整 handleSend 流程（重发仍须通过全部现有
      //   发送守卫；取走即删保证至多重发一次）
      if (flightConversationId !== null) {
        const queuedResendText = queuedResendTextsRef.current.get(flightConversationId);
        if (queuedResendText !== undefined) {
          queuedResendTextsRef.current.delete(flightConversationId);
          void handleSendRef.current?.({ text: queuedResendText, conversationId: flightConversationId });
        }
      }
    }
  }, [
    showCancel,
    canSend,
    abortChat,
    sendMessage,
    inputValue,
    pendingFiles,
    clearLocalOnly,
    check,
    canCheck,
    conversationId,
    isConversationCancelPendingSettle,
    fileSavingCount,
    messageApi,
  ]);

  const handleAbort = useCallback(() => {
    // ★ M3：停止按钮只中止当前活跃会话——显式传入渲染闭包的 conversationId，
    //   与按钮渲染态（showCancel 按当前会话计算）保持同一身份
    abortChat(conversationId);
  }, [abortChat, conversationId]);

  // ★ BUG3 修复：渲染期同步 handleSend 最新引用（排队重发经此调用，规避 useCallback
  //   自引用依赖；模式对齐 messageApiRef/conversationsRef）
  handleSendRef.current = handleSend;

  // ★ BUG3 修复：订阅取消待收口"可重发"通知。正常时序下重发已由 handleSend 的 finally
  //   主触发完成（暂存取走即删，此处空转）；若异常时序下通知到达时该会话 flightKey 已
  //   释放且暂存仍在，则在此兜底触发（幂等，保证至多重发一次）
  useEffect(() => {
    return onCancelPendingSettleReissue((reissueConversationId: string) => {
      if (sendInFlightConversationIdsRef.current.has(reissueConversationId)) return;
      const queuedText = queuedResendTextsRef.current.get(reissueConversationId);
      if (queuedText === undefined) return;
      queuedResendTextsRef.current.delete(reissueConversationId);
      void handleSendRef.current?.({ text: queuedText, conversationId: reissueConversationId });
    });
  }, [onCancelPendingSettleReissue]);

  const handleNewChat = useCallback(async () => {
    await createConversation();
  }, [createConversation]);

  // ★ M4：发送被拦截时的用户反馈回调（SenderBox 内 300ms 节流后调用）——
  //   替代原“静默吞回车/吞点击”：目标会话锁定时用户可感知为何发不出去
  const handleSendBlocked = useCallback(
    (reason: 'locked' | 'empty') => {
      if (reason === 'locked') {
        messageApi.warning('当前会话正在回复中，请先停止或等待完成后再发送');
      }
    },
    [messageApi],
  );

  const handleSwitchConversation = useCallback(
    (id: string) => {
      switchConversation(id);
    },
    [switchConversation],
  );

  const handleRemoveConversation = useCallback(
    (id: string) => {
      draftsRef.current.delete(id); // ★ R1：删除会话同步清理其草稿（非活跃删除无切换边界，须显式清理）
      void deleteConversation(id);
    },
    [deleteConversation],
  );

  const handleHoverConversation = useCallback((id: string | null) => {
    setHoveredConversationId(id);
  }, []);

  // 标题副标题（对齐 ai_fr headerTitle/headerSubtitle）
  const headerTitle = activeConversation?.title ?? 'Delepi';
  const headerSubtitle = configLoading
    ? ''
    : activeConversationRunning || isStreaming
      ? '正在回复'
      : '';

  // ============================================================
  // Phase 5 要求6：初始化配置面板弹出
  // configLoading 完成后，若未配置则自动打开设置面板
  // 对齐 ai_fr chat-shell.tsx L2636-2645：配置未完成显示 Alert + sendMessage 阻止
  // ============================================================
  useEffect(() => {
    if (!configLoading && !configConfigured) {
      setSettingsOpen(true);
    }
  }, [configLoading, configConfigured]);

  return (
    <div
      style={{
        height: '100dvh',
        display: 'flex',
        overflow: 'hidden',
        background: token.colorBgLayout,
      }}
    >
      {screens.lg && sidebarOpen ? (
        <div
          style={{
            width: 280,
            height: '100dvh',
            minHeight: 0,
            display: 'flex',
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgLayout,
            flexShrink: 0,
          }}
        >
          <Sidebar
            conversations={sidebarConversations}
            activeConversationId={conversationId}
            hoveredConversationId={hoveredConversationId}
            onNewChat={handleNewChat}
            onSwitchConversation={handleSwitchConversation}
            onRemoveConversation={handleRemoveConversation}
            onHoverConversation={handleHoverConversation}
          />
        </div>
      ) : null}

      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          height: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: token.colorBgContainer,
        }}
      >
        <ChatHeader
          title={headerTitle}
          subtitle={headerSubtitle || undefined}
          isRunning={activeConversationRunning}
          showMenuButton={!sidebarOpen}
          onMenuClick={handleMenuClick}
          onSettingsClick={handleSettingsClick}
        />

        {/* ★ D3 修复：error state 可见出口（当前会话错误条）
            仅当存在错误且处于具体会话（error 生命周期：仅 sendMessage catch 活跃会话写入，
            切换/新建会话时 setError(null) 清空）时显示；chat:error 事件路径经 messageApi
            toast 单点提示（useChat 已抑制其 setError），不与本错误条重复双弹 */}
        {error && conversationId ? (
          <Alert
            type="error"
            showIcon
            closable
            message={error}
            onClose={clearError}
            style={{ margin: '4px 32px 0', flexShrink: 0 }}
          />
        ) : null}

        <Flex
          vertical
          style={{
            flex: 1,
            minHeight: 0,
            background: token.colorBgContainer,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <ChatArea
            messages={messages}
            /**
             * ★ 新版方案 §7.7：数据源切换为 executor 任务记录虚拟消息（旧 toolSnapshots 停传）；
             * 受 EXECUTOR_RECORD_PANEL_ENABLED 控制——置 false 即整体停用新显示侧（回滚开关）
             */
            executorTaskMessages={
              EXECUTOR_RECORD_PANEL_ENABLED ? executorRecords.executorTaskMessages : undefined
            }
            executorPanel={{
              onOpenPanel: executorRecords.openTask,
              activeDelegateCallId: executorRecords.activeDelegateCallId,
            }}
            conversationId={conversationId}
            messageListRef={messageListRef}
            stickToBottomRef={stickToBottomRef}
            showScrollToBottom={showScrollToBottom}
            onShowScrollToBottomChange={setShowScrollToBottom}
            isStreaming={isStreaming}
            /** ★ 对齐 ai_fr：消息加载过渡态（Spin 占位） */
            messageLoading={messageLoading}
          />
          <SenderBox
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSend}
            onCancel={handleAbort}
            loading={isStreaming}
            showCancel={showCancel}
            /** ★ M4：提交被拦截反馈（组件内 300ms 节流后回调） */
            onBlocked={handleSendBlocked}
            canSend={canSend}
            pendingFiles={pendingFiles}
            onAddFiles={addPendingFiles}
            onRemoveFile={removePendingFile}
          />
        </Flex>
      </div>

      <ConfigDrawer
        open={settingsOpen}
        onClose={handleCloseConfigDrawer}
        config={config}
        configLoading={configLoading}
        onSave={saveConfig}
        onSaveAll={saveAllConfig}
        onReload={reloadConfig}
        activeTab={configDrawerActiveTab}
        onTabChange={handleConfigDrawerTabChange}
      />

      <ConfigCheckModal
        open={showConfigCheckModal}
        missingItems={configCheckMissingItems}
        onClose={handleCloseConfigCheckModal}
        onGoToConfig={handleGoToConfig}
      />

      {/* ★ 新版方案 §7.7：任务执行记录 dock 右栏（固定布局列，非 Drawer/Modal；
          单点显示开关 EXECUTOR_RECORD_PANEL_ENABLED 控制，默认 true） */}
      {EXECUTOR_RECORD_PANEL_ENABLED && executorRecords.activeTaskView ? (
        <ExecutorRecordDrawer
          taskView={executorRecords.activeTaskView}
          onClose={executorRecords.closePanel}
        />
      ) : null}

    </div>
  );
}
