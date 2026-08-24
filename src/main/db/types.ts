/**
 * Delepi 数据库共享类型定义
 * 从 repository.ts 提取，集中管理所有数据访问层类型
 */

import type { ChatAttachment, ChatContentPart } from '@shared/types/chat';

// ============================================================
// 基础类型别名
// ============================================================

export type MessageRole = 'user' | 'assistant' | 'tool';

// ============================================================
// F5 修复：Assistant 消息 segments 分段结构
// 对齐 ai_fr AssistantMessageSegment 类型（lib/types/chat.ts L51-58）
//   - reasoning：推理段（累积在 onThinking 回调中）
//   - tool_call：工具调用段（由独立 upsertToolCallSegment 插入）
// 此处使用本地类型别名（与 main-agent.ts L118-128 保持一致），
//   repository.ts 在主进程，无法直接引用 renderer/lib/message-filter 的类型。
// ============================================================
export type AssistantMessageSegment =
  | { id: string; type: 'reasoning'; text: string }
  | { id: string; type: 'tool_call'; toolCallId: string };

// ============================================================
// 记录接口
// ============================================================

export interface ConversationRecord {
  id: string;
  title: string;
  isRunning: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessageRecord {
  id: string;
  conversationId: string;
  seq: number;
  role: MessageRole;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ContextCompressionRecord {
  id: string;
  conversationId: string;
  maxMessageSeq: number;
  contextText: string;
}

export interface RendererChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** ★ M11 持久化稳定次序键（messages.seq，同批 created_at 同值时排序依据） */
  seq?: number;
  thinking?: string;
  // ★ F5 新增：Assistant 消息分段结构（与 ai_fr AssistantMessageSegment 对齐）
  //   持久化在 messages.payload_json.segments 中，由 insertMessage（F3）写入，
  //   由 listRendererMessages（本函数）读出
  segments?: AssistantMessageSegment[];
  /**
   * P6 历史消息附件回显:user 消息携带的附件元数据列表
   * 来自 payload.attachments（持久化在 messages 表的 payload_json 中）
   * 对齐 E:\ai_fr ChatMessageContentInner user 分支 attachmentContent 渲染
   * - 仅 user 角色可能有附件
   * - assistant/tool 角色此字段为 undefined
   */
  attachments?: ChatAttachment[];
  toolCalls?: Array<{
    callId: string;
    name: string;
    arguments: string;
    result?: string;
    status: 'loading' | 'success' | 'error';
    startedAt?: string;
    finishedAt?: string;
    isError?: boolean;
    isDelegatedExecutor?: boolean;
  }>;
  toolCall?: {
    callId: string;
    name: string;
    arguments: string;
    result?: string;
    status: 'loading' | 'success' | 'error';
    startedAt?: string;
    finishedAt?: string;
    isError?: boolean;
    isDelegatedExecutor?: boolean;
  };
  status: 'success';
  createdAt: string;
  source?: 'main' | 'executor';
}
