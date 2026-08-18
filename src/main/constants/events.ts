/**
 * 事件名和状态常量
 * 归集自 main-agent.ts、ipc-handlers.ts
 */

// ============================================================
// 主智能体事件名
// ============================================================

export const MAIN_AGENT_CHUNK_EVENT = 'main-agent:chunk';
export const MAIN_AGENT_THINKING_EVENT = 'main-agent:thinking';
export const MAIN_AGENT_TOOL_CALL_EVENT = 'main-agent:tool-call';
export const MAIN_AGENT_TOOL_RESULT_EVENT = 'main-agent:tool-result';
export const MAIN_AGENT_ERROR_EVENT = 'main-agent:error';
export const MAIN_AGENT_DONE_EVENT = 'main-agent:done';
export const MAIN_AGENT_TITLE_EVENT = 'main-agent:title';
export const MAIN_AGENT_COMPRESSION_EVENT = 'main-agent:compression';
export const MAIN_AGENT_ABORTED_EVENT = 'main-agent:aborted';
export const ASSISTANT_MESSAGE_STARTED_EVENT = 'assistant.message.started';
export const ASSISTANT_MESSAGE_DONE_EVENT = 'assistant.message.done';
export const TOOL_MESSAGE_CREATED_EVENT = 'tool.message.created';

/**
 * P6 用户消息创建事件（主进程内部事件总线 → ipc-handlers 转发给渲染）
 * - 由 main-agent.ts 在 insertMessage(user) 后 emit
 * - ipc-handlers.ts eventBus.on 监听后转发 IPC_CHAT.USER_MESSAGE_CREATED 给 renderer
 * - payload 含 conversationId + message{id,role,content,attachments,createdAt}
 * - renderer useChat 收到后 replaceLatestLocalUserInList 替换本地乐观 user 消息
 */
export const USER_MESSAGE_CREATED_EVENT = 'user.message.created';

// ============================================================
// ★ S3 批次完成事件（M4）：批内全部工具调用结束（含失败/中止）后于批次收口点发出
//   对齐 ai_fr types/chat.ts:171-177 事件形态；发送时序=main-agent.ts 批次收口块内、全中止判定之前
// ============================================================

export const TOOL_BATCH_COMPLETED_EVENT = 'tool.batch.completed';

// ============================================================
// 错误类型
// ============================================================

export const ERROR_TYPE_EXECUTOR_ERROR = 'EXECUTOR_ERROR';
