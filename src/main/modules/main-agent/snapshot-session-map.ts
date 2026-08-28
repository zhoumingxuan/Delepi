
import { resolveExecutorToolProgressDisplayName } from '../../constants/agent';
import { getDynamicExecutorToolMeta } from '../../tools/executor-registry';

/**
 * 子智能体单次工具调用快照（M9：仅内存结构——D6/规则④，绝不进 StreamMessage.payload 与推送载荷；
 * 仅经轻量查询响应外流）
 * upsert 键=callId（子智能体工具真实调用 ID，executor-agent.ts 回调透传）
 */
export interface ExecutorToolCallSnapshot {
  /** 子智能体工具真实 callId（与主智能体委派 toolCall.id 不同层） */
  callId: string;
  name: string;
  /** loading=调用中 / success=完成 / error=失败（与前端 ToolCallInfo.status 同构） */
  status: 'loading' | 'success' | 'error';
  startedAt?: string;
  finishedAt?: string;
}

/**
 * 单个委派任务快照条目
 */
export interface TaskSnapshotEntry {
  thinking: string;
  toolCall: { toolCallId: string; name: string; arguments: string };
  createdAt: string;
  status: 'init' | 'running' | 'finished';
  finishedAt?: string;
  /** 任务名称：来自 delegate_executor 委派参数 taskname（创建点解析写入，缺失时前端走"子智能体任务"兜底） */
  taskName?: string;
  /** ★ M9：任务期间累计的工具调用数组（仅内存；按 callId upsert，末项=最新一条） */
  toolCalls: ExecutorToolCallSnapshot[];
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
 * @param delegateToolCallId 委派工具调用 ID（=内层 Map 键）
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

  let entry = session.tasksSnapshot.get(delegateToolCallId);
  if (!entry) {
    const nowIso = new Date().toISOString();
    entry = {
      thinking: '',
      toolCall: { toolCallId: delegateToolCallId, name: '', arguments: '' },
      createdAt: nowIso,
      status: 'init',
      toolCalls: [],
    };
    session.tasksSnapshot.set(delegateToolCallId, entry);
  }
  const toolCalls = [...entry.toolCalls];
  const idx = toolCalls.findIndex((tc) => tc.callId === toolCall.callId);
  if (idx >= 0) {
    // 命中同 callId：原样整体替换
    toolCalls[idx] = toolCall;
  } else {
    // 未命中：push 到末尾（末项=最新一条）
    toolCalls.push(toolCall);
  }
  entry.toolCalls = toolCalls;
}

/**
 * 工具调用快照 → 中文友好文案（三态模板逐字对齐 executor-agent.ts buildExecutorToolProgressText；
 * 工具名→中文显示名复用 resolveExecutorToolProgressDisplayName 三级回退映射，不返回原始工具 ID 名）
 */
function buildSnapshotToolProgressText(toolCall: ExecutorToolCallSnapshot): string {
  const toolDisplayName = resolveExecutorToolProgressDisplayName(
    toolCall.name,
    getDynamicExecutorToolMeta(toolCall.name),
  );

  if (toolCall.status === 'loading') {
    return `正在调用${toolDisplayName}工具...`;
  }

  if (toolCall.status === 'error') {
    return `${toolDisplayName}工具返回错误，正在调整处理方式...`;
  }

  return `${toolDisplayName}工具完成，继续处理...`;
}

/**
 * 轻量查询：读取会话任务快照条目（M21 前端轻量消费函数唯一数据源）
 * - 返回每个任务的 toolCallId（用于对应快照）、累计思考内容（thinking）与
 *   最新一条工具调用的中文友好文案（latestToolCallText）
 * - 条目清理统一由 clearSnapshotSession 承担，未清理前均外流显示
 */
export function getRunningSnapshotEntries(
  conversationId: string,
): Array<{ toolCallId: string; thinking: string; latestToolCallText: string; taskName: string }> {
  const session = snapshotSessions.get(conversationId);
  if (!session) return [];
  const result: Array<{ toolCallId: string; thinking: string; latestToolCallText: string; taskName: string }> = [];
  for (const entry of session.tasksSnapshot.values()) {
    // 最新一条工具调用：默认取 startedAt，存在 finishedAt 则替换 startedAt 参与排序，取时间最大的一条
    let latestToolCall: ExecutorToolCallSnapshot | undefined;
    let latestTime = Number.NEGATIVE_INFINITY;
    for (const toolCall of entry.toolCalls) {
      const stamp = toolCall.finishedAt ?? toolCall.startedAt;
      const time = stamp ? Date.parse(stamp) : Number.NEGATIVE_INFINITY;
      if (time >= latestTime) {
        latestTime = time;
        latestToolCall = toolCall;
      }
    }
    result.push({
      toolCallId: entry.toolCall.toolCallId,
      thinking: entry.thinking,
      latestToolCallText: latestToolCall ? buildSnapshotToolProgressText(latestToolCall) : '',
      taskName: entry.taskName ?? '',
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
