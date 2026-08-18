/**
 * 流式中 Assistant 消息内存 Map（P1-C3）
 *
 * 作用：保存当前正在流式生成的 Assistant 消息，避免 conv:get-messages 时丢失
 * 正在累积但尚未落库的 assistant 消息
 *
 * 对齐 E:\ai_fr stream/route.ts 中 tool.message.snapshot + 内存累积
 * 本项目侧实现：
 * - key：conversationId（一个会话同时只允许一个正在流式生成的 assistant 消息）
 * - value：当前正在流式累积的 ChatMessage 副本
 * - 写入时机：runMainAgent 流式开始时（emit chat:chunk 前）→ 初始化
 *            流式累积时（emit chat:chunk / chat:thinking）→ 更新 content/thinking
 *            流式结束时（writeMessage 后）→ 删除
 * - 读取时机：conv:get-messages IPC handler → 在返回的消息列表中追加（若该消息尚未入库）
 *
 * 注意：与 tool 消息 payload 不同，runningAssistantMessages
 * 是 ChatMessage 完整结构，用于前端渲染；tool 消息 payload 承载子智能体执行快照。
 * ChatMessage 类型为本地简化定义（不依赖 renderer 模块），
 * 仅包含 ipc-handlers.ts conv:get-messages 实际使用的字段
 */

/**
 * 流式 Assistant 消息本地简化类型（P1-C3）
 * 与 renderer ChatMessage 结构兼容：
 * - id / role / content / thinking / toolCalls / status / createdAt
 * - main 进程只需这些字段做内存 Map + 序列化传给 IPC
 */
export interface RunningAssistantMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  toolCalls?: Array<{
    callId: string;
    name: string;
    arguments: string;
    result?: string;
    status?: 'loading' | 'success' | 'error' | 'abort';
  }>;
  toolCall?: {
    callId: string;
    name: string;
    arguments: string;
    result?: string;
    status?: 'loading' | 'success' | 'error' | 'abort';
  };
  status: 'local' | 'loading' | 'success' | 'error' | 'abort';
  createdAt: string;
  segments?: Array<
    | { id: string; type: 'reasoning'; text: string }
    | { id: string; type: 'tool_call'; toolCallId: string }
  >;
  // ★ F4 新增：content 首次出现时由 onChunk 设置，onThinking 检测后新开 reasoning 段
  //   解决 reasoning_split 模型下 packet 同时返回 content+reasoning 时出现的跨段粘连
  forceNewReasoningSegment?: boolean;
}

/**
 * 流式 Assistant 消息 Map
 * key: conversationId
 * value: 正在流式累积的 ChatMessage
 */
export const runningAssistantMessages: Map<string, RunningAssistantMessage> = new Map();

/**
 * 初始化/覆盖指定会话的 runningAssistantMessage
 * 通常在 runMainAgent 流式开始时调用
 * @param conversationId 会话 ID
 * @param message 初始 ChatMessage（status='loading'）
 */
export function setRunningAssistantMessage(
  conversationId: string,
  message: RunningAssistantMessage,
): void {
  runningAssistantMessages.set(conversationId, message);
}

/**
 * 部分更新指定会话的 runningAssistantMessage
 * 通常在 chat:chunk / chat:thinking 流式累积时调用
 * @param conversationId 会话 ID
 * @param partial 部分字段（content / thinking / toolCalls 等）
 */
export function updateRunningAssistantMessage(
  conversationId: string,
  partial: Partial<RunningAssistantMessage>,
): void {
  const existing = runningAssistantMessages.get(conversationId);
  if (!existing) {
    return;
  }
  runningAssistantMessages.set(conversationId, { ...existing, ...partial });
}

/**
 * 获取指定会话的 runningAssistantMessage
 * @param conversationId 会话 ID
 * @returns ChatMessage 或 undefined
 */
export function getRunningAssistantMessage(
  conversationId: string,
): RunningAssistantMessage | undefined {
  return runningAssistantMessages.get(conversationId);
}

/**
 * 删除指定会话的 runningAssistantMessage
 * 通常在流式结束（writeMessage 落库后）调用
 * @param conversationId 会话 ID
 */
export function deleteRunningAssistantMessage(conversationId: string): void {
  runningAssistantMessages.delete(conversationId);
}
