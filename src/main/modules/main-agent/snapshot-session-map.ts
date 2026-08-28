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
 * 并发隔离（v2.1 M9，用户 12:13:07 强调项）：
 * - 外层 conversationId 隔离对话（跨对话零串写）
 * - 内层 toolCallId 隔离任务（同对话多任务并发各持唯一条目）
 * - toolCalls 数组按 callId upsert 防回退（并发 chunk 三键精确定位，无模糊匹配）
 *
 * 生命周期：
 * - 写入：main-agent.ts sendToolSnapshot 唯一出口（同键覆盖式，最新态收敛）
 *   + upsertTaskSnapshotToolCall（子工具调用事件，M6/M9）
 * - 读取：ipc-handlers.ts conv:get-messages（仅 isRunning=true 会话，门禁在外层）
 *   + conv:get-running-snapshots 轻量查询（M9 getRunningSnapshotEntries，仅运行中条目）
 * - 重置：与 tasks 目录重置时机完全相同（resetConversationTasksDir 函数体内）
 * - 删除：conv:delete 会话删除（deleteConversationRecord 之后）
 * - 清空：进程重启模块级 Map 随主进程销毁，天然自动清空
 *
 * 风格对齐 running-assistant-message-map.ts / conversation-runtime.ts：
 * 模块级单例 Map + 导出纯函数，无类、无依赖注入、无初始化时序
 */

import type { StreamMessage } from '@shared/types/chat';

/**
 * 子智能体单次工具调用快照（M9：仅内存结构——D6/规则④，绝不进 StreamMessage.payload 与推送载荷；
 * 仅经轻量查询响应三元组成员外流）
 * upsert 键=callId（子智能体工具真实调用 ID，executor-agent.ts 回调透传）
 */
export interface ExecutorToolCallSnapshot {
  /** 子智能体工具真实 callId（与主智能体委派 toolCall.id 不同层） */
  callId: string;
  name: string;
  arguments: string;
  result: string;
  /** loading=调用中 / success=完成 / error=失败（与前端 ToolCallInfo.status 同构） */
  status: 'loading' | 'success' | 'error';
  startedAt?: string;
  finishedAt?: string;
  isError?: boolean;
}

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
  /** ★ M9：任务期间累计的工具调用数组（仅内存；按 callId upsert，末项=最新一条） */
  toolCalls: ExecutorToolCallSnapshot[];
  /** ★ 缺陷①修复：委派任务名（main-agent.ts 委派时从 arguments.taskname 解析，sendToolSnapshot 唯一出口写入）。
   *  仅内存结构（同 toolCalls——D6/规则④：绝不进 StreamMessage.payload 与推送载荷），
   *  经 getRunningSnapshotEntries 轻量查询三元组外流，供前端恢复运行中任务卡片标题 */
  taskName: string;
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
 * ★ M9 merge 语义：传入 entry 不携带 toolCalls（思考 delta 覆盖写场景）时保留旧数组，
 *   与 upsertTaskSnapshotToolCall 互补不互删（思考流与工具事件两路写入互不冲掉对方数据）
 * @param conversationId 会话 ID
 * @param toolCallId 委派工具调用 ID（=快照 payload.toolCallId，与前端快照键同源）
 * @param entry 快照条目（toolCalls 可缺省）
 */
export function setTaskSnapshot(
  conversationId: string,
  toolCallId: string,
  entry: Omit<TaskSnapshotEntry, 'toolCalls'> & { toolCalls?: ExecutorToolCallSnapshot[] },
): void {
  let session = snapshotSessions.get(conversationId);
  if (!session) {
    session = { tasksSnapshot: new Map() };
    snapshotSessions.set(conversationId, session);
  }
  const existing = session.tasksSnapshot.get(toolCallId);
  session.tasksSnapshot.set(toolCallId, {
    ...entry,
    toolCalls: entry.toolCalls ?? (existing ? existing.toolCalls : []),
  });
}

/**
 * upsert 子智能体单次工具调用到任务快照（M6/M9 并发 chunk 路由核心写入点）
 * 三键精确定位：conversationId（外层对话隔离）→ delegateToolCallId（内层任务隔离）
 *   → toolCall.callId（数组条目键）——绝无按数组首/末项的模糊匹配与跨任务串写。
 * @param conversationId 会话 ID
 * @param delegateToolCallId 委派工具调用 ID（=内层 Map 键=快照 payload.toolCallId）
 * @param toolCall 子智能体工具调用快照条目（callId 必填）
 */
export function upsertTaskSnapshotToolCall(
  conversationId: string,
  delegateToolCallId: string,
  toolCall: ExecutorToolCallSnapshot,
): void {
  let session = snapshotSessions.get(conversationId);
  if (!session) {
    session = { tasksSnapshot: new Map() };
    snapshotSessions.set(conversationId, session);
  }
  // 防御性初始化：子工具事件先于思考首写到达时也保证条目结构完整（toolCalls 恒为数组）
  let entry = session.tasksSnapshot.get(delegateToolCallId);
  if (!entry) {
    const nowIso = new Date().toISOString();
    entry = {
      thinking: '',
      toolCall: { toolCallId: delegateToolCallId, name: '', arguments: '' },
      createdAt: nowIso,
      status: 'init',
      toolCalls: [],
      taskName: '',   // ★ 缺陷①修复：防御性初始化占位（子工具事件先于思考首写到达时保持条目结构完整；后续 sendToolSnapshot 覆盖式补真值）
      snapshot: {
        id: `snapshot-${delegateToolCallId}`,
        conversationId,
        role: 'tool',
        payload: {
          toolCallId: delegateToolCallId,
          name: '',
          arguments: '',
          result: '',
          thinking: '',
          isError: false,
          startedAt: nowIso,
        },
        createdAt: nowIso,
      },
    };
    session.tasksSnapshot.set(delegateToolCallId, entry);
  }
  const toolCalls = [...entry.toolCalls];
  const idx = toolCalls.findIndex((tc) => tc.callId === toolCall.callId);
  if (idx >= 0) {
    const prev = toolCalls[idx];
    // 命中同 callId：按下标覆盖；arguments/startedAt 取现有值防回退（onToolResult 不携带 arguments）
    toolCalls[idx] = {
      ...toolCall,
      arguments: toolCall.arguments || prev.arguments,
      startedAt: toolCall.startedAt ?? prev.startedAt,
      result: toolCall.result || prev.result,
    };
  } else {
    // 未命中：push 到末尾（末项=最新一条）
    toolCalls.push(toolCall);
  }
  entry.toolCalls = toolCalls;
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
 * 轻量查询：读取会话【正在运行】的任务快照三元组（M21 前端轻量消费函数唯一数据源）
 * - 仅返回 entry.status !== 'finished' 的条目（init/running）＝「只返回正在运行的任务快照」
 * - 终态条目（status='finished'）已被 TOOL_MESSAGE_CREATED 落库承载，不外流——
 *   天然去重，无需 existingToolCallIds（零 messages 表读取）
 * - toolCalls 为内存累计数组（D6：仅内存结构，经 invoke 查询响应直出，不经推送载荷）
 * - ★ 缺陷①修复：三元组增加第 4 员 taskName（entry.taskName 透传——同样仅经查询响应外流，
 *   供前端 snapshotMessageToToolSnapshot 恢复运行中任务卡片标题；getSnapshotMessages 出口仅携带
 *   message，由前端从委派 payload.arguments 解析兜底，两出口恢复结果一致）
 */
export function getRunningSnapshotEntries(
  conversationId: string,
): Array<{ toolCallId: string; message: StreamMessage; toolCalls: ExecutorToolCallSnapshot[]; taskName: string }> {
  const session = snapshotSessions.get(conversationId);
  if (!session) return [];
  const result: Array<{ toolCallId: string; message: StreamMessage; toolCalls: ExecutorToolCallSnapshot[]; taskName: string }> = [];
  for (const entry of session.tasksSnapshot.values()) {
    if (entry.status === 'finished') continue;
    result.push({
      toolCallId: entry.snapshot.payload.toolCallId,
      message: entry.snapshot,
      toolCalls: entry.toolCalls,
      taskName: entry.taskName,   // ★ 缺陷①修复：taskName 透传（不经推送载荷，仅查询响应）
    });
  }
  return result;
}

/**
 * 清理会话快照 session（Map.delete 幂等，不存在的会话安全）
 * 调用时机：①轮末统一清理动作 resetConversationTasksDir 函数体内（与 tasks 目录重置同一动作，v2.1 ④）
 *          ②会话删除 conv:delete（deleteConversationRecord 之后）
 * @param conversationId 会话 ID
 */
export function clearSnapshotSession(conversationId: string): void {
  snapshotSessions.delete(conversationId);
}
