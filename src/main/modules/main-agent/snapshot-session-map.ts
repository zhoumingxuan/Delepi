/**
 * 会话快照内存 Map（snapshot.json 文件快照 → 主进程内存方案）
 *
 * 作用：替代 tasks/{toolCallId}/snapshot.json 文件快照，在主进程内存保存各会话
 * 正在运行的委派任务中间快照（tasks_snapshot 集合），消除流式期间每个 reasoning
 * delta 触发的全量覆盖写盘
 *
 * 结构（用户 2026-08-25 决策）：
 * - key：conversationId（一个对话一个 session）
 * - value：SnapshotSession（内含 tasks_snapshot 集合，键=toolCallId，插入序=任务启动序）
 * - 条目为七字段快照，与原 snapshot.json 文件内容逐字段一致
 *
 * 生命周期：
 * - 写入：main-agent.ts sendToolSnapshot 唯一出口（同键覆盖式，最新态收敛）
 * - 读取：ipc-handlers.ts conv:get-messages（仅 isRunning=true 会话，门禁在外层）
 * - 重置：与 tasks 目录重置时机完全相同（resetConversationTasksDir 函数体内）
 * - 删除：conv:delete 会话删除（deleteConversationRecord 之后）
 * - 清空：进程重启模块级 Map 随主进程销毁，天然自动清空
 *
 * 风格对齐 running-assistant-message-map.ts / conversation-runtime.ts：
 * 模块级单例 Map + 导出纯函数，无类、无依赖注入、无初始化时序
 */

import type { StreamMessage } from '@shared/types/chat';

/**
 * 单个委派任务快照条目（与原 snapshot.json 文件七字段逐字段一致）
 */
export interface TaskSnapshotEntry {
  thinking: string;
  toolCall: { toolCallId: string; name: string; arguments: string };
  createdAt: string;
  status: 'init' | 'running' | 'finished';
  finishedAt?: string;
  snapshot: StreamMessage;
}

/**
 * 会话快照 session：一个 conversationId 对应一个 session，
 * 内含该会话的 tasks_snapshot 集合（键=toolCallId，Map 插入序=任务启动序）
 */
export interface SnapshotSession {
  tasksSnapshot: Map<string, TaskSnapshotEntry>;
}

/**
 * 全局会话快照 Map
 * key: conversationId
 * value: SnapshotSession
 */
const snapshotSessions: Map<string, SnapshotSession> = new Map();

/**
 * 覆盖式写入单个任务快照（session 不存在时惰性建立）
 * 写入时机：main-agent.ts sendToolSnapshot 唯一出口（5 个调用点行为不变）
 * @param conversationId 会话 ID
 * @param toolCallId 委派工具调用 ID（=快照 payload.toolCallId，与前端快照键同源）
 * @param entry 七字段快照条目
 */
export function setTaskSnapshot(
  conversationId: string,
  toolCallId: string,
  entry: TaskSnapshotEntry,
): void {
  let session = snapshotSessions.get(conversationId);
  if (!session) {
    session = { tasksSnapshot: new Map() };
    snapshotSessions.set(conversationId, session);
  }
  session.tasksSnapshot.set(toolCallId, entry);
}

/**
 * 读取会话快照消息列表（消费形态与原 loadSnapshotMessages 返回值一致）
 * - 去重键=条目 snapshot.payload.toolCallId（与已持久化 tool 消息 callId 对齐）
 * - 顺序=Map 插入序（任务启动序）；前端时间线经三级稳定排序（time→seq→id）不依赖本顺序
 * - 同步直读内存引用，无文件 IO、无 JSON.parse、无加载拼接
 * @param conversationId 会话 ID
 * @param existingToolCallIds 已持久化 tool 消息 callId 集合（去重）
 */
export function getSnapshotMessages(
  conversationId: string,
  existingToolCallIds: Set<string>,
): Array<{ toolCallId: string; message: StreamMessage }> {
  const session = snapshotSessions.get(conversationId);
  if (!session) {
    return [];
  }
  const result: Array<{ toolCallId: string; message: StreamMessage }> = [];
  for (const entry of session.tasksSnapshot.values()) {
    const snapshotToolCallId = entry.snapshot.payload.toolCallId;
    if (snapshotToolCallId && existingToolCallIds.has(snapshotToolCallId)) continue;
    result.push({ toolCallId: snapshotToolCallId, message: entry.snapshot });
  }
  return result;
}

/**
 * 清理会话快照 session（Map.delete 幂等，不存在的会话安全）
 * 调用时机：①轮末重置 resetConversationTasksDir 函数体内（与 tasks 目录重置时机完全相同）
 *          ②会话删除 conv:delete（deleteConversationRecord 之后）
 * @param conversationId 会话 ID
 */
export function clearSnapshotSession(conversationId: string): void {
  snapshotSessions.delete(conversationId);
}
