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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Flex, theme } from 'antd';
import { ChatArea } from './ChatArea';
import { ChatHeader } from './ChatHeader';
import { ConfigDrawer } from './ConfigDrawer';
import { Sidebar } from './Sidebar';
import { SenderBox } from './SenderBox';
import { useChat } from '../hooks/useChat';
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
    /** Phase 3 P0-3：子智能体执行中间快照（按 taskId 索引） */
    toolSnapshots,
    /** Phase 3 P1 + P3：守卫 + 状态相关 */
    isConversationSending,
    isConversationRunning,
    /** ★ M2/T1：新建会话在途标记（创建窗口内目标会话身份未定，发送/停止动作需锁定） */
    creatingConversation,
    /** Phase 3 P3-3 滚动状态相关 */
    showScrollToBottom,
    setShowScrollToBottom,
    stickToBottomRef,
  } = useChat({ messageApi: { error: (content: string) => messageApi.error(content) } });

  const { config, loading: configLoading, saveConfig, saveAllConfig, reloadConfig } =
    useSettings();
  const {
    pendingFiles,
    addPendingFiles,
    removePendingFile,
    clearLocalOnly,
    uploadingCount: fileUploadingCount,
    setConversationId: setUploadConversationId,
    setPendingUploadStatus,        // ★新增：发送流程预标记/回滚 pendingFiles 上传状态
    uploadFilesForSend,            // ★新增：发送流程显式指定会话上传并等待完成
  } = useFileUpload();

  // 无会话 id（conversationId === null）发送流程的哨兵键：null 在途期间发送流程会异步创建会话，
  // 期间二次点击可能重复建会话/重复发送，故该键在途时保持与原全局锁一致的全局拦截语义
  const NO_CONVERSATION_FLIGHT_KEY = '__no_conversation_in_flight__';
  const sendInFlightConversationIdsRef = useRef<Set<string>>(new Set()); // 防重入（按会话隔离）：记录在途发送的会话 id，拦截同会话重复触发
  const latestConversationIdRef = useRef<string | null>(conversationId);  // 上传等待期间检测会话是否被切换

  const [inputValue, setInputValue] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [hoveredConversationId, setHoveredConversationId] = useState<string | null>(null);

const [configDrawerActiveTab, setConfigDrawerActiveTab] = useState<'model' | 'python'>('model');
const [showConfigCheckModal, setShowConfigCheckModal] = useState(false);
const [configCheckMissingItems, setConfigCheckMissingItems] = useState<ConfigMissingItem[]>([]);

// ★ 方案A：同步最新会话 ID 到 ref（上传等待期间检测会话是否被切换，见 handleSend）
useEffect(() => {
  latestConversationIdRef.current = conversationId;
}, [conversationId]);

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
  // P5 适配：useFileUpload 需要知道当前会话 ID 才能调用 file:upload
  // conversationId 变化（包括新建会话、切换会话）时同步给 useFileUpload
  // 切会话时清空旧会话的本地预览（clearLocalOnly 仅清本地 state，不触发 file:delete，
  // 磁盘文件保留；已随消息发送的文件不再拉回输入框）
  // ============================================================
  useEffect(() => {
    setUploadConversationId(conversationId);
    // 切会话时:清空旧会话的本地预览(保留磁盘文件)
    clearLocalOnly();
  }, [conversationId, setUploadConversationId, clearLocalOnly]);

  // ============================================================
  // P5 适配：上传中文件数取自 useFileUpload（覆盖 useChat 的 uploadingCount）
  // 避免出现「useChat 的 uploadingCount 始终为 0 + useFileUpload 异步上传中」的不一致
  // ============================================================
  const uploading = fileUploadingCount > 0;

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
  // ★ P5 适配：uploading 已通过 useEffect 块从 useFileUpload.fileUploadingCount 计算
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
  // P5 适配：仅发送已上传完成的文件（uploadStatus === 'uploaded'）
  // - 未上传完成的文件（pending/uploading/error）不参与本次发送
  // - sendMessage 第二参数改为 SendAttachment[]（来自 file:upload 已落盘的元数据）
  // ============================================================
  const handleSend = useCallback(async () => {
    // ── ★ M3（一个对话一个 is_running 标志位）：在任何 await 之前捕获目标会话 ID。
    //    本函数内一切守卫/停止/上传/发送一律以该捕获值为唯一身份依据，消除
    //    conversationIdRef.current 在 await 期间被切会话改写导致的身份漂移：
    //    B 的消息只发往 B、停止动作只作用于用户按下那一刻所在的目标会话 ──
    const targetConversationId = conversationId;

    // ── ★ M2：新建会话在途（conv:create 未返回）期间目标身份未定 → 拒绝发送 ──
    if (creatingConversation) return;

    // ── 配置就绪守卫：未就绪则弹出 ConfigCheckModal 阻断发送 ──
    if (canCheck) {
      const result = check();
      if (!result.isReady) {
        setConfigCheckMissingItems(result.missingItems);
        setShowConfigCheckModal(true);
        return;
      }
    }

    if (showCancel) {
      // ★ M3：停止动作绑定捕获的目标会话 ID——即便此间会话被切换，
      //   也只中止用户按下发送/停止那一刻的目标会话，不误伤其他运行中会话
      abortChat(targetConversationId);
      return;
    }
    // ── 场景c：文件上传中 → 明确提示（原为 canSend=false 静默 return）──
    if (fileUploadingCount > 0 || pendingFiles.some((f) => f.uploadStatus === 'uploading')) {
      messageApi.warning('文件上传中，请稍候再发送');
      return;
    }
    if (!canSend) return;
    // 防重入（按会话隔离，双击/回车连击）：同会话在途则拦截；无会话 id（null→创建会话流程）在途时保持原全局拦截语义
    // ★ M3：flightKey 直接复用进入时捕获的 targetConversationId（与守卫/发送同源，杜绝二次读取状态漂移）
    const flightConversationId = targetConversationId; // 捕获进入 handleSend 时的会话 id：finally 释放必须用此捕获值，防会话切换后误删他话
    const flightKey = flightConversationId ?? NO_CONVERSATION_FLIGHT_KEY;
    if (
      sendInFlightConversationIdsRef.current.has(NO_CONVERSATION_FLIGHT_KEY) ||
      sendInFlightConversationIdsRef.current.has(flightKey)
    ) return;
    sendInFlightConversationIdsRef.current.add(flightKey);
    try {
      const uploadedItems = pendingFiles.filter((i) => i.uploadStatus === 'uploaded' && i.uploadedFile);
      const errorItems = pendingFiles.filter((i) => i.uploadStatus === 'error');
      const pendingItems = pendingFiles.filter((i) => i.uploadStatus === 'pending');
      // ── 场景d：上传失败文件 → 明确提示，不随消息发送（对齐 ai_fr 失败提示策略）──
      if (errorItems.length > 0) {
        messageApi.warning(`${errorItems.length} 个文件上传失败，将不随消息发送`);
      }
      let attachments = uploadedItems.map((item) => ({
        id: item.uploadedFile!.id,
        name: item.uploadedFile!.name,
        size: item.uploadedFile!.size,
        contentType: item.uploadedFile!.contentType,
        storageKey: item.uploadedFile!.storageKey,
      }));
      if (pendingItems.length > 0) {
        // ── 场景a核心：发送时序前置串行化（创建会话 → 上传落盘 → 发送）──
        let convId = targetConversationId; // ★ M3：上传等待期间不重读会话状态，使用进入时捕获值
        if (!convId) {
          const conv = await createConversation(); // 复用 useChat 既有函数（L837-868，非新增创建策略）
          if (!conv) {
            setPendingUploadStatus(pendingItems.map((i) => i.localKey), 'pending'); // 回滚可重试状态
            messageApi.error('创建会话失败，文件未发送');
            return;
          }
          convId = conv.id;
        }
        // 先标记 uploading：conversationId 变化 effect 内 setUploadConversationId 的
        // pending 重试（useFileUpload L496-510）只筛 'pending'，标记后不会重复上传
        const pendingKeys = pendingItems.map((i) => i.localKey);
        setPendingUploadStatus(pendingKeys, 'uploading');
        const result = await uploadFilesForSend(
          convId,
          pendingItems.map((i) => ({
            localKey: i.localKey,
            file: i.file,
            contentType: i.contentType || i.file.type,
            fileName: i.file.name,
          })),
        );
        // 上传等待期间用户切换了会话 → 中止本次发送（避免文件落在 A 会话、消息发到 B 会话）
        if (latestConversationIdRef.current !== convId) {
          messageApi.warning('会话已切换，本次发送已取消');
          return;
        }
        attachments = [
          ...attachments,
          ...result.uploaded.map((u) => ({
            id: u.id,
            name: u.name,
            size: u.size,
            contentType: u.contentType,
            storageKey: u.storageKey,
          })),
        ];
        if (result.failed.length > 0) {
          messageApi.warning(`${result.failed.length} 个文件上传失败，将不随消息发送`);
        }
      }
      // 发送即清空输入框附件（clearLocalOnly 仅清本地 state，不触发 file:delete，保留磁盘文件）——原 L232-233 语义原样保留
      clearLocalOnly();
      setInputValue(''); // ★修复：对齐 ai_fr chat-shell.tsx L2171-2173——消息受理即清空输入框。闭包 inputValue 已捕获原文本，下行 sendMessage 发送内容不受影响
      // ★ M1+M3：第三参显式传入进入时捕获的目标会话 ID——sendMessage 内部五重守卫与
      //   IPC 投递均按该 ID 判定/路由，不再依赖 await 后的 conversationIdRef.current
      await sendMessage(inputValue, attachments, targetConversationId);
    } finally {
      sendInFlightConversationIdsRef.current.delete(flightKey); // 释放进入时捕获的键：禁用 finally 时刻的 conversationId 状态变量（会话切换后已变值会误删他话）
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
    creatingConversation,
    createConversation,
    fileUploadingCount,
    setPendingUploadStatus,
    uploadFilesForSend,
    messageApi,
  ]);

  const handleAbort = useCallback(() => {
    // ★ M3：停止按钮只中止当前活跃会话——显式传入渲染闭包的 conversationId，
    //   与按钮渲染态（showCancel 按当前会话计算）保持同一身份
    abortChat(conversationId);
  }, [abortChat, conversationId]);

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
            toolSnapshots={toolSnapshots}
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
            /** ★ M4：目标会话级提交锁（当前会话 running/sending 或新建会话在途） */
            submitLocked={showCancel || creatingConversation}
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


    </div>
  );
}
