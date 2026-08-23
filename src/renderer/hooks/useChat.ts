/**
 * useChat Hook
 * IPC事件订阅 + 消息状态管理 + 流式更新
 *
 * 消息流：用户输入 → IPC chat:send → IPC事件回调
 *   (onThinking / onChunk / onToolCall / onToolResult / onDone / onError / onTitle)
 *   → 更新消息状态 → React 重渲染
 *
 * Phase 3 P0 适配层：
 * - P0-1: 订阅 executor:thinking（子智能体 thinking / 工具进度）→ 按 taskId/taskName 聚合到 toolSnapshots
 *         ★ 修复主/子智能体消息混淆：不再写入主消息 toolCalls 字段
 *         旧数据无 source 字段时默认视为主智能体（向后兼容）
 * - P0-3: 订阅 executor:snapshot（子智能体执行中间快照）→ 按 taskId upsert 到 toolSnapshots
 *         buildConversationDisplayState 恢复时优先从快照恢复 in-flight 任务
 *
 * Phase 3 P0-2 适配层（★ 修复主/子智能体消息混淆）：
 * - 订阅 executor:tool-progress（子智能体工具调用进度）→ 按 taskId/callId 聚合到 toolSnapshots.toolCalls
 *   后端 main-agent.ts 的 onToolCall / onToolResult 回调 emit 此事件
 *   payload 含 source='executor' / taskName / 子智能体工具真实 callId
 *   旧数据无 source/taskName 字段时默认视为主智能体（向后兼容）
 *
 * Phase 3 P1 + P3 适配层（后端已接入）：
 * - P1-1: 本地乐观插入 user message（status='local'）+ chat:user-message-created 替换
 * - P1-2: assistant 三态事件（started/snapshot/done）→ 按 id upsert
 * - P1-3: cancel/abort 归一化（markRunningMessagesAborted + markRunningToolSnapshotsAborted）
 *         + chat:aborted 事件统一归一化
 * - P3-1: 发送五重守卫（hasText/pendingConversationSend/isConversationSending/
 *         uploadingCount/isConversationRunning）
 * - P3-2: 空泡过滤（filterEmptyAssistantBubbles）
 * - P3-3: 切换会话三步清理（completedToolCallIdsRef.clear / setToolSnapshots([]) /
 *         stickToBottomRef=true + setShowScrollToBottom(false)）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolCallInfo } from '../components/ToolCallCard';
import type { AssistantMessageSegment } from '../lib/message-filter';
import { latestToolProgressText } from '../lib/executor-thinking';
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
   * ★ 修复主/子智能体消息混淆：委派任务名称（按 taskName 聚合）
   *   后端 main-agent.ts 在 delegate_executor 时从参数解析的 taskname
   *   前端按 taskId 索引的快照中可读取此字段做时间线标题渲染
   */
  taskName?: string;
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
 * 子智能体 thinking / 工具进度推送（Phase 3 P0-1 适配层）
 * - callId：主智能体 delegate_executor 的 id（用于对齐 taskName 来源）
 * - executorCallId（可选）：子智能体工具的真实 callId（修复 callId 语义错位）
 * - source: 消息来源标识，'executor' = 执行子智能体（修复后必带）
 * - taskName: 委派任务名称（如"绘制正弦函数图像"）
 * - type: 'thinking' = 纯思考文本，'tool-progress' = 工具调用前/后进度文本
 * - content: 文本内容
 * ★ 修复主/子智能体消息混淆：旧 IPC listener 收到的 payload 无 source/taskName/executorCallId 字段，
 *   应默认视为主智能体（向后兼容）
 */
interface ExecutorThinkingPayload {
  conversationId: string;
  taskId: string;
  callId?: string;
  /** ★ 修复主/子智能体消息混淆：消息来源标识，可选（向后兼容旧数据无此字段） */
  source?: 'main' | 'executor';
  /** ★ 修复主/子智能体消息混淆：委派任务名称，可选（向后兼容旧数据无此字段） */
  taskName?: string;
  /** ★ 修复主/子智能体消息混淆：子智能体工具的真实 callId（修复 callId 语义错位），可选 */
  executorCallId?: string;
  type: 'thinking' | 'tool-progress';
  content: string;
  /**
   * ★ Phase 3 P3-8 messageId ↔ taskId 关联键
   * 主智能体 assistant 消息 ID
   */
  messageId?: string;
}

/**
 * 子智能体工具进度推送（修复主/子智能体消息混淆）
 * - 后端 main-agent.ts 的 onToolCall / onToolResult 回调 emit 'executor:tool-progress' 事件
 * - 前端 useChat.ts 订阅后按 taskId/taskName 聚合到 toolSnapshots 状态（独立于主消息 toolCalls）
 * - callId：子智能体工具的真实 callId（修复后语义对齐）
 * - source: 消息来源标识，'executor' = 执行子智能体（修复后必带）
 * - taskName: 委派任务名称（与 executor:thinking 一致，供时间线标题渲染）
 * - status: 'calling' = 工具调用开始，'completed' = 成功完成，'failed' = 执行失败
 * ★ 保持向后兼容：旧数据无 source/taskName 字段时默认视为主智能体
 */
interface ExecutorToolProgressPayload {
  conversationId: string;
  taskId: string;
  /** 主智能体 delegate_executor 的外层 callId，用于最终 tool-result 收口 */
  delegateCallId?: string;
  /** 子智能体工具的真实 callId（与 ExecutorThinkingPayload.executorCallId 等价） */
  callId: string;
  name: string;
  /** onToolCall 触发时携带 */
  arguments?: string;
  /** onToolResult 触发时携带 */
  result?: string;
  /** onToolResult 触发时携带 */
  success?: boolean;
  /** 消息来源标识，可选（向后兼容旧数据无此字段） */
  source?: 'main' | 'executor';
  /** 委派任务名称，可选（向后兼容旧数据无此字段） */
  taskName?: string;
  status: 'calling' | 'completed' | 'failed';
  /**
   * ★ Phase 3 P3-8 messageId ↔ taskId 关联键
   * 主智能体 assistant 消息 ID
   */
  messageId?: string;
}

/**
 * 子智能体执行中间快照推送（Phase 3 P0-3 适配层）
 * 与 ToolSnapshot 结构一致
 */
type ExecutorSnapshotPayload = ToolSnapshot;

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
 * 从 StreamMessage.payload 提取 toolCallId（对齐 ai_fr getToolCallIdFromPayload 语义）
 */
function getToolCallIdFromPayload(payload: unknown): string | null {
  if (payload && typeof payload === 'object') {
    const toolCallId = (payload as { toolCallId?: unknown }).toolCallId;
    if (typeof toolCallId === 'string' && toolCallId) {
      return toolCallId;
    }
  }
  return null;
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
  return {
    conversationId,
    taskId,
    callId: message.payload.toolCallId,
    status,
    result: message.payload.result ?? '',
    thinking: message.payload.thinking ?? '',
    isError: isFailed,
    toolCalls: [
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
    ],
    createdAt: startedAt,
    updatedAt: finishedAt ?? startedAt,
    ...(finishedAt ? { finishedAt } : {}),
    source: 'executor',
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
  const targetEntry = entries.find(
    ([, snapshot]) => snapshot.callId === payload.callId,
  ) ?? [...entries].reverse().find(
    ([, snapshot]) =>
      snapshot.status === 'running' &&
      payload.name === 'delegate_executor',
  );

  if (!targetEntry) {
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
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  /** 子智能体执行中间快照（Phase 3 P0-3），按 taskId 索引 */
  const [toolSnapshots, setToolSnapshots] = useState<Record<string, ToolSnapshot>>({});
  /**
   * ★ 消息加载过渡态：切换会话时显示 Spin，避免空白闪烁
   * 对齐 ai_fr chat-shell.tsx L654 messageLoading + setMessageLoading
   */
  const [messageLoading, setMessageLoading] = useState(false);

  const conversationIdRef = useRef<string | null>(null);
  const assistantMessageIdRef = useRef<string | null>(null);
  /**
   * ★ 修复 4：按 conversationId 索引的 assistant message ID Map
   * 解决跨对话切换时 assistantMessageId 丢失 / 污染问题
   * - 切到对话 B 时：从 Map 取出对话 B 的 ID（继续 B 的流式更新）
   * - 切回对话 A 时：从 Map 取出对话 A 的 ID（恢复 A 的流式更新）
   * - 新对话发送消息时：写入 Map
   * 对齐 E:\ai_fr：每个对话独立维护 runningAssistantMessages，
   * 切回时通过 buildConversationDisplayState 恢复
   */
  const assistantMessageIdByConversationRef = useRef<Map<string, string | null>>(
    new Map(),
  );
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
   * P3-1 守卫 4：上传中文件数量
   * 当前本项目仅本地预览无真实上传，预留为 0；后续接 P5 后端真实上传时可与上传生命周期联动
   */
  const [uploadingCount, setUploadingCount] = useState(0);
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
  const createConversation = useCallback(async () => {
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
          //   但清空 assistantMessageIdByConversationRef 中对应的 ID
          setMessages([]);
          // setToolSnapshots 不再清空（累积所有对话的快照）
          assistantMessageIdByConversationRef.current.set(conv.id, null);
          assistantMessageIdRef.current = null;
          setShowScrollToBottom(false);
          setPendingConversationSendIds(new Set());
          setSendingConversationIds(new Set());
          setError(null);
        }
        return conv;
      }
    } catch (err) {
      console.error('[useChat] 创建对话失败:', err);
    }
    return null;
  }, []);

  // 删除对话
  const deleteConversation = useCallback(async (id: string) => {
    try {
      if (window.electronAPI) {
        await window.electronAPI.conversations.delete(id);
        setConversations((prev) => prev.filter((c) => c.id !== id));
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
          // ★ S4（M5）恢复单源：conv:get-messages 收敛 { messages, snapshotMessages }
          //   （对齐 ai_fr [id]/route.ts:100-118；executorTasks/snapshotTaskIds 字段随表摘除删除）
          const result = (await window.electronAPI.conversations.getMessages(id)) as
            | {
                messages: ChatMessage[];
                snapshotMessages?: StreamMessage[];
              }
            | ChatMessage[];
          const msgs: ChatMessage[] = Array.isArray(result)
            ? result
            : (result.messages || []);
          const snapshots: StreamMessage[] = Array.isArray(result)
            ? []
            : (result.snapshotMessages || []);
          // P1-C2：若 loadSeq 不是最新序号（已被新请求覆盖），丢弃本次响应
          if (loadSeq !== conversationLoadSeqRef.current) {
            return;
          }
          // P1-C2：若活跃会话已切换（闭包保护），丢弃本次响应
          if (conversationIdRef.current !== id) {
            return;
          }
          const completedToolCallIds = collectCompletedToolCallIds(msgs);
          completedToolCallIdsRef.current = completedToolCallIds;
          assistantMessageIdRef.current = resolveActiveAssistantMessageId(msgs);

          // ★ S4（M5）：hasActiveRun 收敛为仅 loading assistant（running 委派任务源随表摘除，
          //   过渡态由 snapshotMessages 恢复，对齐 ai_fr 单源模型）
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

          setMessages(finalMsgs);
          setConversationStreaming(id, resumeActiveRun);
          setConversationSending(id, resumeActiveRun);

          // ★ S4（M5/M6）恢复单源：仅 snapshotMessages 直通恢复（对齐 ai_fr buildConversationDisplayState），
          //   字典键=快照 payload.toolCallId（委派 toolCall.id，与三通道事件键一致）；
          //   覆盖式恢复（对齐 ai_fr 覆盖式 setToolSnapshots），不保留旧状态
          const restoredSnapshots: Record<string, ToolSnapshot> = {};
          snapshots.forEach((message) => {
            // ★ BUG-7：恢复兜底键按条目唯一化（原固定 'snapshot-unknown' 会使多张未知快照同键互相覆盖）
            const callId = getToolCallIdFromPayload(message.payload)
              ?? `snapshot-${message.id}`;
            const converted = snapshotMessageToToolSnapshot(message, id, callId);
            if (converted) {
              restoredSnapshots[converted.taskId] = converted;
            }
          });
          setToolSnapshots(restoredSnapshots);
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
    [setConversationSending],
  );

  // 切换对话
  const switchConversation = useCallback(
    (id: string | null) => {
      // ============================================================
      // Phase 3 P3-3 + F9 切换会话清理（保留目标会话的 toolSnapshots）
      // ============================================================
      // 步骤 1：清空已完成工具调用 ID 集合
      completedToolCallIdsRef.current.clear();
      // ★ 对齐 ai_fr 覆盖式机制：切换会话时清空 toolSnapshots（不再跨会话累积保留）
      setToolSnapshots({});

      // 步骤 2：重置粘底滚动开关 + 隐藏"滚动到底部"按钮
      stickToBottomRef.current = true;
      setShowScrollToBottom(false);
      // 步骤 3：清理待发送状态 + 发送中集合（P0-3 per-conversation）
      setPendingConversationSendIds(new Set());
      setSendingConversationIds(new Set());

      // 既有清理
      // ★ 对齐 ai_fr：切换会话时不再清空 messages，
      //   保留旧会话消息作为视觉占位，由 messageLoading + Spin 显示加载过渡，
      //   新会话消息到达后通过 setMessages(msgs) 一次性替换。
      //   对齐 E:\ai_fr chat-shell.tsx 切换会话逻辑
      setConversationId(id);
      conversationIdRef.current = id;
      setError(null);
      // ★ 修复 4：同步 assistantMessageIdRef 到目标对话的 ID（不清空）
      //   旧实现：assistantMessageIdRef.current = null;  // 直接清空导致切回后无法找到 target
      //   新实现：从 Map 中取出当前对话的 ID（保留跨切换上下文）
      if (id) {
        const restoredId = assistantMessageIdByConversationRef.current.get(id) ?? null;
        assistantMessageIdRef.current = restoredId;
      } else {
        assistantMessageIdRef.current = null;
      }

      // 加载历史消息
      if (id) {
        void loadConversationMessages(id);
      }
    },
    [loadConversationMessages],
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
    async (text: string, attachments: SendAttachment[] = []) => {
      const trimmed = text.trim();
      // ============================================================
      // Phase 3 P3-1 发送五重守卫（任一不满足则静默 return）
      // ============================================================
      // 守卫 1：hasText（trim 后非空）或 hasAttachments（已有附件）
      const hasText = trimmed.length > 0;
      const hasAttachments = attachments.length > 0;
      if (!hasText && !hasAttachments) return;
      // 守卫 2：!isConversationPendingSend(activeConversationId)（P0-3 per-conversation）
      const activeConvId = conversationIdRef.current;
      if (isConversationPendingSend(activeConvId) || (activeConvId ? pendingSendRef.current.has(activeConvId) : false)) return;
      // 守卫 3：!isConversationSending(activeConversationId)
      if (isConversationSending(activeConvId)) return;
      // 守卫 4：uploadingCount === 0（无文件上传中）
      if (uploadingCount > 0) return;
      // 守卫 5：!isConversationRunning(activeConversationId)
      if (isConversationRunning(activeConvId)) return;

      // P0-3：convId 提前声明，用于 per-conversation pending/streaming 状态设置
      let convId: string | null = conversationIdRef.current;

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
        setMessages((prev) => [...prev, userMsg]);

        // 添加助手占位消息
        const assistantMsgId = nextMessageId();
        // ★ 修复 4：写入 Map 而非单一 ref（保留跨对话上下文）
        if (convId) {
          assistantMessageIdByConversationRef.current.set(convId, assistantMsgId);
        }
        assistantMessageIdRef.current = assistantMsgId;
        const assistantMsg: ChatMessage = {
          id: assistantMsgId,
          role: 'assistant',
          content: '',
          thinking: '',
          toolCalls: [],
          status: 'loading',
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMsg]);

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
        setError(errMsg);
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
      uploadingCount,
      isConversationSending,
      isConversationRunning,
      createConversation,
      setConversationSending,
    ],
  );

  // 中止对话
  const abortChat = useCallback(() => {
    const convId = conversationIdRef.current;
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
    // ============================================================
    setMessages((prev) => markRunningMessagesAbortedInList(prev));
    setToolSnapshots((prev) => markRunningToolSnapshotsAbortedInList(prev));
    assistantMessageIdRef.current = null;
    if (convId) {
      setConversationStreaming(convId, false);
      setConversationPendingSend(convId, false);
      setConversationSending(convId, false);
    }
  }, [setConversationSending]);

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
    const unsubThinking = window.electronAPI.on('chat:thinking', (payload: unknown) => {
      const data = payload as ThinkingPayload;
      // ★ 修复 2：移除 conversationId 过滤，累积所有对话的 thinking
      if (!data || !data.conversationId) return;
      if (data.conversationId !== conversationIdRef.current) return;

      setMessages((prev) => {
        const targetId = assistantMessageIdByConversationRef.current.get(data.conversationId)
                    ?? assistantMessageIdRef.current;
        if (!targetId) return prev;
        const next = [...prev];
        const targetIdx = next.findIndex((m) => m.id === targetId);
        if (targetIdx === -1) return prev;

        // ★ 优先使用后端发来的完整 segments + thinking（来自 F2/F3 后端累积）
        //   data.segments 来自 main-agent.ts F2 emit，含完整分段结构
        if (Array.isArray(data.segments) && data.segments.length > 0) {
          next[targetIdx] = {
            ...next[targetIdx],
            thinking: typeof data.thinking === 'string' ? data.thinking : next[targetIdx].thinking,
            segments: data.segments.map((segment) => ({ ...segment })),  // 深拷贝避免引用共享
            status: 'loading',
          };
          return next;
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
        return next;
      });
    });
    cleanups.push(unsubThinking);

    // chat:chunk → 流式文本
    const unsubChunk = window.electronAPI.on('chat:chunk', (payload: unknown) => {
      const data = payload as ChunkPayload;
      // ★ 修复 2 + 4：移除 conversationId 过滤，改为按 conversationId 索引 Map
      //   - 累积所有对话的 messages 状态（按 messageId 索引）
      //   - 切回对话时不需要重新加载，能立即显示最新进度
      //   - 切到其他对话时，新对话的 chat:chunk 自动累积到 Map
      if (!data || !data.conversationId) return;
      if (data.conversationId !== conversationIdRef.current) return;
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

      setMessages((prev) => {
        // ★ 累积所有对话的 messages（按 id 全局唯一）
        //   旧实现按 targetIdx 单点更新（仅匹配当前 conversationId）
        //   新实现按 message.id upsert（不区分 conversationId）
        //   ChatArea 渲染时由 messages 列表自然按时间顺序展示，
        //   跨对话污染由 messages 顺序保证（每个对话的 message.id 唯一）

        // 先确保 assistantMessageIdRef 指向该对话的 ID
        const targetId = assistantMessageIdByConversationRef.current.get(data.conversationId)
                    ?? assistantMessageIdRef.current;

        if (!targetId) return prev;

        const next = [...prev];
        const targetIdx = next.findIndex((m) => m.id === targetId);
        if (targetIdx === -1) return prev;
        next[targetIdx] = {
          ...next[targetIdx],
          content: (next[targetIdx].content || '') + (data.delta || ''),
          status: nextStatus,
        };
        return next;
      });
    });
    cleanups.push(unsubChunk);

    // chat:tool-call → 工具调用通知
    const unsubToolCall = window.electronAPI.on('chat:tool-call', (payload: unknown) => {
      const data = payload as ToolCallPayload;
      // ★ 修复 2：移除 conversationId 过滤，累积所有对话的 tool-call
      if (!data || !data.conversationId) return;
      if (data.conversationId !== conversationIdRef.current) return;

      // P1 防重复：如果该 callId 已完成，跳过（防止重复创建工具调用消息）
      if (completedToolCallIdsRef.current.has(data.callId)) return;

      const startedAt = new Date().toISOString();
      const newToolCall: ToolCallInfo = {
        callId: data.callId,
        name: data.name,
        arguments: data.arguments,
        status: 'loading',
        startedAt,
        isDelegatedExecutor: data.isDelegatedExecutor,
      };

      setMessages((prev) => {
        const targetId = assistantMessageIdByConversationRef.current.get(data.conversationId)
                    ?? assistantMessageIdRef.current;
        if (!targetId) return prev;
        const next = [...prev];
        const targetIdx = next.findIndex((m) => m.id === targetId);
        if (targetIdx === -1) return prev;
        if ((next[targetIdx].toolCalls || []).some((tc) => tc.callId === data.callId)) {
          return prev;
        }
        next[targetIdx] = {
          ...next[targetIdx],
          toolCalls: [...(next[targetIdx].toolCalls || []), newToolCall],
          status: 'loading',
        };
        return next;
      });
    });
    cleanups.push(unsubToolCall);

    // chat:tool-result → 工具调用结果
    const unsubToolResult = window.electronAPI.on('chat:tool-result', (payload: unknown) => {
      const data = payload as ToolResultPayload;
      // ★ 修复 2：移除 conversationId 过滤，累积所有对话的 tool-result
      if (!data || !data.conversationId) return;
      if (data.conversationId !== conversationIdRef.current) return;

      // P1 防重复：如果该 callId 已完成，跳过（防止重复处理工具结果）
      if (completedToolCallIdsRef.current.has(data.callId)) return;

      const finishedAt = new Date().toISOString();
      setMessages((prev) => {
        const targetId = assistantMessageIdByConversationRef.current.get(data.conversationId)
                    ?? assistantMessageIdRef.current;
        if (!targetId) return prev;
        const next = [...prev];
        const targetIdx = next.findIndex((m) => m.id === targetId);
        if (targetIdx === -1) return prev;
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
        return next;
      });
      setToolSnapshots((prev) => completeToolSnapshotByDelegateCallId(prev, data));
      // P1 防重复：处理完成后记录 callId，防止后续重复处理
      completedToolCallIdsRef.current.add(data.callId);
    });
    cleanups.push(unsubToolResult);

    // chat:done → 对话完成
    const unsubDone = window.electronAPI.on('chat:done', (payload: unknown) => {
      const data = payload as DonePayload;
      // ★ 修复：恢复 conversationId 过滤，仅处理活跃对话的事件
      if (!data || !data.conversationId) return;

      // ★ per-conversation 状态清理（不受活跃对话过滤影响）
      assistantMessageIdByConversationRef.current.set(data.conversationId, null);

      setConversationStreaming(data.conversationId, false);
      setConversationSending(data.conversationId, false);
      setConversationPendingSend(data.conversationId, false);
      if (data.conversationId === conversationIdRef.current) {
        assistantMessageIdRef.current = null;
      }

      // ★ 仅活跃对话更新 messages 和 toolSnapshots
      if (data.conversationId === conversationIdRef.current) {
        // ★ 关闭所有 loading 状态的 assistant 消息（处理 while 循环多轮迭代）
        setMessages((prev) => {
          const next = [...prev];
          let changed = false;
          for (let idx = 0; idx < next.length; idx++) {
            if (next[idx].role === 'assistant' && next[idx].status === 'loading') {
              next[idx] = { ...next[idx], status: 'success' };
              changed = true;
            }
          }
          return changed ? next : prev;
        });

        // ★ S3（M4）兜底语义收窄：running 快照按 isError 收口（对齐 ai_fr :1910 收口语义）
        //   isError=true → 'failed'，否则 → 'completed'——消除「已完成但快照未更新被误标失败」
        //   （S3 前为一律 status:'failed'+isError:true，见线索集 ⑧-7；仍兜底防 IPC 事件丢失或 hung 永久 running）
        setToolSnapshots((prev) => {
          const next = { ...prev };
          let changed = false;
          const finishedAt = new Date().toISOString();
          for (const [taskId, snapshot] of Object.entries(next)) {
            if (snapshot.conversationId === data.conversationId && snapshot.status === 'running') {
              next[taskId] = {
                ...snapshot,
                status: snapshot.isError ? 'failed' : 'completed',
                finishedAt,
                updatedAt: finishedAt,
              };
              changed = true;
            }
          }
          return changed ? next : prev;
        });

        // ★ 对齐 ai_fr：chat:done 后静默刷新当前会话，从 DB 恢复权威消息/快照状态
        void loadConversationMessages(data.conversationId, { silent: true });
      }
    });
    cleanups.push(unsubDone);

    // chat:error → 错误通知
    const unsubError = window.electronAPI.on('chat:error', (payload: unknown) => {
      const data = payload as ErrorPayload;
      // ★ 修复：恢复 conversationId 过滤，仅活跃对话时更新 messages/error
      if (!data || !data.conversationId) return;

      // ★ 仅活跃对话更新 messages 和 error 状态
      if (data.conversationId === conversationIdRef.current) {
        setMessages((prev) => {
          const targetId = assistantMessageIdByConversationRef.current.get(data.conversationId)
                      ?? assistantMessageIdRef.current;
          if (!targetId) return prev;
          const next = [...prev];
          const targetIdx = next.findIndex((m) => m.id === targetId);
          if (targetIdx === -1) return prev;
          next[targetIdx] = {
            ...next[targetIdx],
            status: 'error',
            content: next[targetIdx].content || data.error || '发生错误',
          };
          return next;
        });
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
    // Phase 3 P0-1 适配层：executor:thinking → 子智能体 thinking / 工具进度
    // ★ 修复主/子智能体消息混淆：不再写入主消息 assistant.toolCalls 字段
    //   改为按 taskId/taskName 聚合到 toolSnapshots 状态（独立的状态流）
    //   实现主/子智能体消息分流：主消息的 toolCalls 字段仅承载主智能体的工具调用
    //   子智能体的 thinking/tool-progress 累积到 toolSnapshots[taskId].lastContent
    // 向后兼容：data.source 缺失时默认 'main'（旧 IPC listener 行为不变）
    // ============================================================
    if (typeof window.electronAPI.executor.onThinking === 'function') {
      const unsubExecutorThinking = window.electronAPI.executor.onThinking(
        (payload: unknown) => {
          const data = payload as ExecutorThinkingPayload;
          // ★ 修复 2：移除 conversationId 过滤，累积所有对话的 toolSnapshots
          //   ChatArea.toolSnapshotsToChatMessages 已按 conversationId 过滤显示
          //   累积 Map 中所有 taskId 唯一，可安全累积
          if (!data || !data.taskId || !data.content) return;
          if (data.conversationId !== conversationIdRef.current) return;

          setToolSnapshots((prev) => {
            // ★ S4（M6）字典键统一 callId：本通道载荷 callId=委派 toolCall.id（main-agent emit 实证），
            //   taskId 仅作旧载荷兜底键
            const key = data.callId ?? data.taskId;
            const existing = prev[key];
            const now = new Date().toISOString();
            const status: ToolSnapshot['status'] =
              existing?.status === 'completed' || existing?.status === 'failed'
                ? existing.status
                : 'running';
            return {
              ...prev,
              [key]: {
                ...existing,
                conversationId: data.conversationId,
                taskId: data.taskId,
                ...(data.callId ? { callId: data.callId } : {}),
                status,
                toolCalls: existing?.toolCalls || [],
                createdAt: existing?.createdAt || now,
                updatedAt: now,
                // ★ 修复主/子智能体消息混淆：消息来源标识（向后兼容旧数据无此字段默认 'main'）
                source: data.source ?? existing?.source ?? 'executor',
                // ★ 修复主/子智能体消息混淆：委派任务名称（按 taskName 聚合）
                taskName: data.taskName || existing?.taskName || '',
                // 最新 thinking/tool-progress 文本（供 UI 渲染）
                // S1-3 增量适配：executor:thinking 推送频次从整轮变为增量 delta（协议字段不变），
                //   此处从「整轮覆盖」改为「增量累积拼接」——splitLoadingToolContent 按 \n+ 切分
                //   逐段分类的输入本就是累积全文（executor-thinking.ts 既有设计），跨轮拼接
                //   与 snapshot.json thinking 全量累积（S1-5 存储全量）保持一致
                lastContent:
                  existing?.lastContent && (data.type !== 'thinking' || existing.lastType !== 'thinking')
                    ? `${existing.lastContent}\n${data.content ?? ''}`
                    : (existing?.lastContent ?? '') + (data.content ?? ''),
                // 最新推送类型（区分 thinking vs tool-progress）
                lastType: data.type,
                // 子智能体工具真实 callId（修复 callId 语义错位，可选）
                ...(data.executorCallId ? { executorCallId: data.executorCallId } : {}),
                // ★ Phase 3 P3-8 messageId ↔ taskId 关联键
                //   由后端 main-agent.ts 在 delegate_executor 时附带 assistantMessageId
                //   用于多子任务并行时各 assistant 消息可正确承载自己的 toolCall 快照
                ...(data.messageId ? { messageId: data.messageId } : {}),
              },
            };
          });
        },
      );
      cleanups.push(unsubExecutorThinking);
    }

    // ============================================================
    // Phase 3 P0-2 适配层：executor:tool-progress → 子智能体工具调用进度
    // ★ 修复主/子智能体消息混淆：不再写入主消息 assistant.toolCalls 字段
    //   改为按 taskId/callId 聚合到 toolSnapshots[taskId].toolCalls 数组
    //   主智能体的工具调用仍走 chat:tool-call / chat:tool-result（主消息 toolCalls 字段）
    //   子智能体的工具调用走 executor:tool-progress（独立 toolSnapshots 状态流）
    // 向后兼容：data.source/taskName 缺失时默认 'main'（旧数据无此字段视为普通主智能体）
    // ============================================================
    if (typeof window.electronAPI.executor.onToolProgress === 'function') {
      const unsubExecutorToolProgress = window.electronAPI.executor.onToolProgress(
        (payload: unknown) => {
          const data = payload as ExecutorToolProgressPayload;
          // ★ 修复 2：移除 conversationId 过滤，累积所有对话的 toolSnapshots
          if (!data || !data.taskId || !data.callId) return;
          if (data.conversationId !== conversationIdRef.current) return;

          setToolSnapshots((prev) => {
            // ★ S4（M6）字典键统一 callId：本通道载荷 callId=子智能体工具真实 callId（仅用于 toolCalls 条目匹配），
            //   委派键=delegateCallId=委派 toolCall.id（main-agent emit 实证）；taskId 仅作旧载荷兜底键
            const key = data.delegateCallId ?? data.taskId;
            const existing = prev[key];
            const now = new Date().toISOString();
            const toolCalls = [...(existing?.toolCalls || [])];
            const idx = toolCalls.findIndex((tc) => tc.callId === data.callId);

            // 状态映射：executor:tool-progress.status → ToolCallInfo.status
            // - 'calling' → 'loading'（工具调用中）
            // - 'completed' → 'success'（成功完成）
            // - 'failed' → 'error'（执行失败）
            const mapStatus = (
              s: 'calling' | 'completed' | 'failed',
            ): 'loading' | 'success' | 'error' => {
              if (s === 'calling') return 'loading';
              if (s === 'completed') return 'success';
              return 'error';
            };

            if (idx >= 0) {
              // 已存在该 callId 的 toolCall：更新 result/status
              const prevTc = toolCalls[idx];
              toolCalls[idx] = {
                ...prevTc,
                name: data.name || prevTc.name,
                arguments: data.arguments ?? prevTc.arguments,
                // onToolResult 触发时 result 字段携带最终结果
                // onToolCall 触发时不携带 result（仅 arguments）
                result:
                  data.status === 'completed' || data.status === 'failed'
                    ? data.result ?? prevTc.result ?? ''
                    : prevTc.result,
                status: mapStatus(data.status),
                startedAt: prevTc.startedAt ?? now,
                ...(data.status === 'completed' || data.status === 'failed'
                  ? { finishedAt: now }
                  : {}),
                isError: data.success === false ? true : prevTc.isError,
              };
            } else {
              // 新增 toolCall 条目
              toolCalls.push({
                callId: data.callId,
                name: data.name,
                arguments: data.arguments || '',
                result: data.result || '',
                status: mapStatus(data.status),
                startedAt: existing?.createdAt ?? now,
                ...(data.status === 'completed' || data.status === 'failed'
                  ? { finishedAt: now }
                  : {}),
                ...(data.success === false ? { isError: true } : {}),
              });
            }

            // 子智能体内部工具完成不等于整个委派任务完成。
            // 整个任务的 completed/failed 由主智能体 chat:tool-result（delegate_executor 外层 callId）收口。
            const status: ToolSnapshot['status'] =
              existing?.status === 'completed' || existing?.status === 'failed'
                ? existing.status
                : 'running';

            return {
              ...prev,
              [key]: {
                ...existing,
                conversationId: data.conversationId,
                taskId: data.taskId,
                ...(data.delegateCallId || existing?.callId
                  ? { callId: data.delegateCallId ?? existing?.callId }
                  : {}),
                status,
                toolCalls,
                createdAt: existing?.createdAt || now,
                updatedAt: now,
                // ★ 修复主/子智能体消息混淆：消息来源标识（向后兼容旧数据无此字段默认 'main'）
                source: data.source ?? existing?.source ?? 'executor',
                // ★ 修复主/子智能体消息混淆：委派任务名称（按 taskName 聚合）
                taskName: data.taskName || existing?.taskName || '',
                // 子智能体工具真实 callId（修复 callId 语义错位，可选）
                ...(data.callId ? { executorCallId: data.callId } : {}),
                // ★ Phase 3 P3-8 messageId ↔ taskId 关联键
                ...(data.messageId ? { messageId: data.messageId } : {}),
              },
            };
          });
        },
      );
      cleanups.push(unsubExecutorToolProgress);
    }

    // ============================================================
    // Phase 3 P0-3 适配层：executor:snapshot → 子智能体执行中间快照
    // 主进程已推送真实快照数据（executor:snapshot，main-agent.ts sendToolSnapshot 唯一出口）
    // 按 taskId upsert 到 toolSnapshots 状态
    // buildConversationDisplayState 恢复时优先从快照恢复 in-flight 任务
    // ============================================================
    if (typeof window.electronAPI.executor.onSnapshot === 'function') {
      const unsubExecutorSnapshot = window.electronAPI.executor.onSnapshot(
        (payload: unknown) => {
          const data = payload as ExecutorSnapshotPayload;
          // ★ 修复 2：移除 conversationId 过滤，累积所有对话的 toolSnapshots
          if (!data || !data.taskId) return;
          if (data.conversationId !== conversationIdRef.current) return;

          // ★ 对齐 ai_fr chat-shell.tsx appendOrMergeToolSnapshot L1812-1816（payload 含 thinking 随快照合并）：
          //   executor:snapshot 载荷的 thinking 位于 message.payload.thinking，此处显式提取到 ToolSnapshot.thinking
          //   （运行态思考显示数据源；进度快照携带的仍是最新 latestThinking，不会被进度覆盖——对齐 ai_fr L730 语义）
          const snapshotThinking =
            (data as { message?: { payload?: { thinking?: string } } }).message?.payload?.thinking;
          // ★ 修复计时器刷新后重新计时：事件载荷 message（main-agent.ts L882-888 emit 的
          //   snapshotMessage，buildToolSnapshotMessage 产物）携带持久化任务开始时间
          //   （payload.startedAt=createdAt=toolStartedAt，main-agent.ts L839/L843）。
          //   刷新后 toolSnapshots 恢复为空、由事件流重建任务卡片时，以它为计时基准，
          //   避免 createdAt/toolCalls[].startedAt 退化为 now（刷新时刻）导致计时从 0 重新起算。
          const snapshotMessage = (data as { message?: StreamMessage }).message;
          const snapshotStartedAt =
            snapshotMessage?.payload?.startedAt ?? snapshotMessage?.createdAt ?? undefined;
          setToolSnapshots((prev) => {
            // ★ S4（M6）字典键统一 callId：本通道载荷 callId=委派 toolCall.id（main-agent emit 实证），
            //   taskId 仅作旧载荷兜底键
            const key = data.callId ?? data.taskId;
            const existing = prev[key];
            const now = new Date().toISOString();
            const isTerminal =
              existing?.status === 'completed' || existing?.status === 'failed';
            return {
              ...prev,
              [key]: {
                ...existing,
                ...data,
                status: isTerminal ? existing.status : data.status,
                callId: data.callId ?? existing?.callId,
                // ★ 运行态思考直通（修复运行中思考块随进度消失）；终态保护对齐 ai_fr L1779-1781
                thinking: isTerminal
                  ? existing?.thinking
                  : (snapshotThinking ?? existing?.thinking ?? ''),
                toolCalls:
                  data.toolCalls ??
                  existing?.toolCalls ??
                  (snapshotStartedAt
                    ? [
                        {
                          callId: snapshotMessage?.payload?.toolCallId ?? key,
                          name: snapshotMessage?.payload?.name ?? '',
                          arguments: snapshotMessage?.payload?.arguments ?? '',
                          result: snapshotMessage?.payload?.result ?? '',
                          status: 'loading',
                          startedAt: snapshotStartedAt,
                          isError: snapshotMessage?.payload?.isError ?? false,
                          isDelegatedExecutor:
                            snapshotMessage?.payload?.name === 'delegate_executor',
                        },
                      ]
                    : []),
                result: isTerminal ? existing.result ?? data.result : data.result ?? existing?.result,
                isError: isTerminal ? existing.isError ?? data.isError : data.isError ?? existing?.isError,
                finishedAt: isTerminal
                  ? existing.finishedAt ?? data.finishedAt
                  : data.finishedAt ?? existing?.finishedAt,
                createdAt: data.createdAt || existing?.createdAt || snapshotStartedAt || now,
                updatedAt: isTerminal ? existing.updatedAt : data.updatedAt || now,
                source: data.source ?? existing?.source ?? 'executor',
                // ★ Phase 3 P3-8 messageId ↔ taskId 关联键
                messageId: (data as ToolSnapshot).messageId ?? existing?.messageId,
              },
            };
          });
        },
      );
      cleanups.push(unsubExecutorSnapshot);
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
        // ★ 修复 2：移除 conversationId 过滤，累积所有对话的 user messages
        //   message.id 唯一，按 id upsert 即可
        if (!data || !data.message || data.message.role !== 'user') return;
        if (data.conversationId !== conversationIdRef.current) return;
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
        setMessages((prev) => replaceLatestLocalUserInList(prev, serverMsg));
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
        // ★ 修复 2 + 4：移除 conversationId 过滤，写入 Map
        if (!data || !data.message || data.message.role !== 'assistant' || !data.conversationId) return;
        // ★ 修复 4：写入 Map 替代单一 ref
        assistantMessageIdByConversationRef.current.set(data.conversationId, data.message.id);
        if (data.conversationId !== conversationIdRef.current) return;
        assistantMessageIdRef.current = data.message.id;
        setMessages((prev) =>
          upsertMessageById(prev, { ...data.message, status: 'loading' }),
        );
      },
    );
    cleanups.push(unsubAssistantStarted);

    const unsubAssistantSnapshot = window.electronAPI.on(
      IPC_CHAT.ASSISTANT_SNAPSHOT,
      (payload: unknown) => {
        const data = payload as AssistantSnapshotPayload;
        // ★ 修复 2：移除 conversationId 过滤，累积所有对话的 assistant messages
        if (!data || !data.message || data.message.role !== 'assistant') return;
        if (data.conversationId !== conversationIdRef.current) return;
        setMessages((prev) =>
          upsertMessageById(prev, { ...data.message, status: 'loading' }),
        );
      },
    );
    cleanups.push(unsubAssistantSnapshot);

    const unsubAssistantDone = window.electronAPI.on(
      IPC_CHAT.ASSISTANT_DONE,
      (payload: unknown) => {
        const data = payload as AssistantDonePayload;
        // ★ 修复 2：移除 conversationId 过滤，累积所有对话的 assistant messages
        if (!data || !data.message || data.message.role !== 'assistant') return;
        if (data.conversationId !== conversationIdRef.current) return;
        // done 事件：保持后端推送的 status（success / error），若缺省则为 success
        const finalStatus: ChatMessage['status'] =
          data.message.status === 'error' ? 'error' : 'success';
        setMessages((prev) =>
          upsertMessageById(prev, { ...data.message, status: finalStatus }),
        );
      },
    );
    cleanups.push(unsubAssistantDone);

    const unsubToolMessageCreated = window.electronAPI.on(
      IPC_CHAT.TOOL_MESSAGE_CREATED,
      (payload: unknown) => {
        const data = payload as ToolMessageCreatedPayload;
        // ★ 修复 2：移除 conversationId 过滤，累积所有对话的 tool messages
        if (!data || !data.message || data.message.role !== 'tool') return;
        if (data.conversationId !== conversationIdRef.current) return;
        const toolCallId = data.message.toolCall?.callId;
        // 真实 tool 消息 payload 不含 thinking（主进程不落库）：删快照前把快照 thinking+进度段
        // 合并透传进真实消息（仅渲染端内存态，不入库），完成态两块保留可回看
        let mergedMessage = data.message;
        if (toolCallId) {
          completedToolCallIdsRef.current.add(toolCallId);
          // ★ S4（M6）：字典键已统一为委派 callId，直接按键删除（原按 snapshot.callId 全表扫描匹配）
          setToolSnapshots((prev) => {
            const snapshot = prev[toolCallId];
            if (snapshot) {
              mergedMessage = {
                ...data.message,
                thinking: data.message.thinking ?? snapshot.thinking ?? '',
                progress: latestToolProgressText(snapshot.lastContent || ''),
              };
            }
            if (!(toolCallId in prev)) return prev;
            const next = { ...prev };
            delete next[toolCallId];
            return next;
          });
        }
        setMessages((prev) => upsertMessageById(prev, mergedMessage));
      },
    );
    cleanups.push(unsubToolMessageCreated);

    // ============================================================
    // ★ S3（M4）批次完成事件 tool.batch.completed：批内工具调用全部结束
    //   （含全中止批次，主进程在全中止 throw 之前发送）→ 按 isError 收口 running 快照；
    //   活跃会话过滤=ai_fr chat-shell.tsx:2094 streamIsActive 守卫的 Delepi 等价物
    // ============================================================
    const unsubToolBatchCompleted = window.electronAPI.on(
      IPC_CHAT.TOOL_BATCH_COMPLETED,
      (payload: unknown) => {
        const data = payload as ToolBatchCompletedPayload;
        if (!data || !data.conversationId) return;
        if (data.conversationId !== conversationIdRef.current) return;
        setToolSnapshots((prev) =>
          markBatchToolSnapshotsSettled(prev, data.conversationId, data.toolCallIds),
        );
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
        // ★ 修复：恢复 conversationId 过滤，仅活跃对话时更新 messages/toolSnapshots
        //   per-conversation 状态清理不受活跃对话过滤影响
        if (!data || !data.conversationId) return;
        if (data.conversationId === conversationIdRef.current) {
          setMessages((prev) => markRunningMessagesAbortedInList(prev));
          setToolSnapshots((prev) => markRunningToolSnapshotsAbortedInList(prev));
          // ★ 对齐 ai_fr：取消回复后静默刷新当前会话，从 DB 恢复权威消息/快照状态
          // ★ 修复（手动取消 loading 复活/挂起）：携带 suppressActiveRunResume，防止主进程
          //   runMainAgent 退出前 conv:get-messages 附加的陈旧 loading 消息复活 streaming/sending
          void loadConversationMessages(data.conversationId, {
            silent: true,
            suppressActiveRunResume: true,
          });
        }

        // ★ 修复 4：清空该对话在 Map 中的 ID
        assistantMessageIdByConversationRef.current.set(data.conversationId, null);

        // ★ P0-1/P0-3 per-conversation：总是清理对应对话的 streaming/pending/sending 状态
        setConversationStreaming(data.conversationId, false);
        setConversationSending(data.conversationId, false);
        setConversationPendingSend(data.conversationId, false);
        // assistantMessageIdRef 是全局 ref，仅活跃对话时清理
        if (data.conversationId === conversationIdRef.current) {
          assistantMessageIdRef.current = null;
        }
        console.info('[useChat] chat:aborted', {
          conversationId: data.conversationId,
          reason: data.reason,
        });
      },
    );
    cleanups.push(unsubAborted);

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
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

  // ★ P1-C2：组件卸载时清理 200ms 节流定时器，避免内存泄漏
  useEffect(() => {
    return () => {
      clearConversationNavigationReloadTimeout();
    };
  }, [clearConversationNavigationReloadTimeout]);

  // ============================================================
  // ★ 修复 4 配套：assistantMessageIdByConversationRef LRU 清理
  // 防止 Map 无限增长（删除对话时应清理对应条目）
  // ============================================================
  useEffect(() => {
    // 监听 conversations 列表变化，清理已删除对话的 ID
    const validConvIds = new Set(conversations.map((c) => c.id));
    const mapIds = Array.from(assistantMessageIdByConversationRef.current.keys());
    for (const id of mapIds) {
      if (!validConvIds.has(id)) {
        assistantMessageIdByConversationRef.current.delete(id);
      }
    }
  }, [conversations]);

  return {
    messages,
    /** ★ 对齐 ai_fr：消息加载过渡态，供 ChatArea 显示 Spin */
    messageLoading,
    conversationId,
    conversations,
    /** ★ P0-1 per-conversation：基于 conversationId 的派生 streaming 状态 */
    isStreaming: Boolean(conversationId && streamingConversationIds.has(conversationId)),
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
