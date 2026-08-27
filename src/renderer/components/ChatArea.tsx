/**
 * ChatArea 聊天区域组件
 * 对齐 ai-client ChatArea.tsx 样式结构 + 三色头像规范
 *
 * Phase 3 P3-3 适配层：
 * - 粘底滚动开关 stickToBottomRef 由 useChat 拥有并管理
 * - 切换会话时 useChat.switchConversation 已重置 stickToBottomRef=true
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Actions, Bubble, Welcome } from '@ant-design/x';
import type { BubbleItemType } from '@ant-design/x';
import { Button, Flex, Spin, theme } from 'antd';
import {
  DownOutlined,
  FolderOpenOutlined,
  PaperClipOutlined,
  RobotOutlined,
  ToolOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { ChatMessageContent } from './ChatMessageContent';
import type { ToolSummary } from './ChatMessageContent';
import type { ChatMessage, ToolSnapshot } from '../hooks/useChat';
// ★ P04: latestToolProgressText 改用增量缓存版（cacheKey=`snap-${taskId}` 级），输出与全量版逐字一致
import { latestToolProgressTextCached } from '../lib/executor-thinking';

// ============================================================
// ★ 修复主/子智能体消息混淆：toolSnapshots → 虚拟 ChatMessage 转换 + 时间线合并
// 对位 ai_fr chat-shell.tsx L504-539 mergeToolSnapshotsIntoTimeline 语义
// 独立设计：使用 Delepi 自身的 ChatMessage / ToolSnapshot 类型，不硬搬参考实现
// ============================================================

/**
 * 解析时间戳（无效值返回正无穷，保持向后兼容）
 * @param value ISO 时间字符串
 */
function parseTimelineTime(value: string | undefined | null): number {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY;
}

function mapToolSnapshotMessageStatus(
  status: ToolSnapshot['status'],
): ChatMessage['status'] {
  if (status === 'running') return 'loading';
  if (status === 'failed') return 'error';
  return 'success';
}

function getToolSnapshotStartedAt(snapshot: ToolSnapshot): string {
  const firstStartedAt = snapshot.toolCalls?.find((item) => item.startedAt)?.startedAt;
  return snapshot.createdAt ?? firstStartedAt ?? snapshot.updatedAt;
}

function getToolSnapshotFinishedAt(snapshot: ToolSnapshot): string | undefined {
  if (snapshot.status === 'running') return undefined;
  return snapshot.finishedAt ?? snapshot.updatedAt;
}

/**
 * 把 toolSnapshots 转虚拟 ChatMessage（role='tool', source='executor'）
 * - 过滤：仅保留当前 conversationId 的快照（避免跨会话污染）
 * - 虚拟消息 id = `executor-tool-${taskId}`
 * - toolCall.name 优先取 taskName，否则取第一个 toolCall.name
 * - createdAt 使用快照的 updatedAt（用于时间线排序）
 * @param toolSnapshots 按 taskId 索引的快照字典
 * @param conversationId 当前活跃会话 ID
 */
function toolSnapshotsToChatMessages(
  toolSnapshots: Record<string, ToolSnapshot>,
  conversationId: string | null,
): ChatMessage[] {
  if (!conversationId) return [];
  const snapshots = Object.values(toolSnapshots).filter(
    (s) => s.conversationId === conversationId,
  );
  if (snapshots.length === 0) return [];
  return snapshots.map((s) => {
    const firstToolCall =
      s.toolCalls && s.toolCalls.length > 0 ? s.toolCalls[0] : undefined;
    const status = mapToolSnapshotMessageStatus(s.status);
    const startedAt = getToolSnapshotStartedAt(s);
    const finishedAt = getToolSnapshotFinishedAt(s);
    const result = s.result || s.lastContent || firstToolCall?.result || '';
    const callId = s.callId || firstToolCall?.callId || s.taskId;
    const name = s.taskName || firstToolCall?.name || '子智能体任务';

    return {
      id: `executor-tool-${s.taskId}`,
      role: 'tool' as const,
      content: result,
      // ★ 项6：虚拟消息附带完整思考链（来源 ToolSnapshot.thinking），供完成态 Think 渲染
      thinking: s.thinking || '',
      progress: latestToolProgressTextCached(`snap-${s.taskId}`, s.lastContent || ''),
      // ★ 子工具调用透传：完整 toolCalls 数组（delegate_executor 委派条目 + read_file/fs_search 等子工具调用），
      //   供 ChatMessageContent tool 分支过滤 delegate_executor 后逐条渲染子工具调用
      toolCalls: (s.toolCalls ?? []),
      toolCall: {
        ...(firstToolCall ?? {}),
        callId,
        name,
        arguments: firstToolCall?.arguments ?? '',
        result,
        status:
          status === 'loading'
            ? 'loading'
            : status === 'error'
              ? 'error'
              : 'success',
        startedAt,
        finishedAt,
        isError: s.status === 'failed' || firstToolCall?.isError,
      },
      status,
      createdAt: startedAt,
      source: 'executor' as const,
      /**
       * ★ 修复主/子智能体消息混淆：source='executor' 显式标识
       * 旧数据无 source 字段默认 'main'（ChatMessage 接口 source 可选）
       * 由 ChatMessageContent 根据 source 字段分支处理
       */
    };
  });
}

/**
 * 把 toolSnapshots 合并到 messages 时间线
 * 对位 ai_fr chat-shell.tsx L504-539 mergeToolSnapshotsIntoTimeline
 * 独立设计：使用 Delepi ChatMessage / ToolSnapshot 类型，不硬搬参考实现
 * 算法：
 * 1. 把 toolSnapshots 转虚拟 ChatMessage（toolSnapshotsToChatMessages）
 * 2. 虚拟消息按 createdAt 排序（时间相同按 id 字典序）
 * 3. 遍历 messages，按时间戳把虚拟消息插入到合适位置
 * 4. 末尾追加剩余虚拟消息
 * @param messages 主消息流（按 createdAt 自然顺序）
 * @param toolSnapshots 子智能体执行中间快照（按 taskId 索引）
 * @param conversationId 当前活跃会话 ID
 * @returns 合并后的消息流（时间线）
 */
export function mergeToolSnapshotsIntoTimeline(
  messages: ChatMessage[],
  toolSnapshots: Record<string, ToolSnapshot>,
  conversationId: string | null,
): ChatMessage[] {
  const existingToolCallIds = new Set(
    messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.toolCall?.callId)
      .filter((callId): callId is string => Boolean(callId)),
  );
  const snapshotMessages = toolSnapshotsToChatMessages(toolSnapshots, conversationId)
    .filter((message) => {
      const callId = message.toolCall?.callId;
      return !callId || !existingToolCallIds.has(callId);
    });
  if (snapshotMessages.length === 0) {
    return messages;
  }

  // ★ M11 三级稳定排序：time → seq（持久化稳定次序键，同批 created_at 同值时排序依据）
  //   → id 字典序（最终兜底：无 seq 的虚拟快照消息）
  const seqOf = (message: ChatMessage): number =>
    typeof message.seq === 'number' ? message.seq : Number.MAX_SAFE_INTEGER;
  const sortedSnapshots = [...snapshotMessages].sort((left, right) => {
    const timeCompare = parseTimelineTime(left.createdAt) - parseTimelineTime(right.createdAt);
    if (timeCompare !== 0) {
      return timeCompare;
    }
    const seqCompare = seqOf(left) - seqOf(right);
    if (seqCompare !== 0) {
      return seqCompare;
    }
    return left.id.localeCompare(right.id);
  });

  const timeline: ChatMessage[] = [];
  let snapshotIndex = 0;

  for (const message of messages) {
    const messageTime = parseTimelineTime(message.createdAt);
    while (
      snapshotIndex < sortedSnapshots.length &&
      parseTimelineTime(sortedSnapshots[snapshotIndex].createdAt) < messageTime
    ) {
      timeline.push(sortedSnapshots[snapshotIndex]);
      snapshotIndex += 1;
    }

    timeline.push(message);
  }

  return [...timeline, ...sortedSnapshots.slice(snapshotIndex)];
}

interface ChatAreaProps {
  messages: ChatMessage[];
  /**
   * ★ 修复主/子智能体消息混淆：子智能体执行中间快照（按 taskId 索引）
   * ChatArea 内部将其转换为独立虚拟 tool 消息（role='tool', source='executor'）
   * 并按时间戳合并到 messages 时间线
   */
  toolSnapshots?: Record<string, ToolSnapshot>;
  /**
   * ★ 修复主/子智能体消息混淆：当前活跃会话 ID
   * 用于过滤 toolSnapshots（避免跨会话污染）
   */
  conversationId?: string | null;
  messageListRef?: React.RefObject<HTMLDivElement | null>;
  stickToBottomRef?: React.MutableRefObject<boolean>;
  /** P3-3 向下箭头按钮可见性 */
  showScrollToBottom?: boolean;
  /** P3-3 向上回调：ChatArea 内部判定后通过此回调通知 useChat */
  onShowScrollToBottomChange?: (show: boolean) => void;
  isStreaming?: boolean;
  /**
   * ★ 对齐 ai_fr：消息加载过渡态，true 时显示 Spin 占位
   * 对齐 E:\ai_fr components\chat-shell.tsx L2678-2680
   */
  messageLoading?: boolean;
  emptyState?: ReactNode;
  children?: ReactNode;
  /**
   * ★ 对齐参考项目 E:\ai_fr\components\chat-shell.tsx L2684-2738
   * 工具摘要列表，用于把 toolCall.name 解析为 displayName。
   * 对应 ai_fr 的 config?.tools。
   * - 不传时 ChatMessageContent 内部降级到 pickTaskTitleFromArguments || toolName 行为
   */
  toolSummaries?: ToolSummary[];
}

export function ChatArea({
  messages,
  toolSnapshots,
  conversationId,
  messageListRef,
  stickToBottomRef,
  showScrollToBottom = false,
  onShowScrollToBottomChange,
  isStreaming = false,
  /**
   * ★ 对齐 ai_fr：消息加载过渡态
   */
  messageLoading = false,
  emptyState,
  toolSummaries,
}: ChatAreaProps): ReactElement {
  const { token } = theme.useToken();
  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const internalStickRef = useRef(true);
  const scrollRef = messageListRef ?? internalScrollRef;
  const stickRef = stickToBottomRef ?? internalStickRef;

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior });
    },
    [scrollRef],
  );

  /**
   * ★ 修复主/子智能体消息混淆：合并 toolSnapshots 到 messages 时间线
   * - 合并后用于 bubbleItems 渲染和 showEmpty 判定
   * - useMemo 缓存避免每次重渲染都重新合并
   */
  const mergedMessages = useMemo(
    () =>
      mergeToolSnapshotsIntoTimeline(
        messages,
        toolSnapshots ?? {},
        conversationId ?? null,
      ),
    [messages, toolSnapshots, conversationId],
  );

  /** P3-3 核心判定函数（对位 ai_fr updateScrollBottomState）
   *  - 阈值常量：SCROLLABLE_THRESHOLD_PX = 8、AT_BOTTOM_THRESHOLD_PX = 96
   *  - 仅在判定结果与外部状态不一致时回调，避免无效 setState
   */
  const SCROLLABLE_THRESHOLD_PX = 8;
  const AT_BOTTOM_THRESHOLD_PX = 96;

  // ★ P05 reflow 节流：布局属性读取（scrollHeight/clientHeight/scrollTop）经 rAF 对齐，
  //   同一帧内多次 scroll 事件只读一次布局（滚动期强制同步布局次数合并至帧级）。
  //   判定逻辑逐字保持（96px/8px 阈值原样），仅执行时机帧对齐；按钮显隐最多晚一帧，无感。
  const scrollStateRafRef = useRef<number | null>(null);
  const updateScrollBottomState = useCallback(() => {
    if (scrollStateRafRef.current !== null) return; // 同帧多次 scroll 事件只读一次布局
    scrollStateRafRef.current = requestAnimationFrame(() => {
      scrollStateRafRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      const canScroll = el.scrollHeight > el.clientHeight + SCROLLABLE_THRESHOLD_PX;
      const isAtBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD_PX;
      const next = canScroll && !isAtBottom;
      stickRef.current = isAtBottom;
      if (next !== showScrollToBottom) {
        onShowScrollToBottomChange?.(next);
      }
    });
  }, [scrollRef, showScrollToBottom, onShowScrollToBottomChange]);

  // P05：卸载时取消挂起的布局读取帧（防卸载后回调读 ref）
  useEffect(() => () => {
    if (scrollStateRafRef.current !== null) {
      cancelAnimationFrame(scrollStateRafRef.current);
      scrollStateRafRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (mergedMessages.length > 0 && stickRef.current) {
      scrollToBottom(isStreaming ? 'auto' : 'smooth');
    }
    // P3-3：合并后消息列表变化后主动调用判定
    updateScrollBottomState();
  }, [mergedMessages, isStreaming, scrollToBottom, stickRef, updateScrollBottomState]);

  const renderUserMessageFooter = useCallback(
    (
      _content: unknown,
      info: { extraInfo?: { message?: ChatMessage } },
    ) => {
      const message = info.extraInfo?.message;

      if (!message || message.role !== 'user' || message.status === 'local') {
        return null;
      }

      const text = message.content?.trim();
      if (!text) {
        return null;
      }

      return (
        <Actions.Copy
          className="chat-user-copy-action"
          text={text}
          aria-label="复制"
        />
      );
    },
    [],
  );

  // 三色头像 roleConfig（对齐 ai-client + operation_strategy.md 第 7.2.1 节）
  // ★ 对齐参考项目 E:\ai_fr\components\chat-shell.tsx L2684-2738
  // 每个 role 增加 contentRender 函数，从 bubbleItem.extraInfo.message 读取 message，
  // 并调用 ChatMessageContent 渲染。
  const roleConfig = useMemo(
    () => ({
      ai: {
        placement: 'start' as const,
        avatar: (
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: '#2563eb',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <RobotOutlined />
          </div>
        ),
        variant: 'borderless' as const,
        contentRender: (
          _content: unknown,
          info: { extraInfo?: { message?: ChatMessage } },
        ) => (
          <ChatMessageContent
            message={info.extraInfo?.message as ChatMessage}
            toolSummaries={toolSummaries}
            conversationId={conversationId ?? null}
          />
        ),
      },
      user: {
        placement: 'end' as const,
        className: 'chat-user-bubble',
        classNames: {
          content: 'chat-user-bubble-content',
          footer: 'chat-user-bubble-footer',
        },
        avatar: (
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: '#16a34a',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <UserOutlined />
          </div>
        ),
        variant: 'borderless' as const,
        footer: renderUserMessageFooter,
        footerPlacement: 'outer-end' as const,
        contentRender: (
          _content: unknown,
          info: { extraInfo?: { message?: ChatMessage } },
        ) => (
          <ChatMessageContent
            message={info.extraInfo?.message as ChatMessage}
            toolSummaries={toolSummaries}
            conversationId={conversationId ?? null}
          />
        ),
      },
      tool: {
        placement: 'start' as const,
        avatar: (
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: '#7c3aed',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <ToolOutlined />
          </div>
        ),
        variant: 'borderless' as const,
        contentRender: (
          _content: unknown,
          info: { extraInfo?: { message?: ChatMessage } },
        ) => (
          <ChatMessageContent
            message={info.extraInfo?.message as ChatMessage}
            toolSummaries={toolSummaries}
            conversationId={conversationId ?? null}
          />
        ),
      },
    }),
    // ★ P03 roleConfig 依赖收敛：useMemo 体内仅引用 toolSummaries/conversationId/renderUserMessageFooter，
    //   toolSnapshots 属多余依赖（其变化触发全部气泡外壳重渲=根因R3）；toolSnapshots 仍经 props 参与
    //   mergedMessages（L266-274 投影链零改动），仅不再无谓重建 roleConfig
    [toolSummaries, conversationId, renderUserMessageFooter],
  );

  // ★ 对齐参考项目 E:\ai_fr\components\chat-shell.tsx L2684-2738
  // bubbleItem.content 设为空字符串占位（contentRender 接管渲染），
  // 通过 extraInfo.message 把 message 传给 contentRender。
  const bubbleItems: BubbleItemType[] = useMemo(
    () =>
      mergedMessages.map((msg) => ({
        key: msg.id,
        role: (msg.role === 'assistant'
          ? 'ai'
          : msg.role) as BubbleItemType['role'],
        content: msg.role === 'user' ? msg.content : msg.content || ' ',
        extraInfo: { message: msg },
        status: msg.status,
        streaming: msg.role === 'assistant' && msg.status === 'loading',
      })),
    [mergedMessages],
  );

  // ★ 修复主/子智能体消息混淆：showEmpty 判定使用合并后消息列表
  // 如果只有 toolSnapshots（无主消息）也视为非空（避免空状态闪烁）
  const showEmpty = mergedMessages.length === 0;

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: token.colorBgContainer,
      }}
    >
      <div
        ref={scrollRef}
        onScroll={updateScrollBottomState}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          overscrollBehavior: 'contain',
          padding: '24px 32px 16px',
        }}
      >
        {/* ★ P07: 稳定类名作为 content-visibility 作用域锚（globals.css .chat-message-list） */}
        <div
          className="chat-message-list"
          style={{
            width: '100%',
            maxWidth: 1100,
            minHeight: '100%',
            margin: '0 auto',
            paddingBottom: 12,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* ★ 对齐 ai_fr：messageLoading 期间显示 Spin 占位，避免空白闪烁 */}
          {messageLoading ? (
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                height: '100%',
              }}
            >
              <Spin />
            </div>
          ) : showEmpty ? (
            emptyState ?? (
            <Flex
              vertical
              align="center"
              justify="center"
              style={{ minHeight: '100%' }}
            >
                <Welcome
                  variant="borderless"
                  title="欢迎使用 Delepi"
                  description="智能协作、准确交付"
                  styles={{
                    root: {
                      textAlign: 'center',
                    },
                    title: {
                      fontSize: 28,
                    },
                    description: {
                      color: token.colorTextSecondary,
                    },
                  }}
                />
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'center',
                    gap: 12,
                    maxWidth: 640,
                    marginTop: 24,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      width: 300,
                      padding: '12px 16px',
                      background: token.colorBgElevated,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      borderRadius: token.borderRadiusLG,
                      textAlign: 'left',
                    }}
                  >
                    <FolderOpenOutlined
                      style={{
                        fontSize: token.fontSizeLG,
                        color: token.colorPrimary,
                        marginTop: 3,
                      }}
                    />
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                      }}
                    >
                      <span
                        style={{
                          fontSize: token.fontSize,
                          lineHeight: '22px',
                          fontWeight: 600,
                          color: token.colorText,
                        }}
                      >
                        本地路径直读
                      </span>
                      <span
                        style={{
                          fontSize: token.fontSizeSM,
                          lineHeight: '20px',
                          color: token.colorTextSecondary,
                        }}
                      >
                        在对话中提供本机文件的绝对路径，即可直接读取并执行，无需上传
                      </span>
                    </div>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      width: 300,
                      padding: '12px 16px',
                      background: token.colorBgElevated,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      borderRadius: token.borderRadiusLG,
                      textAlign: 'left',
                    }}
                  >
                    <PaperClipOutlined
                      style={{
                        fontSize: token.fontSizeLG,
                        color: token.colorPrimary,
                        marginTop: 3,
                      }}
                    />
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                      }}
                    >
                      <span
                        style={{
                          fontSize: token.fontSize,
                          lineHeight: '22px',
                          fontWeight: 600,
                          color: token.colorText,
                        }}
                      >
                        截图与文件上传
                      </span>
                      <span
                        style={{
                          fontSize: token.fontSizeSM,
                          lineHeight: '20px',
                          color: token.colorTextSecondary,
                        }}
                      >
                        支持拖拽、粘贴或点击附件按钮上传，单次至多 10 个文件
                      </span>
                    </div>
                  </div>
                </div>
              </Flex>
            )
          ) : (
            <Bubble.List
              items={bubbleItems}
              role={roleConfig}
              autoScroll={false}
            />
          )}
        </div>
        {showScrollToBottom ? (
          <Button
            shape="circle"
            icon={<DownOutlined />}
            aria-label="滚动到底部"
            title="滚动到底部"
            onClick={() => scrollToBottom('smooth')}
            style={{
              position: 'sticky',
              bottom: 8,
              margin: '-40px auto 0',
              display: 'block',
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
