/**
 * useChat Hook
 * IPC事件订阅 + 消息状态管理 + 流式更新
 *
 * 消息流：用户输入 → IPC chat:send → IPC事件回调
 *   (onThinking / onChunk / onToolCall / onToolResult / onDone / onError / onTitle)
 *   → 更新消息状态 → React 重渲染
 *
 * Phase 3 P0 适配层：
 * - P0-1: 订阅 executor:thinking（子智能体 thinking / 工具进度）→ 按 taskId 聚合到 toolSnapshots
 *         ★ 修复主/子智能体消息混淆：不再写入主消息 toolCalls 字段
 *         旧数据无 source 字段时默认视为主智能体（向后兼容）
 * - P0-3: 订阅 executor:snapshot（子智能体执行中间快照）→ 按 taskId upsert 到 toolSnapshots
 *         buildConversationDisplayState 恢复时优先从快照恢复 in-flight 任务
 *
 * Phase 3 P0-2 适配层（★ 修复主/子智能体消息混淆）：
 * - 订阅 executor:tool-progress（子智能体工具调用进度）→ 按 taskId/callId 聚合到 toolSnapshots.toolCalls
 *   后端 main-agent.ts 的 onToolCall / onToolResult 回调 emit 此事件
 *   payload 含 source='executor' / 子智能体工具真实 callId
 *   旧数据无 source 字段时默认视为主智能体（向后兼容）
 *
 * Phase 3 P1 + P3 适配层（后端已接入）：
 * - P1-1: 本地乐观插入 user message（status='local'）+ chat:user-message-created 替换
 * - P1-2: assistant 三态事件（started/snapshot/done）→ 按 id upsert
 * - P1-3: cancel/abort 归一化（markRunningMessagesAborted + markRunningToolSnapshotsAborted）
 *         + chat:aborted 事件统一归一化
 * - P3-1: 发送四重守卫（hasText/pendingConversationSend/isConversationSending/
 *         isConversationRunning）
 * - P3-2: 空泡过滤（filterEmptyAssistantBubbles）
 * - P3-3: 切换会话三步清理（completedToolCallIdsRef.clear / setToolSnapshots([]) /
 *         stickToBottomRef=true + setShowScrollToBottom(false)）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolCallInfo } from '../components/ToolCallCard';
import { pickTaskTitleFromArguments } from '../components/ChatMessageContent';
import type { AssistantMessageSegment } from '../lib/message-filter';
import { latestToolProgressTextCached } from '../lib/executor-thinking';
import { createThinkingEventMerger } from '../lib/thinking-event-merger';
import { IPC_CHAT, IPC_CONV } from '@shared/ipc-channels';
import type { ChatAttachment, StreamMessage } from '@shared/types/chat';

// ============================================================
// 类型定义
// ============================================================

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  /** executor 进度段文本（由 lastContent 切分而来）：完成态工具调用块渲染用 */
  progress?: string;
  /**
   * ★ P6 历史消息附件回显：user 消息携带的附件元数据列表
   * - 来源 1：本地乐观插入时由 attachments: SendAttachment[] 直接填入（从 useFileUpload.pendingFiles）
   * - 来源 2：后端 chat:user-message-created 事件回传（从 payload.attachments 还原）
   * - 来源 3：conv:get-messages 从 SQLite messages 表读出（由 listRendererMessages 填入）
   * 对齐 E:\ai_fr ChatMessageContentInner payload.attachments 渲染逻辑
   * - 仅 user 角色可能有附件
   * - assistant/tool 角色此字段为 undefined
   */
  attachments?: ChatAttachment[];
  toolCalls?: ToolCallInfo[];
  toolCall?: ToolCallInfo;
  /**
   * Assistant 消息 segments 二元结构（P1-A1）
   * 对齐 E:\ai_fr AssistantMessageSegment（reasoning | tool_call）
   * - 旧数据无 segments 字段时由 buildLegacySegments(thinking, toolCalls) 兜底
   * - 渲染时由 ChatMessageContent 用 segments.map 替代直接 thinking + toolCalls.map
   */
  segments?: AssistantMessageSegment[];
  /**
   * ★ 修复主/子智能体消息混淆：消息来源标识（向后兼容旧数据无此字段默认 'main'）
   * - 'main': 主智能体（向后兼容默认）
   * - 'executor': 执行子智能体（修复后由 useChat.toolSnapshots 转换的虚拟消息显式标识）
   */
  source?: 'main' | 'executor';
  /** ★ M11 持久化稳定次序键（messages.seq，同批 created_at 同值时排序依据） */
  seq?: number;
  status: 'local' | 'loading' | 'success' | 'error' | 'abort';
  createdAt: string;
}

/**
 * P5 文件上传发送附件参数（useChat.sendMessage 第二参数）
 * 对齐 E:\ai_fr lib/types.ts ChatAttachment（去掉 optional id 字段）
 * - 必填字段：name / size / contentType / storageKey（来自 file:upload 返回的 ChatUploadedFile）
 * - 可选 id：用于与主进程 ChatUploadedFile.id 关联
 *
 * 与 ChatSendFileInput 的差异：
 * - 不包含 data 字段（已通过 file:upload 独立通道落盘到 conversations/{id}/uploads/）
 * - storageKey 必填（旧 ChatSendFileInput 中 storageKey 是可选）
 */
export interface SendAttachment {
  id?: string;
  name: string;
  size: number;
  contentType: string;
  storageKey: string;
}

export interface ConversationListItem {
  id: string;
  title: string;
  isRunning: boolean;
  createdAt: string;
  updatedAt: string;
  /** 方向3：会话标签（conv:list 聚合返回；可选保证既有消费方向后兼容） */
  tags?: string[];
}

/**
 * 极简 message API 接口（P1-E2）
 * 对齐 antd App.useApp() 返回的 message 静态方法
 * 仅声明所需 error 方法，避免整个 antd message 模块耦合到 useChat
 */
export interface UseChatMessageApi {
  error: (content: string) => void;
}

/**
 * useChat 接受的可选参数（P1-E2）
 * - messageApi：antd App.useApp() 注入的 message 实例
 *   传入时：unsubError 走 messageApi.error 显示顶部 toast（antd 默认顶部居中）
 *   不传时：退回原 setError 行为（ChatShell 显示底部固定错误条）
 */
export interface UseChatOptions {
  messageApi?: UseChatMessageApi;
}

/**
 * 子智能体执行中间快照（Phase 3 P0-3 适配层）
 * - conversationId: 所属对话
 * - taskId: 子任务 ID（主智能体 delegate_executor 委派时生成的 uuid）
 * - callId: 工具调用 ID（子智能体内部工具调用，可选）
 * - status: 任务状态
 * - progress: 进度描述
 * - toolCalls: 当前累积的工具调用列表（含 result 字段）
 * - updatedAt: 快照时间戳
 */

export interface ToolSnapshot {
  conversationId: string;
  taskId: string;
  callId?: string;
  status: 'running' | 'completed' | 'failed';
  progress?: { current: number; total: number; description: string };
  toolCalls: ToolCallInfo[];
  createdAt?: string;
  updatedAt: string;
  finishedAt?: string;
  result?: string;
  /** ★ 对齐 ai_fr executorTaskToToolSnapshot：完整思考链 join 后的思考内容（快照复原/历史恢复时前端渲染消费） */
  thinking?: string;
  isError?: boolean;
  /**
   * ★ 修复主/子智能体消息混淆：消息来源标识（向后兼容旧数据无此字段默认 'main'）
   * - 'main': 主智能体（向后兼容默认）
   * - 'executor': 执行子智能体（修复后由后端显式标识）
   */
  source?: 'main' | 'executor';
  /**
   * ★ 委派任务名称（运行中任务卡片标题取值源）：从快照 message.payload.arguments
   *   （delegate_executor 委派参数）解析 taskname——与完成态真实 tool 消息标题
   *   （pickTaskTitleFromArguments）同一解析器同一数据源；缺省时标题回退子工具名链
   */
  name?: string;
  /**
   * ★ 修复主/子智能体消息混淆：子智能体工具的真实 callId（修复 callId 语义错位）
   *   - 主智能体 callId：delegate_executor 的 id（外层 toolCall.id）
   *   - 子智能体 callId：executorCallId（内层 LLM 返回的 toolCall.id）
   *   修复后通过 executorCallId 区分
   */
  executorCallId?: string;
  /**
   * ★ Phase 3 P3-8 messageId ↔ taskId 关联键
   * 主智能体 assistant 消息 ID,标识该快照归属的 assistant 消息
   * 用于多子任务并行时各 assistant 消息可正确承载自己的 toolCall 快照
   * 来自 executor:thinking / executor:tool-progress / executor:snapshot 事件
   */
  messageId?: string;
  /**
   * ★ 修复主/子智能体消息混淆：最新 thinking/tool-progress 累积文本
   *   来自 executor:thinking 事件，前端 UI 可按 type 字段判断渲染位置
   */
  lastContent?: string;
  /** 最新推送类型（来自 executor:thinking 事件） */
  lastType?: 'thinking' | 'tool-progress';
}

// ============================================================
// IPC 事件载荷类型
// ============================================================

interface ChunkPayload {
  conversationId: string;
  content: string;
  delta: string;
  isThinking: boolean;
  /**
   * ★ Phase 3 P3-7 finishReason 字段(可选)
   * 由 openai-client.ts 在 finish_reason 变化时通过 onChunk 转发
   * useChat 据此判断 stream 终止原因:
   * - 'stop': 正常结束 → status='success'
   * - 'length': 长度限制截断 → status='success' 但 content 截断
   * - 'tool_calls': 工具调用 → 继续等 chat:tool-call + chat:done
   * - undefined/null: 流式过程中 → status='loading'
   */
  finishReason?: string | null;
  /**
   * ★ M13 重试复位矫正标记（可选）：true = 本次载荷为基线全量覆盖（delta=''），
   * 渲染端据此整体覆盖目标消息 content，截断 attempt-1 残留增量（双份累积修复）
   */
  reset?: boolean;
}

// ============================================================
// F6 扩展：chat:thinking 事件载荷定义
//   后端 main-agent.ts F2 emit 含完整 thinking + segments（F4/F5 累积结果）
//   前端优先使用 data.segments 重建 message.segments，data.delta 仅作兜底
// ============================================================
interface ThinkingPayload {
  conversationId: string;
  delta?: string;                                // 兜底字段（向后兼容旧后端）
  thinking?: string;                             // ★ F6 新增：后端累积的完整思考文本
  segments?: AssistantMessageSegment[];          // ★ F6 新增：后端累积的完整分段
}

interface ToolCallPayload {
  conversationId: string;
  callId: string;
  name: string;
  arguments: string;
  isDelegatedExecutor?: boolean;
}

interface ToolResultPayload {
  conversationId: string;
  callId: string;
  name: string;
  result: string;
  success: boolean;
}

interface DonePayload {
  conversationId: string;
  messageId: string;
  durationMs: number;
}

interface ErrorPayload {
  conversationId: string;
  error: string;
  errorType: string;
}

/** 对话标题事件（方向3：首轮生成 source=generated / 自定义重命名 source=manual） */
interface TitlePayload {
  conversationId: string;
  title: string;
  source?: 'generated' | 'manual';
}

interface ConversationUpdatedPayload {
  conversation: ConversationListItem;
}

/**
 * 用户消息创建事件（Phase 3 P1-1 适配层）
 * 后端真实用户消息入库后推送，前端用此替换 status='local' 的本地乐观消息
 */
interface UserMessageCreatedPayload {
  conversationId: string;
  message: {
    id: string;
    role: 'user';
    content: string;
    status: 'success';
    createdAt: string;
  };
}

/**
 * Assistant 消息 started 事件（Phase 3 P1-2 适配层）
 * 后端开始生成 assistant 消息时推送，初始化 status='loading' 消息
 */
interface AssistantStartedPayload {
  conversationId: string;
  message: ChatMessage;
}

/**
 * Assistant 消息 snapshot 事件（Phase 3 P1-2 适配层）
 * 流式累积：思考 / 工具进度，按 id upsert 到同一条消息
 */
interface AssistantSnapshotPayload {
  conversationId: string;
  message: ChatMessage;
}

/**
 * Assistant 消息 done 事件（Phase 3 P1-2 适配层）
 * 流式结束：标记 status='success' 或 'error'
 */
interface AssistantDonePayload {
  conversationId: string;
  message: ChatMessage;
}

interface ToolMessageCreatedPayload {
  conversationId: string;
  message: ChatMessage;
}

/**
 * 对话被中止事件（Phase 3 P1-3 适配层）
 * 触发 markRunningMessagesAborted + markRunningToolSnapshotsAborted 归一化
 */
interface AbortedPayload {
  conversationId: string;
  reason?: string;
}

/**
 * ★ S3 批次完成事件载荷（M4，对齐 ai_fr types/chat.ts:171-177）
 * 后端批次收口块在全中止判定之前推送（含全中止批次），
 * 前端按 toolCallIds 收口 running 快照（isError → failed / 否则 completed）
 */
interface ToolBatchCompletedPayload {
  conversationId: string;
  toolCallIds: string[];
}

/**
 * 轻量快照查询响应 toolCalls 成员条目（M15/M21 消费类型；
 * 与主进程 ExecutorToolCallSnapshot 字段逐一同构——渲染进程不 import 主进程模块）
 */
interface ExecutorToolCallDetail {
  callId: string;
  name: string;
  status: 'loading' | 'success' | 'error';
  startedAt?: string;
  finishedAt?: string;
}

/**
 * executor:snapshot 六字段信号（v2.1 规则②白名单；M1/M3 主进程 emitSnapshotSignal 唯一出口构造）
 * 信号本身不携带过程数据，前端收到后触发轻量查询 conv:get-running-snapshots 拉取明细
 */
interface ExecutorSnapshotPayload {
  conversationId: string;
  taskId: string;
  callId?: string;
  status: 'running' | 'completed' | 'failed';
  messageId?: string;
  updatedAt?: string;
}

// ============================================================
// 工具函数
// ============================================================

let messageSeq = 0;
function nextMessageId(): string {
  messageSeq += 1;
  return `msg-${Date.now()}-${messageSeq}`;
}

/**
 * P5 适配：构建本地乐观用户消息的展示文本
 * 输入 SendAttachment[]（来自 file:upload 已落盘的 ChatUploadedFile 元数据）
 *
 * ★ Phase 3 P3-4 修复：不再将附件名拼到 content
 * 原因：
 * 1. 持久化 schema 已有 attachments 字段,ChatMessageContent 渲染器按 attachments 字段渲染附件清单
 * 2. 把附件名拼到 content 会导致 serverMsg 替换本地乐观 user 消息时,attachments 字段丢失 → 附件显示丢失
 * 3. attachments 字段独立渲染,content 只保留用户输入文本
 */
function buildLocalUserDisplayText(text: string, _attachments: SendAttachment[]): string {
  return text.trim();
}

/**
 * 从 StreamMessage 构造 ToolSnapshot（对齐 ai_fr snapshotMessageToToolSnapshot 语义）
 * status 映射：success→completed、error→failed、其余→running
 * thinking 取自 message.payload.thinking（完整思考链）
 */
function snapshotMessageToToolSnapshot(
  message: StreamMessage,
  conversationId: string,
  taskId: string,
  toolCallsDetail?: ExecutorToolCallDetail[],
): ToolSnapshot | null {
  if (!message || !message.payload) {
    return null;
  }
  const status: ToolSnapshot['status'] =
    message.status === 'error'
      ? 'failed'
      : message.status === 'success'
        ? 'completed'
        : 'running';
  const startedAt = message.payload.startedAt ?? message.createdAt ?? new Date().toISOString();
  const finishedAt = message.payload.finishedAt;
  const isFailed = message.payload.isError ?? status === 'failed';
  // ★ M16 恢复还原 lastContent：由快照七字段合成（S1-5 后 snapshot.json thinking=思考全量、
  //   result=最新进度），join('\n\n') 与 M15 切分规则互逆；恢复后新事件按 M15 规则追加，
  //   进度不清零重累（机制F 主修复）
  const restoredThinking = message.payload.thinking ?? '';
  const restoredProgress = typeof message.payload.result === 'string' ? message.payload.result : '';
  // ★ M15（v2.1 数据源换绑）：toolCallsDetail 非空（轻量查询响应三元组 toolCalls 成员）→ 按条映射恢复；
  //   空缺 → 现状单条合成兜底（委派参数条目）
  const restoredToolCalls: ToolCallInfo[] = Array.isArray(toolCallsDetail) && toolCallsDetail.length > 0
    ? toolCallsDetail.map((tc) => ({
        callId: tc.callId,
        name: tc.name,
        arguments: '',
        status: tc.status === 'error' ? ('error' as const) : tc.status === 'success' ? ('success' as const) : ('loading' as const),
        startedAt: tc.startedAt ?? startedAt,
        ...(tc.finishedAt ? { finishedAt: tc.finishedAt } : {}),
        isDelegatedExecutor: tc.name === 'delegate_executor',
      }))
    : [
      {
        callId: message.payload.toolCallId,
        name: message.payload.name,
        arguments: message.payload.arguments ?? '',
        result: message.payload.result ?? '',
        status: status === 'failed' ? 'error' : status === 'completed' ? 'success' : 'loading',
        startedAt,
        ...(finishedAt ? { finishedAt } : {}),
        isError: isFailed,
        isDelegatedExecutor: message.payload.name === 'delegate_executor',
      },
    ];
  // ★ 运行中标题取值源：委派任务名从快照 message.payload.arguments（委派参数）解析——
  //   与完成态真实 tool 消息标题（pickTaskTitleFromArguments(payload.arguments)）同一解析器，
  //   轻量查询/全量恢复两出口数据同源（均携带 message），恢复结果天然一致
  const restoredTaskName = pickTaskTitleFromArguments(message.payload.arguments ?? '') ?? '';
  return {
    conversationId,
    taskId,
    callId: message.payload.toolCallId,
    status,
    result: message.payload.result ?? '',
    thinking: message.payload.thinking ?? '',
    isError: isFailed,
    toolCalls: restoredToolCalls,
    createdAt: startedAt,
    updatedAt: finishedAt ?? startedAt,
    ...(finishedAt ? { finishedAt } : {}),
    source: 'executor',
    // ★ 运行中标题载体：name=委派任务名（委派参数 taskname 解析结果）。
    //   ChatArea.tsx toolSnapshotsToChatMessages 的 s.name 优先取值，
    //   运行中标题不再被子工具条目置换（首个子工具调用前后不翻转、并发多任务各自任务名）
    name: restoredTaskName,
    // ★ M16：lastContent/lastType 恢复（有 progress 时 lastType=tool-progress）
    lastContent: [restoredThinking, restoredProgress]
      .filter((segment) => segment.trim().length > 0)
      .join('\n\n'),
    lastType: restoredProgress ? 'tool-progress' : 'thinking',
  };
}

function collectCompletedToolCallIds(messages: ChatMessage[]): Set<string> {
  return new Set(
    messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.toolCall?.callId)
      .filter((callId): callId is string => Boolean(callId)),
  );
}

function resolveActiveAssistantMessageId(messages: ChatMessage[]): string | null {
  // ★ S4（M5）：running 委派任务分支随委派任务表恢复源摘除而删除，仅保留 loading assistant 判定
  const loadingAssistant = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.status === 'loading');

  return loadingAssistant?.id ?? null;
}

// ============================================================
// Phase 3 P1 + P3 适配层辅助函数
// ============================================================

/**
 * 替换最近的 status='local' 用户消息为后端真实消息（P1-1）
 * 对齐 E:\ai_fr replaceLatestLocalUser
 * - 若找到 local user：替换
 * - 若未找到 local user：追加（兜底）
 * @param messages 当前消息列表
 * @param serverMessage 服务端真实用户消息
 * @returns 替换后的消息列表
 */
export function replaceLatestLocalUserInList(
  messages: ChatMessage[],
  serverMessage: ChatMessage,
): ChatMessage[] {
  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index].role === 'user' && next[index].status === 'local') {
      next[index] = { ...serverMessage, status: 'success' };
      return next;
    }
  }
  return [...next, { ...serverMessage, status: 'success' }];
}

/**
 * 按 id upsert 消息（P1-2）
 * 对齐 E:\ai_fr appendOrReplaceMessage
 * - 若 message.id 已存在：合并更新（保持原 id 之外的所有字段被新值覆盖）
 * - 若不存在：追加
 * @param messages 当前消息列表
 * @param message 待 upsert 的消息
 * @returns upsert 后的消息列表
 */
export function upsertMessageById(
  messages: ChatMessage[],
  message: ChatMessage,
): ChatMessage[] {
  const index = messages.findIndex((m) => m.id === message.id);
  if (index === -1) {
    return [...messages, message];
  }
  const next = [...messages];
  next[index] = { ...next[index], ...message };
  return next;
}

/**
 * 将所有 status='loading' 消息批量改为 'abort'（P1-3）
 * 对齐 E:\ai_fr markRunningMessagesAborted
 * - 非 tool 消息：status 直接改为 'abort'
 * - tool 消息：status 改为 'abort'，空 result 改为 '已取消。'，isError=true
 * @param messages 当前消息列表
 * @returns 归一化后的消息列表
 */
export function markRunningMessagesAbortedInList(
  messages: ChatMessage[],
): ChatMessage[] {
  return messages.map((m) => {
    if (m.status !== 'loading') return m;
    if (m.role === 'tool') {
      const finishedAt = new Date().toISOString();
      const hasResult = m.toolCall?.result && m.toolCall.result.trim().length > 0;
      return {
        ...m,
        status: 'abort' as const,
        toolCall: m.toolCall
          ? {
              ...m.toolCall,
              result: hasResult ? m.toolCall.result : '已取消。',
              isError: true,
              finishedAt,
              status: 'error' as const,
            }
          : undefined,
      };
    }
    return { ...m, status: 'abort' as const };
  });
}

/**
 * 将所有 status='running' 的快照批量归一化（P1-3）
 * 对齐 E:\ai_fr markRunningToolSnapshotsAborted
 * - status='running' → status='failed'
 * - 工具调用空 result → '已取消。'，isError=true
 * @param snapshots 按 taskId 索引的快照字典
 * @returns 归一化后的快照字典
 */
export function markRunningToolSnapshotsAbortedInList(
  snapshots: Record<string, ToolSnapshot>,
): Record<string, ToolSnapshot> {
  const next: Record<string, ToolSnapshot> = {};
  for (const [taskId, snap] of Object.entries(snapshots)) {
    if (snap.status !== 'running') {
      next[taskId] = snap;
      continue;
    }
    const finishedAt = new Date().toISOString();
    const updatedToolCalls = (snap.toolCalls || []).map((tc) => {
      const hasResult = tc.result && tc.result.trim().length > 0;
      return {
        ...tc,
        result: hasResult ? tc.result : '已取消。',
        isError: true,
        finishedAt,
        status: 'error' as const,
      };
    });
    next[taskId] = {
      ...snap,
      status: 'failed',
      toolCalls: updatedToolCalls,
      result: snap.result || snap.lastContent || '已取消。',
      isError: true,
      finishedAt,
      updatedAt: finishedAt,
    };
  }
  return next;
}

export function completeToolSnapshotByDelegateCallId(
  snapshots: Record<string, ToolSnapshot>,
  payload: ToolResultPayload,
): Record<string, ToolSnapshot> {
  const entries = Object.entries(snapshots);
  // ★ M08 兜底收紧（前置=批1 三成因已闭合：M01/M02/M04/M05 切换不清空+事件不丢弃+恢复 live-wins）：
  //   精确匹配命中率≈100%，删除 reverse-find 兜底（并发时会错抓任意 running 快照强行收口，
  //   错写到其他任务卡片）；仅保留精确匹配路径，未命中打 warn 可观测。
  //   running 快照收口链仍有五路冗余：tool-result 精确匹配（本函数）/ tool.message.created 删键
  //   / tool.batch.completed 批次收口 / chat:done isError 收口 / chat:aborted 归一化。
  const targetEntry = entries.find(
    ([, snapshot]) => snapshot.callId === payload.callId,
  );

  if (!targetEntry) {
    console.warn('[useChat] tool-result 无匹配快照', { callId: payload.callId });
    return snapshots;
  }

  const [taskId, snapshot] = targetEntry;
  const finishedAt = new Date().toISOString();
  const existingToolCalls = snapshot.toolCalls || [];
  const completedDelegateToolCall: ToolCallInfo = {
    callId: payload.callId,
    name: payload.name,
    arguments: '',
    result: payload.result,
    status: payload.success ? 'success' : 'error',
    startedAt: snapshot.createdAt,
    finishedAt,
    isError: !payload.success,
    isDelegatedExecutor: payload.name === 'delegate_executor',
  };
  const hasDelegateToolCall = existingToolCalls.some(
    (toolCall) => toolCall.callId === payload.callId,
  );
  const toolCalls = hasDelegateToolCall
    ? existingToolCalls.map((toolCall) =>
        toolCall.callId === payload.callId
          ? {
              ...toolCall,
              result: payload.result,
              status: payload.success ? ('success' as const) : ('error' as const),
              isError: !payload.success,
              finishedAt,
            }
          : toolCall,
      )
    : [completedDelegateToolCall, ...existingToolCalls];

  return {
    ...snapshots,
    [taskId]: {
      ...snapshot,
      status: payload.success ? 'completed' : 'failed',
      result: payload.result,
      isError: !payload.success,
      toolCalls,
      finishedAt,
      updatedAt: finishedAt,
    },
  };
}

/**
 * ★ S3（M4）批次完成收口：将批内仍为 running 的 toolSnapshots 按 isError 定格终态
 * 对齐 ai_fr chat-shell.tsx markBatchToolSnapshotsSettled:1893-1918
 * - 仅处理 status='running' 且 callId ∈ toolCallIds 的快照（收口键=callId）
 * - isError=true → 'failed'，否则 → 'completed'（Delepi 三态与 ai_fr loading/success/error 语义映射同构）
 * - 补 finishedAt（缺省取当前时间）
 * @param snapshots 按 callId 索引的快照字典（S4/M6 键统一：Object.entries 键即委派 callId）
 * @param conversationId 批次所属会话
 * @param toolCallIds 批内全部工具调用 id
 */
export function markBatchToolSnapshotsSettled(
  snapshots: Record<string, ToolSnapshot>,
  conversationId: string,
  toolCallIds: string[],
): Record<string, ToolSnapshot> {
  const batchCallIds = new Set(toolCallIds);
  const next = { ...snapshots };
  for (const [key, snapshot] of Object.entries(next)) {
    if (snapshot.conversationId !== conversationId) continue;
    if (snapshot.status !== 'running') continue;
    const callId = snapshot.callId;
    if (!callId || !batchCallIds.has(callId)) continue;
    const finishedAt = snapshot.finishedAt ?? new Date().toISOString();
    next[key] = {
      ...snapshot,
      status: snapshot.isError ? 'failed' : 'completed',
      finishedAt,
      updatedAt: finishedAt,
    };
  }
  return next;
}

// ============================================================
// Hook
// ============================================================

export function useChat(options?: UseChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [streamingConversationIds, setStreamingConversationIds] = useState<Set<string>>(new Set());
  /**
   * ★ M2/T1 修复（一个对话一个 is_running 标志位）：新建会话在途标记。
   * conv:create 的 await 返回前为 true：
   * - 抑制创建窗口内的重复建会话（双击“新建对话”）；
   * - 上游（ChatShell/SenderBox）据此锁定发送/停止动作的目标身份，
   *   消除“窗口内 conversationIdRef.current 仍指向旧会话 A”的身份漂移判定。
   * 注意：这是“创建动作在途”标记，不是任何会话的 running 状态，不参与发送五重守卫。
   */
  const [creatingConversation, setCreatingConversation] = useState(false);
  const creatingConversationRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  /** 子智能体执行中间快照（Phase 3 P0-3），按 taskId 索引 */
  const [toolSnapshots, setToolSnapshots] = useState<Record<string, ToolSnapshot>>({});
  /**
   * ★ M01 多会话隔离：单会话运行态（含流式中间态），挂在 useRef Map 中
   *   （不进 React 状态，避免整树重渲染）。所有会话的流式事件一律先写入该
   *   存储（单一事实源），活跃会话的 messages/toolSnapshots 状态只是该存储
   *   在当前 conversationId 上的实时投影（ChatArea/ChatShell 消费链零改动）。
   */
  interface ConversationRuntimeState {
    conversationId: string;                       // Map 键（与 conversations.id 同源）
    messages: ChatMessage[];                      // 该会话消息列表（含流式 assistant 与乐观 user）
    toolSnapshots: Record<string, ToolSnapshot>;  // 键 = 委派 callId ?? taskId（随会话隔离，无跨会话碰撞）
    completedToolCallIds: Set<string>;            // 该会话已完成工具调用 ID（防重）
    assistantMessageId: string | null;            // 该会话流式目标 assistant 消息 ID（多会话职责由 entry 承载）
    conversationRunning: boolean;                 // 会话级运行标记
    lastActiveAt: number;                         // 最近事件/切回时间戳（LRU 依据）
    terminal: boolean;                            // 终态标记（done/error/aborted 已达）
    terminalAt: number;                           // 终态到达时间戳（延迟驱逐依据）
  }
  const conversationRuntimeStoreRef = useRef<Map<string, ConversationRuntimeState>>(new Map());
  /**
   * ★ 消息加载过渡态：切换会话时显示 Spin，避免空白闪烁
   * 对齐 ai_fr chat-shell.tsx L654 messageLoading + setMessageLoading
   */
  const [messageLoading, setMessageLoading] = useState(false);

  const conversationIdRef = useRef<string | null>(null);
  const assistantMessageIdRef = useRef<string | null>(null);
  // ★ P1-E2：messageApi 通过 ref 持有，避开 useEffect 依赖
  //   ChatShell 顶层 AntApp.useApp() 注入，组件卸载前稳定不变
  const messageApiRef = useRef<UseChatMessageApi | undefined>(options?.messageApi);
  // 同步最新 messageApi 到 ref（允许外部动态更新）
  messageApiRef.current = options?.messageApi;

  // ============================================================
  // Phase 3 P1-C2 silentConversationReload + 200ms 节流 ref
  // 对齐 E:\ai_fr chat-shell.tsx L625-644
  // ============================================================

  /**
   * P1-C2 串行化序号：每次 loadConversationMessages 自增 1
   * 旧请求响应回来时若 loadSeq 不等于 conversationLoadSeqRef.current 则丢弃
   * 避免快速切换对话时旧请求覆盖新会话消息
   * 对齐 E:\ai_fr conversationLoadSeqRef L633
   */
  const conversationLoadSeqRef = useRef(0);

  /**
   * P1-C2 跳过加载的会话 ID 集合
   * createConversation 后 setConversationId 时跳过首次 useEffect 加载（避免重复）
   * 对齐 E:\ai_fr skipConversationLoadIdsRef L631
   */
  const skipConversationLoadIdsRef = useRef<Set<string>>(new Set());

  /**
   * P1-C2 200ms 节流定时器
   * scheduleConversationNavigationReload 200ms 内合并多次 silent 重新加载会话列表的请求
   * 对齐 E:\ai_fr conversationNavigationReloadTimeoutRef L622
   */
  const scheduleConversationNavigationReloadTimeoutRef = useRef<number | null>(null);

  /**
   * ★ BUG-1（激活对账）三重去重状态：
   * - fingerprint：上次对账触发时活跃会话的列表指纹（conversationId|isRunning|updatedAt），未变则跳过
   * - lastAt：上次对账触发时间戳（激活对账最小间隔 ≥2s 节流）
   * - inFlight：激活对账进行中标记（同一会话进行中的对账加载未完成不重复发起）
   */
  const activationReconcileStateRef = useRef({
    fingerprint: '',
    lastAt: 0,
    inFlight: false,
  });
  /**
   * ★ BUG-1：会话列表镜像 ref——激活监听闭包内读取最新列表（isRunning/updatedAt 指纹来源）
   *   渲染期同步模式对齐 messageApiRef，避免闭包过期
   */
  const conversationsRef = useRef<ConversationListItem[]>(conversations);
  /** 方向3：已被自定义标题(manual)更新过的会话集合——用于丢弃晚到的 generated 标题事件 */
  const manualRenamedConversationIdsRef = useRef<Set<string>>(new Set());
  conversationsRef.current = conversations;

  // ============================================================
  // Phase 3 P1 + P3 适配层状态
  // ============================================================

  /**
   * P3-1 守卫 2：是否在等待对话发送结果
   * 用于 sendMessage 前判断是否允许发起新发送（防重复点击）
   */
  const [pendingConversationSendIds, setPendingConversationSendIds] = useState<Set<string>>(new Set());
  const pendingSendRef = useRef<Set<string>>(new Set());
  /**
   * P3-1 守卫 3：正在发送的对话 ID 集合
   * 用于 sendMessage 前判断当前活跃会话是否在发送中
   */
  const [sendingConversationIds, setSendingConversationIds] = useState<Set<string>>(
    () => new Set(),
  );
  /**
   * P3-3 步骤 2：是否显示"滚动到底部"按钮
   * ChatArea 渲染此按钮；切换会话时由 switchConversation 归 false
   */
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  /**
   * P3-3 步骤 1：已完成（completed / failed / error）的工具调用 ID 集合
   * 切换会话时由 switchConversation 调 .clear() 清空
   */
  const completedToolCallIdsRef = useRef<Set<string>>(new Set());
  /**
   * 粘底滚动开关 ref（由 ChatShell 拥有并透传到 ChatArea）
   * 切换会话时由 switchConversation 重置为 true
   */
  const stickToBottomRef = useRef<boolean>(true);

/**
 * ★ P0-A 流式投影节流：高频流式事件只 mutate store（M01 单一事实源，零渲染），
 *   投影（setMessages/setToolSnapshots）合并到 50ms 节流窗口执行；
 *   终态/低频事件仍即时投影（immediate 分支先吸收 pending 脏数据，无 stale）。
 *   间隔依据见优化方案 1.2（观感 20fps + 主线程负载削减 ≥83%）。
 */
const STREAM_PROJECTION_INTERVAL_MS = 50;
const projectionDirtyRef = useRef(false);
const projectionTimerRef = useRef<number | null>(null);

  // ============================================================
  // ★ M01 多会话隔离：运行态存储路由器 + 内存管理（M07 三道闸门）
  // ============================================================

  /** 创建空运行态条目 */
  const createRuntimeState = useCallback(
    (conversationId: string): ConversationRuntimeState => ({
      conversationId,
      messages: [],
      toolSnapshots: {},
      completedToolCallIds: new Set<string>(),
      assistantMessageId: null,
      conversationRunning: false,
      lastActiveAt: Date.now(),
      terminal: false,
      terminalAt: 0,
    }),
    [],
  );

/** 取消 pending 节流（清脏 + 清定时器）；immediate 投影与会话切换前调用 */
const cancelPendingProjection = useCallback(() => {
  projectionDirtyRef.current = false;
  if (projectionTimerRef.current !== null) {
    window.clearTimeout(projectionTimerRef.current);
    projectionTimerRef.current = null;
  }
}, []);

/** flush：从 store 读活跃会话最新 entry 做快照式双投影（React 18+ 同步批处理=单次 render） */
const flushProjection = useCallback(() => {
  cancelPendingProjection();
  const activeId = conversationIdRef.current;
  const entry = activeId ? conversationRuntimeStoreRef.current.get(activeId) : undefined;
  if (entry) {
    setMessages(entry.messages);
    setToolSnapshots(entry.toolSnapshots);
  }
}, [cancelPendingProjection]);

/** 边沿触发节流：首个 deferred 事件启动 50ms 定时器；到点自动 flushProjection */
const scheduleProjection = useCallback(() => {
  projectionDirtyRef.current = true;
  if (projectionTimerRef.current === null) {
    projectionTimerRef.current = window.setTimeout(() => {
      projectionTimerRef.current = null;
      flushProjection();
    }, STREAM_PROJECTION_INTERVAL_MS);
  }
}, [flushProjection]);

  /**
   * ★ M01 事件路由器：按 conversationId 取/建 store 条目 → 执行状态变换 → 更新活跃时间；
   *   若为活跃会话则镜像投影（messages/toolSnapshots/completedToolCallIds/assistantMessageId）
   */
  const applyConversationEvent = useCallback(
    (
      conversationId: string,
      mutate: (entry: ConversationRuntimeState) => void,
      options?: { projection?: 'deferred' | 'immediate' },
    ) => {
      const store = conversationRuntimeStoreRef.current;
      const entry = store.get(conversationId) ?? createRuntimeState(conversationId);
      mutate(entry);
      entry.lastActiveAt = Date.now();
      store.set(conversationId, entry);
      if (conversationId === conversationIdRef.current) {
        if (options?.projection === 'deferred') {
          scheduleProjection();   // 高频流式：标脏 + 节流投影
        } else {
          // 终态/低频：先吸收 pending 流式脏数据（取消定时器），再连同本次 mutate 一并即时投影
          cancelPendingProjection();
          setMessages(entry.messages);
          setToolSnapshots(entry.toolSnapshots);
        }
        completedToolCallIdsRef.current = entry.completedToolCallIds;
        assistantMessageIdRef.current = entry.assistantMessageId;
      }
    },
    [createRuntimeState, scheduleProjection, cancelPendingProjection],
  );

  /**
   * ★ M07 内存管理三道闸门（opportunistic 清扫，切换会话/终态事件/列表变化时执行）：
   *   1. 运行态永不驱逐（conversationRunning===true 条目保留，上界=并发运行会话数）
   *   2. 终态延迟驱逐（terminal && 非活跃 && 距 terminalAt >60s → 删除，终态后 DB 已完整）
   *   3. LRU 硬上限（非运行、非活跃条目按 lastActiveAt 升序淘汰至 ≤12）
   */
  const sweepRuntimeStore = useCallback(() => {
    const store = conversationRuntimeStoreRef.current;
    const activeId = conversationIdRef.current;
    const now = Date.now();
    for (const [id, entry] of Array.from(store.entries())) {
      if (entry.conversationRunning) continue;
      if (id === activeId) continue;
      if (entry.terminal && now - entry.terminalAt > 60_000) {
        store.delete(id);
      }
    }
    const evictable = Array.from(store.entries())
      .filter(([id, entry]) => id !== activeId && !entry.conversationRunning)
      .sort(([, a], [, b]) => a.lastActiveAt - b.lastActiveAt);
    while (evictable.length > 12) {
      const [id] = evictable.shift() as [string, ConversationRuntimeState];
      store.delete(id);
    }
  }, []);

  // 同步 conversationId 到 ref
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  // 加载对话列表
  const loadConversations = useCallback(async () => {
    try {
      if (window.electronAPI) {
        const list = await window.electronAPI.conversations.list();
        setConversations(list);
      }
    } catch (err) {
      console.error('[useChat] 加载对话列表失败:', err);
    }
  }, []);

  // 创建对话
  // ★ M2/T1/T3 修复（一个对话一个 is_running 标志位）：
  // - 在途标记：await conv:create 返回前 creatingConversation=true，重复触发直接返回 null，
  //   防止双击“新建对话”产生两个会话；
  // - 删除原“全局清空 pendingConversationSendIds / sendingConversationIds 两 Set”的副作用：
  //   A 会话运行中创建 B 时，该全局清空会把 A（乃至全部会话）的 per-conversation 发送守卫
  //   一次性抹掉（前端全局标志位问题）。守卫 Set 中的每个会话条目只能由该会话自身的
  //   终态事件清理（chat:done / chat:error / chat:aborted 处理器，均已按 conversationId
  //   精确移除），禁止任何跨会话全局清空；
  // - 失败反馈：创建失败经 messageApi 提示并返回 null。
  const createConversation = useCallback(async () => {
    if (creatingConversationRef.current) return null; // 在途去重（同步 ref，拦 await 前的连击）
    creatingConversationRef.current = true;
    setCreatingConversation(true);
    try {
      if (window.electronAPI) {
        const conv = await window.electronAPI.conversations.create();
        setConversations((prev) => [conv, ...prev]);
        // ★ P1-C2：创建后加入 skip 集合
        //   下次 setConversationId 触发 useEffect 加载时跳过（避免刚创建就重复加载空消息）
        //   对齐 E:\ai_fr chat-shell.tsx L1183 skipConversationLoadIdsRef.current.add(data.conversation.id)
        if (conv && conv.id) {
          skipConversationLoadIdsRef.current.add(conv.id);
          completedToolCallIdsRef.current.clear();
          conversationIdRef.current = conv.id;
          stickToBottomRef.current = true;
          setConversationId(conv.id);
          // ★ 修复 2（增强）：新对话没有消息，不清空 messages
          //   同时为该会话建立空的 per-conversation 运行态条目
          setMessages([]);
          // setToolSnapshots 不再清空（累积所有对话的快照）
          // ★ M06：职责由 per-conversation 运行态条目承载（新建空 entry 替代 Map 写入）
          conversationRuntimeStoreRef.current.set(conv.id, createRuntimeState(conv.id));
          assistantMessageIdRef.current = null;
          setShowScrollToBottom(false);
          // ★ T3 修复：原 setPendingConversationSendIds(new Set()) +
          //   setSendingConversationIds(new Set()) 的全局清空副作用已删除——
          //   per-conversation 守卫仅由该会话自身终态事件清理
          //  （chat:done / chat:error / chat:aborted），禁止跨会话全局清空
          setError(null);
        }
        return conv;
      }
    } catch (err) {
      console.error('[useChat] 创建对话失败:', err);
      messageApiRef.current?.error('创建会话失败，请重试');
      return null;
    } finally {
      creatingConversationRef.current = false;
      setCreatingConversation(false);
    }
    return null;
  }, [createRuntimeState]);

  // 删除对话
  const deleteConversation = useCallback(async (id: string) => {
    try {
      if (window.electronAPI) {
        await window.electronAPI.conversations.delete(id);
        setConversations((prev) => prev.filter((c) => c.id !== id));
        // ★ M07：显式删除该会话的运行态存储条目（防泄漏）
        conversationRuntimeStoreRef.current.delete(id);
        setToolSnapshots((prev) => {
          const filtered: Record<string, any> = {};
          for (const [callId, snap] of Object.entries(prev)) {
            if ((snap as any).conversationId !== id) {
              filtered[callId] = snap;
            }
          }
          return filtered;
        });
        if (conversationIdRef.current === id) {
          setConversationId(null);
          setMessages([]);
        }
      }
    } catch (err) {
      console.error('[useChat] 删除对话失败:', err);
    }
  }, []);

  // ============================================================
  // 方向3：重命名 + 标签（乐观更新 + IPC；electron.d.ts 类型墙用局部断言，方向4同款）
  // ============================================================

  /** conv 组扩展 API（preload 已暴露，electron.d.ts 声明文件在白名单外未同步） */
  const convExtApi = (window.electronAPI?.conversations ?? {}) as Partial<{
    rename: (params: { id: string; title: string }) =>
      Promise<(ConversationListItem & { tags?: string[] }) | null>;
    removeTag: (params: { id: string; tag: string }) =>
      Promise<(ConversationListItem & { tags?: string[] }) | null>;
  }>;

  /** 重命名对话：乐观更新标题 + manual 标志（立即丢弃后到的 generated），失败回滚为重拉列表 */
  const renameConversation = useCallback(
    async (id: string, title: string): Promise<boolean> => {
      const trimmed = title.trim();
      if (!trimmed || !convExtApi.rename) {
        return false;
      }
      manualRenamedConversationIdsRef.current.add(id);
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c)),
      );
      try {
        const updated = await convExtApi.rename({ id, title: trimmed });
        if (updated) {
          setConversations((prev) =>
            prev.map((c) => (c.id === id ? { ...c, title: updated.title, tags: updated.tags ?? c.tags } : c)),
          );
        }
        return true;
      } catch (err) {
        console.error('[useChat] 重命名对话失败:', err);
        manualRenamedConversationIdsRef.current.delete(id);
        await loadConversations();
        return false;
      }
    },
    [loadConversations],
  );

  /** 移除标签：乐观移除，失败回滚为重拉列表 */
  const removeConversationTag = useCallback(
    async (id: string, tag: string): Promise<boolean> => {
      const trimmed = tag.trim();
      if (!trimmed || !convExtApi.removeTag) {
        return false;
      }
      setConversations((prev) =>
        prev.map((c) =>
          c.id === id ? { ...c, tags: (c.tags ?? []).filter((t) => t !== trimmed) } : c,
        ),
      );
      try {
        const updated = await convExtApi.removeTag({ id, tag: trimmed });
        if (updated) {
          setConversations((prev) =>
            prev.map((c) => (c.id === id ? { ...c, tags: updated.tags ?? c.tags } : c)),
          );
        }
        return true;
      } catch (err) {
        console.error('[useChat] 移除标签失败:', err);
        await loadConversations();
        return false;
      }
    },
    [loadConversations],
  );

  // ============================================================
  // Phase 3 P1 + P3 适配层：会话发送状态 helpers
  // ============================================================

  /**
   * 判断指定会话是否在发送中（P3-1 守卫 3）
   * 对齐 E:\ai_fr isConversationSending
   */
  const isConversationSending = useCallback(
    (id: string | null | undefined): boolean => {
      return Boolean(id && sendingConversationIds.has(id));
    },
    [sendingConversationIds],
  );
  /**
   * 判断指定会话是否在流式响应中（P0-1 per-conversation streaming）
   */
  const isConversationStreaming = useCallback(
    (id: string | null | undefined): boolean => {
      return Boolean(id && streamingConversationIds.has(id));
    },
    [streamingConversationIds],
  );

  /**
   * 设置指定会话的流式状态（P0-1 per-conversation streaming）
   */
  const setConversationStreaming = useCallback((id: string, streaming: boolean) => {
    setStreamingConversationIds((prev) => {
      const next = new Set(prev);
      if (streaming) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  /**
   * 判断指定会话是否在等待发送（P0-3 per-conversation pending send）
   */
  const isConversationPendingSend = useCallback(
    (id: string | null | undefined): boolean => {
      return Boolean(id && pendingConversationSendIds.has(id));
    },
    [pendingConversationSendIds],
  );

  /**
   * 设置指定会话的等待发送状态（P0-3 per-conversation pending send）
   */
  const setConversationPendingSend = useCallback((id: string, pending: boolean) => {
    setPendingConversationSendIds((prev) => {
      const next = new Set(prev);
      if (pending) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);


  /**
   * 判断指定会话是否在运行（P3-1 守卫 5）
   * 对齐 E:\ai_fr isConversationRunning（基于 conversations[i].isRunning）
   */
  const isConversationRunning = useCallback(
    (id: string | null | undefined): boolean => {
      if (!id) return false;
      return conversations.some((c) => c.id === id && c.isRunning);
    },
    [conversations],
  );

  /**
   * 设置指定会话的发送状态（true=加入集合，false=移出集合）
   */
  const setConversationSending = useCallback((id: string, sending: boolean) => {
    setSendingConversationIds((prev) => {
      const next = new Set(prev);
      if (sending) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  // 加载对话历史消息
  const loadConversationMessages = useCallback(
    async (id: string, options?: { silent?: boolean; suppressActiveRunResume?: boolean }) => {
      // ★ P1-C2：串行化序号自增，响应回来时检查是否过期
      // 对齐 E:\ai_fr chat-shell.tsx L1130 loadSeq = ++conversationLoadSeqRef.current
      const loadSeq = ++conversationLoadSeqRef.current;
      // ★ 对齐 ai_fr：非静默加载时立即开启 messageLoading 过渡态
      // 对齐 E:\ai_fr chat-shell.tsx L1133 if (!options?.silent) setMessageLoading(true)
      if (!options?.silent) setMessageLoading(true);
      try {
        if (window.electronAPI) {
          // ★ S4（M5）恢复单源：conv:get-messages 收敛 { messages }
          //   （对齐 ai_fr [id]/route.ts:100-118；executorTasks/snapshotTaskIds 字段随表摘除删除，
          //   运行中快照统一走 conv:get-running-snapshots 轻量查询）
          const result = (await window.electronAPI.conversations.getMessages(id)) as
            | {
                messages: ChatMessage[];
              }
            | ChatMessage[];
          const msgs: ChatMessage[] = Array.isArray(result)
            ? result
            : (result.messages || []);
          // P1-C2：若 loadSeq 不是最新序号（已被新请求覆盖），丢弃本次响应
          if (loadSeq !== conversationLoadSeqRef.current) {
            return;
          }
          // ★ M05：守卫语义放宽——响应总是写入 store[id]（对账数据不因在途切走而丢，
          //   见下方 store 写入分支）；仅活跃投影受 conversationIdRef 守卫
          const completedToolCallIds = collectCompletedToolCallIds(msgs);

          // ★ S4（M5）：hasActiveRun 收敛为仅 loading assistant（running 委派任务源随表摘除，
          //   过渡态由 conv:get-running-snapshots 轻量查询恢复，对齐 ai_fr 单源模型）
          const hasActiveRun = msgs.some(
            (message) => message.role === 'assistant' && message.status === 'loading',
          );

          // ★ 修复（手动取消 loading 复活/挂起）：手动取消后主进程 runMainAgent 异步退出前，
          //   runningAssistantMessages 中 status='loading' 的陈旧消息仍会被 conv:get-messages
          //   附加返回；原逻辑无条件按 hasActiveRun 复活 streaming/sending，导致取消后 loading
          //   重新出现且无后续事件收口（长时间挂起）。
          //   守卫 1：chat:aborted 触发的重载（suppressActiveRunResume=true）强制不复活，
          //           防 conversationsRef 渲染期镜像滞后导致守卫失效；
          //   守卫 2：仅当会话列表权威态 isRunning=true 时才恢复（主进程 chat:abort 已先于
          //           chat:aborted 将 isRunning 置 false 并推送 conversation:updated）。
          const resumeActiveRun = hasActiveRun
            && !options?.suppressActiveRunResume
            && Boolean(conversationsRef.current.find((c) => c.id === id)?.isRunning);
          // ★ 修复配套：权威态非运行（取消竞态窗口）时，将陈旧 loading assistant 消息归一化
          //   为 abort，防止消息气泡复现 loading（语义对齐 markRunningMessagesAbortedInList）
          const finalMsgs = hasActiveRun && !resumeActiveRun
            ? msgs.map((message) =>
                message.role === 'assistant' && message.status === 'loading'
                  ? { ...message, status: 'abort' as const }
                  : message,
              )
            : msgs;

          setConversationStreaming(id, resumeActiveRun);
          setConversationSending(id, resumeActiveRun);

          // ★ M05 store 化：结果总是写入 store[id]（messages 基座=DB 权威，
          //   conv:get-messages 已附加 runningAssistantMessages 运行态）
          const storeEntry = conversationRuntimeStoreRef.current.get(id) ?? createRuntimeState(id);
          storeEntry.messages = finalMsgs;
          storeEntry.completedToolCallIds = completedToolCallIds;
          storeEntry.assistantMessageId = resolveActiveAssistantMessageId(finalMsgs);
          storeEntry.conversationRunning = resumeActiveRun;
          storeEntry.lastActiveAt = Date.now();

          // ★ S4（M5/M6）恢复单源：运行中快照恢复统一走 conv:get-running-snapshots 三字段轻量查询
          //   （thinking→思考内容、latestToolCallText→工具调用文案）；store 存量快照保持
          //   live-wins 不清除（内存实时态优先，防闪回）
          conversationRuntimeStoreRef.current.set(id, storeEntry);

          // ★ M05：仅当仍活跃时镜像投影
          if (conversationIdRef.current === id) {
            setMessages(finalMsgs);
            setToolSnapshots(storeEntry.toolSnapshots);
            completedToolCallIdsRef.current = completedToolCallIds;
            assistantMessageIdRef.current = resolveActiveAssistantMessageId(finalMsgs);
          }

          // ★ M20：会话运行中时 fire-and-forget 补一轮轻量查询（切回/激活对账自动恢复运行中快照）
          if (resumeActiveRun) void fetchRunningSnapshots(id).catch(() => undefined);
        }
      } catch (err) {
        console.error('[useChat] 加载对话消息失败:', err);
      } finally {
        // ★ 对齐 ai_fr：finally 块确保 loading 状态必然关闭
        // 仅当活跃会话未变 + 非静默模式时才关闭，避免覆盖后续加载的 loading 状态
        // 对齐 E:\ai_fr chat-shell.tsx L1169-1170
        if (conversationIdRef.current === id && !options?.silent) {
          setMessageLoading(false);
        }
      }
    },
    [setConversationSending, createRuntimeState],
  );

  /** M21 轻量快照查询消费：invoke conv:get-running-snapshots → 三字段 { toolCallId, thinking, latestToolCallText }
   *  → 恢复 → store upsert + 活跃投影。仅更新 toolSnapshots（局部），不触碰 messages（无全量更新）。 */
  const fetchRunningSnapshots = useCallback(async (id: string) => {
    if (!window.electronAPI) return;
    const entries = (await window.electronAPI.conversations.getRunningSnapshots(id)) as
      Array<{ toolCallId: string; thinking: string; latestToolCallText: string; taskName: string }> | undefined;
    if (!Array.isArray(entries) || entries.length === 0) return;   // 空快照：不做任何处理（裁决④）
    applyConversationEvent(id, (entry) => {
      const next = { ...entry.toolSnapshots };
      for (const item of entries) {
        const toolCallId = item?.toolCallId;
        if (!toolCallId || entry.completedToolCallIds.has(toolCallId)) continue;  // 已收口键不复活
        const updatedAt = new Date().toISOString();
        next[toolCallId] = next[toolCallId]
          ? {
              ...next[toolCallId],
              thinking: item.thinking,
              lastContent: item.latestToolCallText,
              lastType: item.latestToolCallText ? 'tool-progress' : 'thinking',
              ...(item.taskName ? { name: item.taskName } : {}),   // 任务名非空才补写 name，空串不覆盖已有值
              updatedAt,
            }
          : {
              conversationId: id,
              taskId: toolCallId,
              callId: toolCallId,
              status: 'running',
              toolCalls: [],
              thinking: item.thinking,
              name: item.taskName,
              lastContent: item.latestToolCallText,
              lastType: item.latestToolCallText ? 'tool-progress' : 'thinking',
              createdAt: updatedAt,
              updatedAt,
              source: 'executor',
            };
      }
      entry.toolSnapshots = next;
    });
  }, []);

  // 切换对话
  // ★ M04 多会话隔离改造：store 即时水合 + 切回即 silent 权威对账（不依赖窗口 focus）。
  //   废弃旧三步清理（completedToolCallIdsRef.clear / setToolSnapshots({}) / pending+sending 全清）——
  //   清空/全清会抹掉后台会话的运行态与发送守卫（多会话并行下为破坏性副作用）；
  //   pending/sending 本就是 per-conversation Set，仅依赖终态事件的 per-conversation 清理。
  const switchConversation = useCallback(
    (id: string | null) => {
      // ★ P0-A：切会话即取消 pending 节流投影（旧会话数据已在 store，切回即时水合）
      cancelPendingProjection();
      // 步骤 1：重置粘底滚动开关 + 隐藏"滚动到底部"按钮（视图瞬态，原语义保留）
      stickToBottomRef.current = true;
      setShowScrollToBottom(false);

      setConversationId(id);
      conversationIdRef.current = id;
      setError(null);

      const entry = id ? conversationRuntimeStoreRef.current.get(id) : undefined;
      if (id && entry) {
        // ★ 即时水合：以 store（后台持续累积的实时态）渲染，零清空、零闪烁
        setMessages(entry.messages);
        setToolSnapshots(entry.toolSnapshots);
        completedToolCallIdsRef.current = entry.completedToolCallIds;
        assistantMessageIdRef.current = entry.assistantMessageId;
        entry.lastActiveAt = Date.now();
        // ★ 切回即 silent 终态对账（不依赖 focus；与激活对账经 loadSeq 串行化天然幂等）
        void loadConversationMessages(id, { silent: true });
      } else if (id) {
        // 无 store（首访/重启后）：保持原非静默加载
        setMessages([]);
        setToolSnapshots({});
        completedToolCallIdsRef.current = new Set();
        assistantMessageIdRef.current = null;
        void loadConversationMessages(id);
      } else {
        // id=null 列表态
        setMessages([]);
        setToolSnapshots({});
        completedToolCallIdsRef.current = new Set();
        assistantMessageIdRef.current = null;
      }
      // ★ M07：切换时机 opportunistic 驱逐（运行态不驱逐/终态60s/LRU12）
      sweepRuntimeStore();
    },
    [loadConversationMessages, sweepRuntimeStore, cancelPendingProjection],
  );

  // ============================================================
  // Phase 3 P1-C2 silentConversationReload + 200ms 节流函数
  // 对齐 E:\ai_fr chat-shell.tsx L1016-1071 + L882-892
  // ============================================================

  /**
   * P1-C2 200ms 节流清理函数
   * 对齐 E:\ai_fr chat-shell.tsx L878-881 clearConversationNavigationReloadTimeout
   */
  const clearConversationNavigationReloadTimeout = useCallback(() => {
    if (scheduleConversationNavigationReloadTimeoutRef.current !== null) {
      window.clearTimeout(scheduleConversationNavigationReloadTimeoutRef.current);
      scheduleConversationNavigationReloadTimeoutRef.current = null;
    }
  }, []);

  /**
   * P1-C2 200ms 节流调度函数
   * 200ms 内合并多次"重新加载会话列表"请求
   * 对齐 E:\ai_fr chat-shell.tsx L883-891 scheduleConversationNavigationReload
   * - 清空旧定时器
   * - 设置 200ms 后调 loadConversations
   */
  const scheduleConversationNavigationReload = useCallback(() => {
    clearConversationNavigationReloadTimeout();
    scheduleConversationNavigationReloadTimeoutRef.current = window.setTimeout(() => {
      scheduleConversationNavigationReloadTimeoutRef.current = null;
      void loadConversations();
    }, 200);
  }, [clearConversationNavigationReloadTimeout, loadConversations]);

  // 发送消息
  // ============================================================
  // P5 改造：sendMessage 不再依赖整体 files 数组提交方式
  // - 入参 attachments: SendAttachment[]（来自 file:upload 已落盘的元数据）
  // - IPC chat:send 时只传 { id?, name, size, contentType, storageKey }（无 data 字段）
  // - 主进程通过 storageKey 从磁盘读取已上传文件
  // ============================================================
  const sendMessage = useCallback(
    async (
      text: string,
      attachments: SendAttachment[] = [],
      targetConversationId?: string | null,
    ) => {
      const trimmed = text.trim();
      // ============================================================
      // Phase 3 P3-1 发送五重守卫（任一不满足则静默 return）
      // ============================================================
      // 守卫 1：hasText（trim 后非空）或 hasAttachments（已有附件）
      const hasText = trimmed.length > 0;
      const hasAttachments = attachments.length > 0;
      if (!hasText && !hasAttachments) return;
      // 守卫 2：!isConversationPendingSend(activeConversationId)（P0-3 per-conversation）
      // ★ M1：目标会话显式传入优先（ChatShell 在任何 await 前捕获的会话 ID）；
      //   未传时回退 conversationIdRef.current（既有语义）。五重守卫一律按该目标会话 ID
      //   判定，B 的发送不会被 A 的运行状态拦截，A 的运行也不会被 B 误中止。
      const activeConvId = targetConversationId ?? conversationIdRef.current;
      if (isConversationPendingSend(activeConvId) || (activeConvId ? pendingSendRef.current.has(activeConvId) : false)) return;
      // 守卫 3：!isConversationSending(activeConversationId)
      if (isConversationSending(activeConvId)) return;
      // 守卫 5：!isConversationRunning(activeConversationId)
      if (isConversationRunning(activeConvId)) return;

      // P0-3：convId 提前声明，用于 per-conversation pending/streaming 状态设置
      // ★ M1：convId 与守卫同源（目标会话 ID），消除 await 期间 ref 漂移导致的错投递
      let convId: string | null = activeConvId;

      setError(null);
      if (convId) {
        setConversationPendingSend(convId, true);
        pendingSendRef.current.add(convId);
      }
      // ============================================================
      // Phase 3 P3-3 用户主动发送：强制粘底滚动 + 隐藏向下箭头按钮
      // 对位 ai_fr sendMessage 起始处的第 4 处 setShowScrollToBottom(false)
      // ============================================================
      stickToBottomRef.current = true;
      setShowScrollToBottom(false);

      try {
        // 确保有对话
        if (!convId) {
          const conv = await createConversation();
          if (!conv) {
            throw new Error('创建对话失败');
          }
          convId = conv.id;
          setConversationId(convId);
        }

        // 添加用户消息（status='local' 本地乐观插入，P1-1）
        // ★ P6 历史消息附件回显：本地乐观 user 消息携带 attachments（来自 useFileUpload.pendingFiles）
        //   待 chat:user-message-created 事件回传后由替换为权威 serverMsg（保持 attachments）
        const userMsgId = nextMessageId();
        const userMsg: ChatMessage = {
          id: userMsgId,
          role: 'user',
          content: buildLocalUserDisplayText(text, attachments),
          // ★ P6：直接携带 SendAttachment→ChatAttachment,渲染器按 attachments 字段渲染图片缩略图/文件条
          ...(attachments.length > 0
            ? {
                attachments: attachments.map((att) => ({
                  id: att.id ?? '',
                  name: att.name,
                  size: att.size,
                  contentType: att.contentType,
                  storageKey: att.storageKey,
                  uploadedAt: new Date().toISOString(),
                })),
              }
            : {}),
          status: 'local',
          createdAt: new Date().toISOString(),
        };
        // 添加助手占位消息
        const assistantMsgId = nextMessageId();
        const assistantMsg: ChatMessage = {
          id: assistantMsgId,
          role: 'assistant',
          content: '',
          thinking: '',
          toolCalls: [],
          status: 'loading',
          createdAt: new Date().toISOString(),
        };
        // ★ M06+M02：乐观消息与目标 id 经路由器写入 per-conversation 运行态存储
        //   （目标 id 写入 entry；活跃时镜像投影，行为不变）
        if (convId) {
          applyConversationEvent(convId, (entry) => {
            entry.messages = [...entry.messages, userMsg, assistantMsg];
            entry.assistantMessageId = assistantMsgId;
            entry.conversationRunning = true;
            entry.terminal = false;
            entry.terminalAt = 0;
          });
        } else {
          setMessages((prev) => [...prev, userMsg, assistantMsg]);
        }
        assistantMessageIdRef.current = assistantMsgId;

        setConversationStreaming(convId!, true);
        if (convId) {
          setConversationSending(convId, true);
          setConversationPendingSend(convId, false);
          pendingSendRef.current.delete(convId);
        }

        // 通过 IPC 发送消息
        // P5 改造：只传 storageKey 元数据，主进程从磁盘读取已上传文件
        if (window.electronAPI && convId) {
          await window.electronAPI.chat.send({
            conversationId: convId,
            message: trimmed,
            assistantMessageId: assistantMsgId,
            files: attachments.map((att) => ({
              id: att.id,
              name: att.name,
              size: att.size,
              contentType: att.contentType,
              storageKey: att.storageKey,
            })),
          });
        }
        // ★ P0 修复 D1：移除 sendMessage 末尾的提前重置
        // 守卫状态（pendingConversationSend / sendingConversationIds）由流式结束事件统一清理
        // - chat:done → unsubDone 中清理
        // - chat:error → unsubError 中清理
        // - chat:aborted → unsubAborted 中清理
        // 避免在流式还在进行时守卫过早重置导致守卫失效
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // ★ M1：主进程 chat:send 并发拒绝错误码（ERR_CONVERSATION_RUNNING='CONVERSATION_RUNNING'，
        //   ipc-handlers.ts:301 throw new Error(ERR_CONVERSATION_RUNNING)）翻译为中文提示
        const friendlyErrMsg = errMsg.includes('CONVERSATION_RUNNING')
          ? '该会话正在回复中，请等待完成或先停止后再发送'
          : errMsg;
        setError(friendlyErrMsg);
        if (convId) {
          setConversationStreaming(convId, false);
          setConversationPendingSend(convId, false);
          pendingSendRef.current.delete(convId);
          setConversationSending(convId, false);
        }
        // ★ 修复 #3：sendMessage catch 块归一化消息状态
        //   对齐 ai_fr sendMessage catch 中的 markLatestAssistant('error')
        //   IPC.chat.send() 抛错时不会触发 chat:error 事件（chat:error 仅在流式过程中触发）
        //   因此 catch 块需自行把已经 push 的 loading 消息归一化为 abort
        setMessages((prev) => markRunningMessagesAbortedInList(prev));
        setToolSnapshots((prev) => markRunningToolSnapshotsAbortedInList(prev));
      }
    },
    [
      isConversationPendingSend,
      isConversationSending,
      isConversationRunning,
      createConversation,
      setConversationSending,
    ],
  );

  // 中止对话
  // ★ M3：可选 targetConversationId 显式绑定目标会话（停止按钮身份锚定，防漂移误中止他话）；
  //   未传时回退 conversationIdRef.current（当前活跃会话，原有语义）
  const abortChat = useCallback((targetConversationId?: string | null) => {
    const convId = targetConversationId ?? conversationIdRef.current;
    if (convId) {
      try {
        if (window.electronAPI) {
          window.electronAPI.chat.abort(convId);
        }
      } catch (err) {
        console.error('[useChat] 中止失败:', err);
      }
    }
    // ============================================================
    // Phase 3 P1-3 abort 归一化：status='loading' → 'abort'，
    // tool 空 result → '已取消。'
    // ★ M19 多会话契约收敛：归一化经 applyConversationEvent 显式作用于当前活跃会话 entry
    //   （活跃投影由路由器镜像）。多会话契约：停止按钮只中止当前活跃会话，其他会话运行
    //   不受影响（chat.abort 本就 per-conversation 定向：主进程 abortConversationRun 按
    //   conversationId 索引 AbortController，ipc-handlers chat:abort 实证）
    // ============================================================
    if (convId) {
      applyConversationEvent(convId, (entry) => {
        entry.assistantMessageId = null;
        entry.messages = markRunningMessagesAbortedInList(entry.messages);
        entry.toolSnapshots = markRunningToolSnapshotsAbortedInList(entry.toolSnapshots);
      });
    } else {
      setMessages((prev) => markRunningMessagesAbortedInList(prev));
      setToolSnapshots((prev) => markRunningToolSnapshotsAbortedInList(prev));
      assistantMessageIdRef.current = null;
    }
    if (convId) {
      setConversationStreaming(convId, false);
      setConversationPendingSend(convId, false);
      setConversationSending(convId, false);
    }
  }, [setConversationSending, applyConversationEvent]);

  // ============================================================
  // IPC 事件订阅
  // ============================================================

  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }

    const cleanups: Array<() => void> = [];

    // chat:thinking → 思考内容
    // ★ F6：优先使用后端发来的完整 segments + thinking，delta 仅作兜底
    //   对齐 E:\ai_fr SSE assistant.message.snapshot 载荷（完整 payload）
    //   避免切回会话后只追加切换后新 delta，丢失切换前累积的 segments
    // P02: 订阅回调体逐字搬入 handleThinkingEvent（校验+applyConversationEvent 块，F6/M13 语义零改动）
    const handleThinkingEvent = (data: ThinkingPayload) => {
      // ★ M02 多会话隔离：按 conversationId 路由到运行态存储（非活跃会话事件不再丢弃）
      if (!data || !data.conversationId) return;

      applyConversationEvent(data.conversationId, (entry) => {
        // ★ M06：目标 id 查找由 Map 迁移至 per-conversation 运行态条目
        const targetId = entry.assistantMessageId;
        if (!targetId) return;
        const next = [...entry.messages];
        const targetIdx = next.findIndex((m) => m.id === targetId);
        if (targetIdx === -1) return;

        // ★ M13 矫正事件②配套：segments 为空但携带全量 thinking 时整体覆盖
        //   （重试复位矫正事件 delta=''、segments 可能为空数组，thinking 为基线全量；
        //     正常 F2 事件 segments 非空走下方分支，旧后端 delta 兜底事件无 thinking 不受影响）
        if ((!Array.isArray(data.segments) || data.segments.length === 0)
            && typeof data.thinking === 'string') {
          next[targetIdx] = {
            ...next[targetIdx],
            thinking: data.thinking,
            status: 'loading',
          };
          entry.messages = next;
          return;
        }

        // ★ 优先使用后端发来的完整 segments + thinking（来自 F2/F3 后端累积）
        //   data.segments 来自 main-agent.ts F2 emit，含完整分段结构
        if (Array.isArray(data.segments) && data.segments.length > 0) {
          next[targetIdx] = {
            ...next[targetIdx],
            thinking: typeof data.thinking === 'string' ? data.thinking : next[targetIdx].thinking,
            segments: data.segments.map((segment) => ({ ...segment })),  // 深拷贝避免引用共享
            status: 'loading',
          };
          entry.messages = next;
          return;
        }

        // 兜底：仅用 delta 重建（向后兼容旧后端 / 历史未升级用户）
        const thinkingDelta = data.delta || '';
        // ★ 推理文本处理：前端流式累积 message.segments
        //   对齐 E:\ai_fr openai.ts appendReasoningSegment 行为
        //   若最后一段已是 reasoning，则将 delta 追加到该段 text；否则新建一条 reasoning 段
        //   segments 字段被 ChatMessageContent 用于 Think 组件按段折叠展开
        const existingSegments = next[targetIdx].segments || [];
        const updatedSegments: AssistantMessageSegment[] = existingSegments.length
          ? [...existingSegments]
          : [];
        const lastSegment = updatedSegments[updatedSegments.length - 1];
        if (lastSegment && lastSegment.type === 'reasoning') {
          lastSegment.text = (lastSegment.text || '') + thinkingDelta;
        } else {
          updatedSegments.push({
            id: crypto.randomUUID(),
            type: 'reasoning',
            text: thinkingDelta,
          });
        }
        next[targetIdx] = {
          ...next[targetIdx],
          thinking: (next[targetIdx].thinking || '') + thinkingDelta,
          segments: updatedSegments,
          status: 'loading',
        };
        entry.messages = next;
      }, { projection: 'deferred' });
    };
    // ★ P02 渲染端合帧（保守档）：在订阅回调与 applyConversationEvent 路由器之间插入合帧器。
    //   仅幂等全量事件（F2 segments 全量 / M13 thinking 全量覆盖）入桶 last-wins 合并至 rAF 窗口
    //   （~16.7ms）再应用，渲染端 apply 频率从事件到达频率（一轮 905 增量）降至 ≤帧率；
    //   纯 delta 兜底事件（旧协议无全量字段）同步透传，顺序与语义保持。
    //   路由器仍是唯一状态入口（L899 语义零改动）；多会话按 conversationId 分桶互不阻塞（M02 保持）。
    const thinkingMerger = createThinkingEventMerger<ThinkingPayload>(
      (d) => `${d.conversationId}|chat-thinking`,
      (d) => (Array.isArray(d.segments) && d.segments.length > 0) || typeof d.thinking === 'string',
      handleThinkingEvent,
    );
    const unsubThinking = window.electronAPI.on('chat:thinking', (payload: unknown) => {
      thinkingMerger.push(payload as ThinkingPayload);
    });
    cleanups.push(unsubThinking, () => thinkingMerger.dispose());

    // chat:chunk → 流式文本
    const unsubChunk = window.electronAPI.on('chat:chunk', (payload: unknown) => {
      const data = payload as ChunkPayload;
      // ★ M02 多会话隔离：按 conversationId 路由到运行态存储（非活跃会话事件不再丢弃）
      if (!data || !data.conversationId) return;
      // ★ P0 修复：删除 isThinking 直接 return 的逻辑
      //   reasoning_split 模型下，main-agent 已将 chunk 与 thinking 拆分为两个独立事件
      //   chunk 事件现在只承载 content delta（isThinking 永远为 false）
      //   reasoning 增量由 chat:thinking 事件单独处理（见 L709-L725）
      // ★ Phase 3 P3-7：根据 finishReason 决定 message.status
      //   - 'stop' / 'length': 流正常结束 → status='success'
      //   - 'tool_calls': 流结束是因为工具调用,继续等 chat:tool-call 完成后由 chat:done 设置
      //   - undefined: 流式过程中 → status='loading'
      const nextStatus: ChatMessage['status'] =
        data.finishReason === 'stop' || data.finishReason === 'length'
          ? 'success'
          : 'loading';

      applyConversationEvent(data.conversationId, (entry) => {
        // ★ M06：目标 id 查找由 Map 迁移至 per-conversation 运行态条目
        const targetId = entry.assistantMessageId;

        if (!targetId) return;

        const next = [...entry.messages];
        const targetIdx = next.findIndex((m) => m.id === targetId);
        if (targetIdx === -1) return;
        next[targetIdx] = data.reset
          // ★ M13 矫正事件①分支：重试复位——整体覆盖为基线全量（截断 attempt-1 残留增量）
          ? { ...next[targetIdx], content: data.content ?? '', status: 'loading' as const }
          : {
              ...next[targetIdx],
              content: (next[targetIdx].content || '') + (data.delta || ''),
              status: nextStatus,
            };
        entry.messages = next;
      }, { projection: 'deferred' });
    });
    cleanups.push(unsubChunk);

    // chat:tool-call → 工具调用通知
    const unsubToolCall = window.electronAPI.on('chat:tool-call', (payload: unknown) => {
      const data = payload as ToolCallPayload;
      // ★ M02 多会话隔离：按 conversationId 路由到运行态存储（非活跃会话事件不再丢弃）
      if (!data || !data.conversationId) return;

      applyConversationEvent(data.conversationId, (entry) => {
        // P1 防重复：如果该 callId 已完成，跳过（防止重复创建工具调用消息）
        if (entry.completedToolCallIds.has(data.callId)) return;

        const startedAt = new Date().toISOString();
        const newToolCall: ToolCallInfo = {
          callId: data.callId,
          name: data.name,
          arguments: data.arguments,
          status: 'loading',
          startedAt,
          isDelegatedExecutor: data.isDelegatedExecutor,
        };

        // ★ M06：目标 id 查找由 Map 迁移至 per-conversation 运行态条目
        const targetId = entry.assistantMessageId;
        if (!targetId) return;
        const next = [...entry.messages];
        const targetIdx = next.findIndex((m) => m.id === targetId);
        if (targetIdx === -1) return;
        if ((next[targetIdx].toolCalls || []).some((tc) => tc.callId === data.callId)) {
          return;
        }
        next[targetIdx] = {
          ...next[targetIdx],
          toolCalls: [...(next[targetIdx].toolCalls || []), newToolCall],
          status: 'loading',
        };
        entry.messages = next;
      });
    });
    cleanups.push(unsubToolCall);

    // chat:tool-result → 工具调用结果
    const unsubToolResult = window.electronAPI.on('chat:tool-result', (payload: unknown) => {
      const data = payload as ToolResultPayload;
      // ★ M02 多会话隔离：按 conversationId 路由到运行态存储（非活跃会话事件不再丢弃）
      if (!data || !data.conversationId) return;

      applyConversationEvent(data.conversationId, (entry) => {
        // P1 防重复：如果该 callId 已完成，跳过（防止重复处理工具结果）
        if (entry.completedToolCallIds.has(data.callId)) return;

        const finishedAt = new Date().toISOString();
        // ★ M06：目标 id 查找由 Map 迁移至 per-conversation 运行态条目
        const targetId = entry.assistantMessageId;
        if (targetId) {
          const next = [...entry.messages];
          const targetIdx = next.findIndex((m) => m.id === targetId);
          if (targetIdx !== -1) {
            const toolCalls = (next[targetIdx].toolCalls || []).map((tc) =>
              tc.callId === data.callId
                ? {
                    ...tc,
                    result: data.result,
                    status: data.success ? ('success' as const) : ('error' as const),
                    isError: !data.success,
                    finishedAt,
                  }
                : tc,
            );
            next[targetIdx] = { ...next[targetIdx], toolCalls };
            entry.messages = next;
          }
        }
        entry.toolSnapshots = completeToolSnapshotByDelegateCallId(entry.toolSnapshots, data);
        // P1 防重复：处理完成后记录 callId，防止后续重复处理
        entry.completedToolCallIds.add(data.callId);
      });
    });
    cleanups.push(unsubToolResult);

    // chat:done → 对话完成
    const unsubDone = window.electronAPI.on('chat:done', (payload: unknown) => {
      const data = payload as DonePayload;
      if (!data || !data.conversationId) return;

      // ★ M03 终态分支经路由器对任意会话 entry 生效（后台会话也能正确收口，不再仅活跃会话）
      applyConversationEvent(data.conversationId, (entry) => {
        entry.assistantMessageId = null;
        entry.conversationRunning = false;
        entry.terminal = true;
        entry.terminalAt = Date.now();
        // ★ 关闭所有 loading 状态的 assistant 消息（处理 while 循环多轮迭代）
        const nextMsgs = [...entry.messages];
        for (let idx = 0; idx < nextMsgs.length; idx++) {
          if (nextMsgs[idx].role === 'assistant' && nextMsgs[idx].status === 'loading') {
            nextMsgs[idx] = { ...nextMsgs[idx], status: 'success' };
          }
        }
        entry.messages = nextMsgs;
        // ★ S3（M4）兜底语义收窄：running 快照按 isError 收口（对齐 ai_fr :1910 收口语义）
        //   isError=true → 'failed'，否则 → 'completed'——仍兜底防 IPC 事件丢失或 hung 永久 running
        const nextSnaps = { ...entry.toolSnapshots };
        const finishedAt = new Date().toISOString();
        for (const [taskId, snapshot] of Object.entries(nextSnaps)) {
          if (snapshot.conversationId === data.conversationId && snapshot.status === 'running') {
            nextSnaps[taskId] = {
              ...snapshot,
              status: snapshot.isError ? 'failed' : 'completed',
              finishedAt,
              updatedAt: finishedAt,
            };
          }
        }
        entry.toolSnapshots = nextSnaps;
      });

      // ★ per-conversation 状态清理（不受活跃对话过滤影响）
      setConversationStreaming(data.conversationId, false);
      setConversationSending(data.conversationId, false);
      setConversationPendingSend(data.conversationId, false);

      // ★ 活跃对话才 silent 重载（后台会话无需拉取：DB 已完整，切回时 M04 对账）
      if (data.conversationId === conversationIdRef.current) {
        // ★ 对齐 ai_fr：chat:done 后静默刷新当前会话，从 DB 恢复权威消息/快照状态
        void loadConversationMessages(data.conversationId, { silent: true });
      }
      // ★ M07：终态时机 opportunistic 驱逐
      sweepRuntimeStore();
    });
    cleanups.push(unsubDone);

    // chat:error → 错误通知
    const unsubError = window.electronAPI.on('chat:error', (payload: unknown) => {
      const data = payload as ErrorPayload;
      if (!data || !data.conversationId) return;

      // ★ M03 终态分支经路由器对任意会话 entry 生效（后台会话目标消息也置 error）
      applyConversationEvent(data.conversationId, (entry) => {
        entry.conversationRunning = false;
        entry.terminal = true;
        entry.terminalAt = Date.now();
        // ★ M06：目标 id 查找由 Map 迁移至 per-conversation 运行态条目
        const targetId = entry.assistantMessageId;
        if (targetId) {
          const next = [...entry.messages];
          const targetIdx = next.findIndex((m) => m.id === targetId);
          if (targetIdx !== -1) {
            next[targetIdx] = {
              ...next[targetIdx],
              status: 'error',
              content: next[targetIdx].content || data.error || '发生错误',
            };
            entry.messages = next;
          }
        }
      });

      // ★ 仅活跃对话更新 error 提示状态
      if (data.conversationId === conversationIdRef.current) {
        setError(data.error || '对话出错');
      }

      // ★ per-conversation 状态清理（不受活跃对话过滤影响）
      setConversationStreaming(data.conversationId, false);
      setConversationPendingSend(data.conversationId, false);
      setConversationSending(data.conversationId, false);
      if (data.conversationId === conversationIdRef.current) {
        assistantMessageIdRef.current = null;
      }
      // ★ P1-E2：throw + messageApi.error 路径
      //   对齐 E:\ai_fr chat-shell.tsx L824/867/1167 等多处 messageApi.error(ensureErrorMessage(error))
      //   messageApi 已注入时调用顶部 toast；未注入时退回 setError 显示底部固定错误条
      // ★ BUG-5：恢复用户可见错误提示（原整段被注释导致错误静默，用户误以为还在跑）
      const errMsg = data.error || '对话出错';
      if (messageApiRef.current) {
        messageApiRef.current.error(errMsg);
      }
      // ★ M07：终态时机 opportunistic 驱逐
      sweepRuntimeStore();
    });
    cleanups.push(unsubError);

    // chat:title → 对话标题事件（首轮生成 source=generated / 自定义重命名 source=manual）
    // 对齐 E:\ai_fr conversation.updated 事件：实时更新对话列表中的标题
    // ★ 方向3 A3-4：manual 无条件更新并建立 manual 标志；generated 到达时若该会话
    //   已被 manual 更新过则丢弃（自定义标题最终生效，晚到生成标题不覆盖）
    const unsubTitle = window.electronAPI.on(IPC_CHAT.TITLE, (payload: unknown) => {
      const data = payload as TitlePayload;
      if (!data?.conversationId || !data?.title) return;

      if (data.source === 'manual') {
        manualRenamedConversationIdsRef.current.add(data.conversationId);
      } else if (manualRenamedConversationIdsRef.current.has(data.conversationId)) {
        // 晚到的生成标题：该会话已被自定义更新过 → 丢弃
        return;
      }

      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === data.conversationId);
        if (idx === -1) {
          return prev;
        }
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          title: data.title,
          // generated 入库会刷新 updated_at（现状行为保持）；manual 重命名不动列表排序（A3-5）
          ...(data.source === 'generated' ? { updatedAt: new Date().toISOString() } : {}),
        };
        return next;
      });
    });
    cleanups.push(unsubTitle);

    const unsubConversationUpdated = window.electronAPI.on(
      IPC_CONV.UPDATED,
      (payload: unknown) => {
        const data = payload as ConversationUpdatedPayload;
        const conversation = data?.conversation;
        if (!conversation?.id) return;

        setConversations((prev) => {
          const idx = prev.findIndex((item) => item.id === conversation.id);
          if (idx === -1) {
            return [conversation, ...prev];
          }

          const previousConv = prev[idx];
          const next = [...prev];
          next[idx] = {
            ...previousConv,
            ...conversation,
          };

          return next;
        });
      },
    );
    cleanups.push(unsubConversationUpdated);

    // ============================================================
    // v2.1 M13：executor:snapshot 六字段信号 → 轻量快照查询（conv:get-running-snapshots）
    //   200ms 去抖 + in-flight dirty 补偿 + 非当前对话守卫；只查运行中任务快照，不拉历史 messages
    // ============================================================
    if (typeof window.electronAPI.executor.onSnapshot === 'function') {
      const snapshotQueryState = { dirty: false, timer: null as number | null, inFlight: false };
      const runSnapshotQuery = () => {
        snapshotQueryState.inFlight = true;
        const id = conversationIdRef.current;                 // ★ 每次实时读最新对话 ID
        if (!id) { snapshotQueryState.inFlight = false; return; }
        fetchRunningSnapshots(id)                              // ★ 轻量查询：只查运行中任务快照，不拉历史 messages
          .catch(() => undefined)
          .finally(() => {
            snapshotQueryState.inFlight = false;
            if (snapshotQueryState.dirty) { snapshotQueryState.dirty = false; runSnapshotQuery(); }  // 补偿轮
          });
      };
      const unsubSignal = window.electronAPI.executor.onSnapshot((payload: unknown) => {
        const data = payload as ExecutorSnapshotPayload;    // 六字段信号（规则②）
        if (!data?.conversationId) return;
        if (data.conversationId !== conversationIdRef.current) return;  // ★ 非当前对话不查询（R15/D1③）
        snapshotQueryState.dirty = true;
        if (snapshotQueryState.inFlight) return;
        if (snapshotQueryState.timer !== null) return;
        snapshotQueryState.timer = window.setTimeout(() => {
          snapshotQueryState.timer = null;
          if (snapshotQueryState.dirty) { snapshotQueryState.dirty = false; runSnapshotQuery(); }
        }, 200);
      });
      cleanups.push(unsubSignal, () => { if (snapshotQueryState.timer !== null) window.clearTimeout(snapshotQueryState.timer); });
    }

    // ============================================================
    // Phase 3 P1-1 适配层：chat:user-message-created
    // 已由主进程真实推送（main-agent.ts 对应 emit → ipc-handlers.ts 白名单转发）
    // 收到后将 status='local' 的本地乐观 user 消息替换为服务端真实消息
    // ============================================================
    const unsubUserMessageCreated = window.electronAPI.on(
      IPC_CHAT.USER_MESSAGE_CREATED,
      (payload: unknown) => {
        const data = payload as UserMessageCreatedPayload;
        // ★ M02 多会话隔离：按 conversationId 路由到运行态存储（非活跃会话事件不再丢弃）
        if (!data || !data.message || data.message.role !== 'user') return;
        if (!data.conversationId) return;
        // ★ P6 历史消息附件回显：从主进程 payload 中读取 attachments（持久化在 messages 表的 payload_json）
        //   payloadAttachments 的解析由 main-agent 端把 ChatAttachment[] 写入 data.message.attachments
        const payloadAttachmentsRaw: unknown = (data.message as { attachments?: unknown })
          .attachments;
        const attachments: ChatAttachment[] | undefined = Array.isArray(payloadAttachmentsRaw)
          ? (payloadAttachmentsRaw as ChatAttachment[])
          : undefined;
        const serverMsg: ChatMessage = {
          id: data.message.id,
          role: 'user',
          content: data.message.content,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          status: 'success',
          createdAt: data.message.createdAt,
        };
        applyConversationEvent(data.conversationId, (entry) => {
          entry.messages = replaceLatestLocalUserInList(entry.messages, serverMsg);
        });
      },
    );
    cleanups.push(unsubUserMessageCreated);

    // ============================================================
    // Phase 3 P1-2 适配层：chat:assistant-started/snapshot/done 三态
    // 已由主进程真实推送（main-agent.ts 对应 emit → ipc-handlers.ts 白名单转发）
    // 三态均按 message.id upsert
    // - started: 初始化 assistant 消息（status='loading'）
    // - snapshot: 累积思考 / 工具进度
    // - done: 标记 status='success' 或 'error'
    // ============================================================
    const unsubAssistantStarted = window.electronAPI.on(
      IPC_CHAT.ASSISTANT_STARTED,
      (payload: unknown) => {
        const data = payload as AssistantStartedPayload;
        // ★ M02 多会话隔离：按 conversationId 路由到运行态存储（非活跃会话事件不再丢弃）
        //   ★ M06：assistantMessageId 职责由 entry 承载（先写 entry 再 upsert）
        if (!data || !data.message || data.message.role !== 'assistant' || !data.conversationId) return;
        applyConversationEvent(data.conversationId, (entry) => {
          entry.assistantMessageId = data.message.id;
          entry.conversationRunning = true;
          entry.messages = upsertMessageById(entry.messages, { ...data.message, status: 'loading' });
        });
      },
    );
    cleanups.push(unsubAssistantStarted);

    const unsubAssistantDone = window.electronAPI.on(
      IPC_CHAT.ASSISTANT_DONE,
      (payload: unknown) => {
        const data = payload as AssistantDonePayload;
        // ★ M02 多会话隔离：按 conversationId 路由到运行态存储（非活跃会话事件不再丢弃）
        if (!data || !data.message || data.message.role !== 'assistant') return;
        if (!data.conversationId) return;
        // done 事件：保持后端推送的 status（success / error），若缺省则为 success
        const finalStatus: ChatMessage['status'] =
          data.message.status === 'error' ? 'error' : 'success';
        applyConversationEvent(data.conversationId, (entry) => {
          entry.messages = upsertMessageById(entry.messages, { ...data.message, status: finalStatus });
        });
      },
    );
    cleanups.push(unsubAssistantDone);

    const unsubToolMessageCreated = window.electronAPI.on(
      IPC_CHAT.TOOL_MESSAGE_CREATED,
      (payload: unknown) => {
        const data = payload as ToolMessageCreatedPayload;
        // ★ M02 多会话隔离：按 conversationId 路由到运行态存储（非活跃会话事件不再丢弃）
        if (!data || !data.message || data.message.role !== 'tool') return;
        if (!data.conversationId) return;
        const toolCallId = data.message.toolCall?.callId;
        applyConversationEvent(data.conversationId, (entry) => {
          // ★ M10 合并 store 化：读 entry.toolSnapshots[toolCallId]，命中后把 thinking/progress
          //   并入真实消息并从 entry.toolSnapshots 删除该键；M09 后消息自带 thinking，
          //   优先级保持 data.message.thinking ?? snapshot.thinking ?? ''（双保险任一可用即不丢）
          let mergedMessage = data.message;
          if (toolCallId) {
            entry.completedToolCallIds.add(toolCallId);
            // ★ S4（M6）：字典键已统一为委派 callId，直接按键删除
            const snapshot = entry.toolSnapshots[toolCallId];
            if (snapshot) {
              mergedMessage = {
                ...data.message,
                thinking: data.message.thinking ?? snapshot.thinking ?? '',
                progress: latestToolProgressTextCached(toolCallId, snapshot.lastContent || ''),
              };
              const next = { ...entry.toolSnapshots };
              delete next[toolCallId];
              entry.toolSnapshots = next;
            }
          }
          entry.messages = upsertMessageById(entry.messages, mergedMessage);
        });
      },
    );
    cleanups.push(unsubToolMessageCreated);

    // ============================================================
    // ★ S3（M4）批次完成事件 tool.batch.completed：批内工具调用全部结束
    //   （含全中止批次，主进程在全中止 throw 之前发送）→ 按 isError 收口 running 快照
    //   ★ M02 多会话隔离：按 conversationId 路由到运行态存储（非活跃会话事件不再丢弃）
    // ============================================================
    const unsubToolBatchCompleted = window.electronAPI.on(
      IPC_CHAT.TOOL_BATCH_COMPLETED,
      (payload: unknown) => {
        const data = payload as ToolBatchCompletedPayload;
        if (!data || !data.conversationId) return;
        applyConversationEvent(data.conversationId, (entry) => {
          entry.toolSnapshots = markBatchToolSnapshotsSettled(
            entry.toolSnapshots,
            data.conversationId,
            data.toolCallIds,
          );
        });
      },
    );
    cleanups.push(unsubToolBatchCompleted);

    // ============================================================
    // Phase 3 P1-3 适配层：chat:aborted
    // 已由主进程真实推送（main-agent.ts 对应 emit → ipc-handlers.ts 白名单转发）
    // 收到后统一归一化 loading → abort，tool 空 result → '已取消。'
    // ============================================================
    const unsubAborted = window.electronAPI.on(
      IPC_CHAT.ABORTED,
      (payload: unknown) => {
        const data = payload as AbortedPayload;
        if (!data || !data.conversationId) return;

        // ★ M03 终态分支经路由器对任意会话 entry 生效（后台会话也归一化，不再仅活跃会话）
        applyConversationEvent(data.conversationId, (entry) => {
          entry.assistantMessageId = null;
          entry.conversationRunning = false;
          entry.terminal = true;
          entry.terminalAt = Date.now();
          entry.messages = markRunningMessagesAbortedInList(entry.messages);
          entry.toolSnapshots = markRunningToolSnapshotsAbortedInList(entry.toolSnapshots);
        });

        if (data.conversationId === conversationIdRef.current) {
          // ★ 对齐 ai_fr：取消回复后静默刷新当前会话，从 DB 恢复权威消息/快照状态（仅活跃触发）
          // ★ 修复（手动取消 loading 复活/挂起）：携带 suppressActiveRunResume，防止主进程
          //   runMainAgent 退出前 conv:get-messages 附加的陈旧 loading 消息复活 streaming/sending
          void loadConversationMessages(data.conversationId, {
            silent: true,
            suppressActiveRunResume: true,
          });
        }

        // ★ P0-1/P0-3 per-conversation：总是清理对应对话的 streaming/pending/sending 状态
        setConversationStreaming(data.conversationId, false);
        setConversationSending(data.conversationId, false);
        setConversationPendingSend(data.conversationId, false);
        // ★ M07：终态时机 opportunistic 驱逐
        sweepRuntimeStore();
      },
    );
    cleanups.push(unsubAborted);

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
      // ★ P0-A：卸载清理投影节流定时器（防卸载后 setState）
      if (projectionTimerRef.current !== null) {
        window.clearTimeout(projectionTimerRef.current);
        projectionTimerRef.current = null;
      }
      projectionDirtyRef.current = false;
    };
  }, []);

  // 初始加载对话列表 + v2恢复方案：自动恢复上次活跃对话
  useEffect(() => {
    const init = async () => {
      // 1. 先加载对话列表（确保 switchConversation 时列表已就绪）
      await loadConversations();

      // 2. 获取上次活跃对话ID
      if (window.electronAPI?.conversations?.getRestoreConversationId) {
        try {
          const restoredId = await window.electronAPI.conversations.getRestoreConversationId();
          // 3. 验证对话ID有效性（对话可能已被删除）
          if (restoredId && window.electronAPI) {
            // 重新获取最新列表确认对话存在
            const latestList = await window.electronAPI.conversations.list();
            const conversationExists = latestList.some((c) => c.id === restoredId);
            if (conversationExists) {
              switchConversation(restoredId);
              return; // 恢复成功，跳过后续
            }
          }
        } catch (err) {
          console.warn('[useChat] 恢复对话失败，退化为列表:', err);
        }
      }

      // 4. 无恢复ID或恢复失败 → 场景C退化：显示对话列表
      // conversationId 保持 null，前端自然显示列表
    };

    void init();
  }, [loadConversations, switchConversation]);

  // ============================================================
  // ★ BUG-1：窗口/页面激活对账（visibilitychange + focus 双入口）
  //   IPC 事件丢失/订阅时序空窗导致前端停留旧态时的兜底：激活即对当前活跃会话
  //   做一次幂等对账（严禁无条件全量重载、严禁与 streaming 竞争的直写 setMessages）：
  //   - 消息对账走 loadConversationMessages(id, { silent: true })，复用其内部
  //     P1-C2 loadSeq 串行化 + conversationIdRef 闭包守卫（原有守卫链，不另起炉灶）
  //   - 同步刷新会话列表 loadConversations()（isRunning/updatedAt 指纹来源）
  //   防重复三重去重：
  //   ① 状态指纹：活跃会话列表 isRunning/updatedAt 与上次对账触发时一致 → 跳过
  //   ② 最小间隔节流：距上次对账触发 <2s → 跳过
  //   ③ in-flight 去重：上次激活对账加载未完成 → 跳过
  // ============================================================
  useEffect(() => {
    const ACTIVATION_RECONCILE_MIN_INTERVAL_MS = 2000;
    const reconcileOnActivate = () => {
      const state = activationReconcileStateRef.current;
      // 去重②：激活对账最小间隔节流（≥2s）
      if (Date.now() - state.lastAt < ACTIVATION_RECONCILE_MIN_INTERVAL_MS) return;
      // 去重③：in-flight 去重——同一会话进行中的对账未完成不重复发起
      if (state.inFlight) return;
      const conversationId = conversationIdRef.current;
      // 去重①：状态指纹——活跃会话 isRunning/updatedAt 未变则跳过
      const activeConversation = conversationId
        ? conversationsRef.current.find((c) => c.id === conversationId)
        : undefined;
      const fingerprint = activeConversation
        ? `${conversationId}|${String(activeConversation.isRunning)}|${String(activeConversation.updatedAt)}`
        : 'no-active-conversation';
      if (fingerprint === state.fingerprint) return;
      state.fingerprint = fingerprint;
      state.lastAt = Date.now();
      state.inFlight = true;
      // 会话列表刷新（列表态对账 + 下次激活指纹来源）
      void loadConversations();
      if (!conversationId) {
        state.inFlight = false;
        return;
      }
      // 幂等对账：复用 loadConversationMessages 守卫链（loadSeq 串行化 + conversationIdRef 守卫）
      loadConversationMessages(conversationId, { silent: true })
        .catch(() => undefined)
        .finally(() => {
          activationReconcileStateRef.current.inFlight = false;
        });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') reconcileOnActivate();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', reconcileOnActivate);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', reconcileOnActivate);
    };
  }, [loadConversationMessages, loadConversations]);

  // ============================================================
  // v2.1 M14：10s 兜底轻量快照查询（D4 无条件；裁决④逐字——
  //   相当于再查一次当前快照，若有则更新，没有或空快照就不管（不拉历史））
  // ============================================================
  useEffect(() => {
    const SNAPSHOT_POLL_INTERVAL_MS = 10_000;
    const timer = window.setInterval(() => {
      const id = conversationIdRef.current;        // ★ 每次触发实时读最新对话 ID（切对话后查新不查旧）
      if (!id) return;                              // 无当前对话：不做任何处理
      fetchRunningSnapshots(id).catch(() => undefined);  // ★ 仅再查一次当前对话运行中任务快照
    }, SNAPSHOT_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [fetchRunningSnapshots]);

  // ★ P1-C2：组件卸载时清理 200ms 节流定时器，避免内存泄漏
  useEffect(() => {
    return () => {
      clearConversationNavigationReloadTimeout();
    };
  }, [clearConversationNavigationReloadTimeout]);

  // ============================================================
  // ★ M07 运行态存储内存管理：列表驱动驱逐
  //   会话列表中已不存在的会话 → store 条目驱逐（原 Map LRU 清理的等价迁移）
  //   + 终态 LRU 清扫（sweepRuntimeStore 三道闸门，见定义处）
  // ============================================================
  useEffect(() => {
    const validConvIds = new Set(conversations.map((c) => c.id));
    for (const id of Array.from(conversationRuntimeStoreRef.current.keys())) {
      if (!validConvIds.has(id)) {
        conversationRuntimeStoreRef.current.delete(id);
      }
    }
    sweepRuntimeStore();
  }, [conversations, sweepRuntimeStore]);

  return {
    messages,
    /** ★ 对齐 ai_fr：消息加载过渡态，供 ChatArea 显示 Spin */
    messageLoading,
    conversationId,
    conversations,
    /** ★ P0-1 per-conversation：基于 conversationId 的派生 streaming 状态 */
    isStreaming: Boolean(conversationId && streamingConversationIds.has(conversationId)),
    /** ★ M2/T1：新建会话在途标记（conv:create 未返回期间为 true），供上游锁定发送目标身份 */
    creatingConversation,
    error,
    sendMessage,
    abortChat,
    createConversation,
    deleteConversation,
    switchConversation,
    /** 方向3：重命名 / 标签管理（乐观更新 + conv:rename / conv:tag-* IPC） */
    renameConversation,
    removeConversationTag,
    /** Phase 3 P0-3：子智能体执行中间快照，按 taskId 索引 */
    toolSnapshots,
    /** Phase 3 P1 + P3：守卫 + 状态相关 */
    /** P3-1 守卫 2：是否在等待对话发送结果 */
    /** P3-1 守卫 3 helper：当前活跃会话是否在发送中 */
    isConversationSending,
    /** P3-1 守卫 5 helper：当前活跃会话是否在运行 */
    isConversationRunning,
    /** P3-1 守卫 4：上传中文件数量（当前为 0，预留接口） */
    /** P3-3 步骤 2：是否显示"滚动到底部"按钮 */
    showScrollToBottom,
    setShowScrollToBottom,
    /** P3-3 步骤 1：已完成工具调用 ID 集合 ref */
    /** P3-3 步骤 2 关联：粘底滚动开关 ref */
    stickToBottomRef,
    clearError: () => setError(null),
  };
}
