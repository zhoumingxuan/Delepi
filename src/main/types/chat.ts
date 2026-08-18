/**
 * 对话相关类型定义
 */

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'tool';

/** 对话元数据 */
export interface Conversation {
  id: string;
  title: string;
  isRunning: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 消息记录 */
export interface Message {
  id: string;
  conversationId: string;
  seq: number;
  role: MessageRole;
  payloadJson: string;
  createdAt: string;
}

/** 流式快照（推送到前端） */
export interface StreamSnapshot {
  conversationId: string;
  content: string;
  delta: string;
  isThinking: boolean;
}

/** 工具调用信息 */
export interface ToolCallInfo {
  callId: string;
  name: string;
  arguments: string;
}

/** 工具调用结果 */
export interface ToolResultInfo {
  callId: string;
  name: string;
  result: string;
  success: boolean;
}

/** 对话完成信息 */
export interface ChatDonePayload {
  conversationId: string;
  messageId: string;
  durationMs: number;
}

/** 对话错误信息 */
export interface ChatErrorPayload {
  conversationId: string;
  error: string;
  errorType: string;
}
