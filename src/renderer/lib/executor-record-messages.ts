/**
 * executor 任务记录 → 虚拟 ChatMessage 纯函数库（新版设计方案 M6 / §4.3 / §7.6）
 *
 * - buildExecutorTaskMessages：任务视图 → 虚拟 ChatMessage（role='tool'、source='executor'、
 *   携带 executorTask 徽标）；虚拟消息 id=executor-task-{delegateCallId}，
 *   toolCall.callId=delegateCallId（供 ChatArea 时间线合并时与真实 tool 消息去重）。
 * - latestThinkingLineOf：任务卡"最新一行思考"取值规则（§6.1-R1，数据源=executor 任务级思考）。
 *
 * 纯函数无 React 依赖；类型与主进程 store 同构（@shared/types/executor-record）。
 */

import type { ChatMessage } from '../hooks/useChat';
import type {
  ExecutorRecordEntry,
  ExecutorTaskRecordStatus,
} from '@shared/types/executor-record';

/** hook 本地任务视图（增量合并结果；与主进程 session 同构 + 归档标记） */
export interface ExecutorTaskView {
  conversationId: string;
  delegateCallId: string;
  taskId: string;
  taskName: string;
  status: ExecutorTaskRecordStatus;
  latestSeq: number;
  entries: ExecutorRecordEntry[];
  createdAt: string;
  finishedAt?: string;
  /** 主进程记录是否存续（false=已随轮末清理归档：图标按钮卸载、右栏转归档空态） */
  hasRecords: boolean;
}

/** 任务卡徽标：挂到虚拟 ChatMessage 上（结构化扩展，不改 useChat.ChatMessage 类型） */
export interface ExecutorTaskBadge {
  delegateCallId: string;
  taskName: string;
  status: ExecutorTaskRecordStatus;
  /** 最新一行思考（草稿优先，§6.1-R1 规则）；无思考时为空串（卡显示占位） */
  latestThinkingLine: string;
  /** 记录是否仍在主进程存续（决定图标按钮可否打开右栏） */
  hasRecords: boolean;
  startedAt: string;
  finishedAt?: string;
}

/** 虚拟消息类型（本库产物；ChatMessageContent 据此分发任务卡分支） */
export type ExecutorTaskChatMessage = ChatMessage & { executorTask: ExecutorTaskBadge };

/** 取文本按 \n 切分后的最后一个非空行（无内容返回空串） */
function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line) {
      return line;
    }
  }
  return '';
}

/**
 * 任务卡"最新一行思考"取值规则（§6.1-R1；数据源=executor 任务级思考，与主智能体思考零交集）：
 * 1. 存在 status:'running' 思考草稿条目 → 取草稿 text 的最后一个非空行；
 * 2. 无草稿（工具执行中/轮间隙）→ 取最近一条 completed 思考条目的最后一个非空行；
 * 3. 从未有思考条目 → 空串（卡显示占位文案）。
 */
export function latestThinkingLineOf(view: ExecutorTaskView): string {
  const entries = view.entries ?? [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.kind === 'thinking') {
      // 末条思考条目即目标：存在 running 草稿时必为末条（R1-1），否则为最近一条 completed（R1-2）
      return lastNonEmptyLine(entry.text);
    }
  }
  return '';
}

/** 任务状态 → ChatMessage.status 映射（running→loading / completed→success / failed·aborted→error） */
function mapTaskStatusToMessageStatus(status: ExecutorTaskRecordStatus): ChatMessage['status'] {
  if (status === 'running') return 'loading';
  if (status === 'completed') return 'success';
  return 'error';
}

/**
 * 任务视图 → 虚拟 ChatMessage 列表（仅保留当前会话且记录存续的任务）
 * 虚拟消息 toolCall.callId=delegateCallId —— 真实 tool 消息（tool.message.created）到达后
 * 由 ChatArea 既有 existingToolCallIds 机制去重替换（时间线自然切回既有 Result 渲染）。
 */
export function buildExecutorTaskMessages(
  taskViews: Record<string, ExecutorTaskView>,
  conversationId: string | null,
): ExecutorTaskChatMessage[] {
  if (!conversationId) return [];
  return Object.values(taskViews)
    .filter((view) => view.conversationId === conversationId && view.hasRecords)
    .map((view) => {
      const badge: ExecutorTaskBadge = {
        delegateCallId: view.delegateCallId,
        taskName: view.taskName,
        status: view.status,
        latestThinkingLine: latestThinkingLineOf(view),
        hasRecords: view.hasRecords,
        startedAt: view.createdAt,
        ...(view.finishedAt ? { finishedAt: view.finishedAt } : {}),
      };
      return {
        id: `executor-task-${view.delegateCallId}`,
        role: 'tool' as const,
        content: '',
        toolCall: {
          callId: view.delegateCallId,
          name: view.taskName || '子智能体任务',
          arguments: '',
          status:
            view.status === 'running'
              ? ('loading' as const)
              : view.status === 'completed'
                ? ('success' as const)
                : ('error' as const),
          startedAt: view.createdAt,
          ...(view.finishedAt ? { finishedAt: view.finishedAt } : {}),
          isError: view.status === 'failed' || view.status === 'aborted',
          isDelegatedExecutor: true,
        },
        status: mapTaskStatusToMessageStatus(view.status),
        createdAt: view.createdAt,
        source: 'executor' as const,
        executorTask: badge,
      };
    });
}
