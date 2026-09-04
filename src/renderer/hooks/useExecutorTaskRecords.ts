/**
 * useExecutorTaskRecords —— executor 任务记录渲染侧唯一数据 hook（新版设计方案 M5 / §3.3 / §7.6）
 *
 * 职责：
 * 1. 订阅 executor:record-signal（经 preload；信号不携带内容）；
 * 2. 按信号增量拉取 executor:get-task-record（per-task in-flight/dirty 补偿 + 200ms 去抖，
 *    模式复刻 useChat 旧信号订阅块的 M13 补偿机件）；
 * 3. 本地任务记录视图状态（Record<delegateCallId, ExecutorTaskView>，拉取为准合并：reset 整体替换 /
 *    seq 已存在覆盖 / 不存在按 seq 插入）；
 * 4. 兜底对账：5s 心跳（仅存在 running 任务时拉取）/ 切换会话全量对账 / 窗口 focus 重对账 /
 *    打开右栏全量拉取；
 * 5. 终态双保险：chat:done 最后一次增量对账（仍 running → completed）；chat:aborted 本地
 *    running 视图收敛 aborted。
 *
 * 思考数据来源唯一性（§1.4）：本 hook 只消费 executor:record-signal / executor:get-task-record，
 * 不订阅 chat:thinking，不读取 message.thinking / message.segments（主智能体链路零交集）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from './useChat';
import {
  buildExecutorTaskMessages,
  type ExecutorTaskChatMessage,
  type ExecutorTaskView,
} from '../lib/executor-record-messages';
import type {
  ExecutorRecordEntry,
  ExecutorTaskRecordQueryResult,
  ExecutorTaskRecordSignal,
  ExecutorTaskRecordStatus,
} from '@shared/types/executor-record';

/**
 * 显示侧单点回滚开关（新版方案 §11）：置 false 即整体停用新显示侧
 * （右栏不挂载、任务卡徽标分支短路回既有渲染）；主进程记录与信号不受影响。
 * 该开关为纯显示开关，非交互功能开关。
 */
export const EXECUTOR_RECORD_PANEL_ENABLED = true;

/** 信号去抖窗口（对齐旧管道 M13 补偿机件的 200ms 模式） */
const SIGNAL_DEBOUNCE_MS = 200;
/** 心跳对账间隔（仅存在 running 任务时启用） */
const HEARTBEAT_INTERVAL_MS = 5_000;

export type { ExecutorTaskView, ExecutorTaskBadge, ExecutorTaskChatMessage } from '../lib/executor-record-messages';

interface TaskQueryState {
  dirty: boolean;
  timer: number | null;
  inFlight: boolean;
}

export interface UseExecutorTaskRecordsResult {
  /** 全部任务视图（按 delegateCallId 索引；含归档态 hasRecords=false 条目供右栏空态消费） */
  taskViews: Record<string, ExecutorTaskView>;
  /** 打开右栏并全量拉取目标任务（目标不同即切换） */
  openTask: (delegateCallId: string) => void;
  /** 关闭右栏 */
  closePanel: () => void;
  /** 右栏当前目标任务 id（唯一目标状态） */
  activeDelegateCallId: string | null;
  /** 右栏当前目标任务视图（无目标或已归档时可能为 null / hasRecords=false） */
  activeTaskView: ExecutorTaskView | null;
  /** 时间线合并用虚拟消息（仅当前会话且记录存续的任务） */
  executorTaskMessages: ChatMessage[];
}

export function useExecutorTaskRecords(options: {
  conversationId: string | null;
}): UseExecutorTaskRecordsResult {
  const { conversationId } = options;

  const [taskViews, setTaskViews] = useState<Record<string, ExecutorTaskView>>({});
  const [activeDelegateCallId, setActiveDelegateCallId] = useState<string | null>(null);

  /** 视图镜像（订阅闭包内读最新，避免闭包过期） */
  const taskViewsRef = useRef<Record<string, ExecutorTaskView>>({});
  taskViewsRef.current = taskViews;
  /** 当前活跃会话镜像 */
  const conversationIdRef = useRef<string | null>(conversationId);
  conversationIdRef.current = conversationId;
  /** delegateCallId → conversationId 登记（信号到达即登记，非活跃会话任务切回时全量对账依据） */
  const taskConversationIndexRef = useRef<Map<string, string>>(new Map());
  /** per-task 拉取状态（in-flight 去重 + dirty 补偿轮） */
  const queryStatesRef = useRef<Map<string, TaskQueryState>>(new Map());
  /** 活跃会话已知任务集合（按会话隔离，切回时全量对账） */
  const knownTasksByConversationRef = useRef<Map<string, Set<string>>>(new Map());

  const getQueryState = useCallback((delegateCallId: string): TaskQueryState => {
    let state = queryStatesRef.current.get(delegateCallId);
    if (!state) {
      state = { dirty: false, timer: null, inFlight: false };
      queryStatesRef.current.set(delegateCallId, state);
    }
    return state;
  }, []);

  /** 增量合并（拉取为准）：reset 整体替换；seq 已存在覆盖、不存在按 seq 插入；
   *  服务端保证唯一 running 思考草稿恒在每个响应中——本地 running 思考条目未出现在响应中
   *  即已被 seal/移除，本地收敛为 completed（防游标永久滞留）。 */
  const applyQueryResult = useCallback(
    (delegateCallId: string, result: ExecutorTaskRecordQueryResult) => {
      const conversationIdOfTask = taskConversationIndexRef.current.get(delegateCallId);
      if (!conversationIdOfTask) {
        return;
      }
      setTaskViews((prev) => {
        const existing = prev[delegateCallId];
        if (!result.found) {
          if (!existing) {
            return prev; // 未知任务且已清理：不建视图
          }
          // 记录已随轮末/会话删除清理：保留元数据（右栏归档空态），清空条目，卸载入口
          return {
            ...prev,
            [delegateCallId]: { ...existing, entries: [], hasRecords: false },
          };
        }

        let baseEntries: ExecutorRecordEntry[] = [];
        if (existing && !result.reset) {
          baseEntries = [...existing.entries];
        }
        const servedSeqs = new Set(result.entries.map((entry) => entry.seq));
        const merged: ExecutorRecordEntry[] = [...baseEntries];
        for (const entry of result.entries) {
          const index = merged.findIndex((item) => item.seq === entry.seq);
          if (index >= 0) {
            merged[index] = entry;
          } else {
            merged.push(entry);
          }
        }
        // running 思考草稿权威收敛：响应必含当前 running 草稿；未随响应返回的本地
        // running 思考条目（seq ≤ 响应 latestSeq）已被 seal —— 本地收敛为 completed
        for (let i = 0; i < merged.length; i += 1) {
          const item = merged[i];
          if (item.kind === 'thinking' && item.status === 'running' && !servedSeqs.has(item.seq)) {
            merged[i] = {
              ...item,
              status: 'completed',
              finishedAt: item.finishedAt ?? new Date().toISOString(),
            };
          }
        }
        merged.sort((left, right) => left.seq - right.seq);

        const nextView: ExecutorTaskView = {
          conversationId: conversationIdOfTask,
          delegateCallId,
          taskId: existing?.taskId ?? '',
          taskName: result.taskName || existing?.taskName || '',
          status: result.status,
          latestSeq: result.latestSeq,
          entries: merged,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          ...(result.status === 'running'
            ? {}
            : { finishedAt: existing?.finishedAt ?? new Date().toISOString() }),
          hasRecords: true,
        };
        return { ...prev, [delegateCallId]: nextView };
      });
    },
    [],
  );

  /** 单任务拉取（in-flight 去重 + dirty 补偿轮；invoke 异常吞掉交由下一信号/心跳重试） */
  const runFetch = useCallback(
    (targetConversationId: string, delegateCallId: string, sinceSeq: number) => {
      const state = getQueryState(delegateCallId);
      if (state.inFlight) {
        state.dirty = true;
        return;
      }
      state.inFlight = true;
      window.electronAPI.executor
        .getTaskRecord({ conversationId: targetConversationId, delegateCallId, sinceSeq })
        .catch(() => undefined)
        .then((result) => {
          if (result) {
            applyQueryResult(delegateCallId, result);
          }
        })
        .finally(() => {
          state.inFlight = false;
          if (state.dirty) {
            state.dirty = false;
            const view = taskViewsRef.current[delegateCallId];
            runFetch(targetConversationId, delegateCallId, view?.latestSeq ?? 0);
          }
        });
    },
    [applyQueryResult, getQueryState],
  );

  /** 信号驱动拉取（200ms 去抖；乱序守卫：严格小于本地 latestSeq 的迟到信号忽略） */
  const scheduleFetchBySignal = useCallback(
    (signal: ExecutorTaskRecordSignal) => {
      const { conversationId: signalConversationId, delegateCallId } = signal;
      taskConversationIndexRef.current.set(delegateCallId, signalConversationId);
      let known = knownTasksByConversationRef.current.get(signalConversationId);
      if (!known) {
        known = new Set();
        knownTasksByConversationRef.current.set(signalConversationId, known);
      }
      known.add(delegateCallId);

      const local = taskViewsRef.current[delegateCallId];
      if (local) {
        // 乱序守卫（§3.3）：迟到信号（latestSeq 严格更小且状态无新信息）忽略，不触发拉取
        const staleSignal =
          signal.latestSeq < local.latestSeq ||
          (signal.latestSeq === local.latestSeq &&
            signal.status === local.status &&
            local.status !== 'running');
        if (staleSignal) {
          return;
        }
        if (!local.hasRecords) {
          return; // 已归档任务不再拉取
        }
      }

      // 非当前活跃会话：登记但不拉取（切回会话时全量对账兜底）
      if (signalConversationId !== conversationIdRef.current) {
        return;
      }

      const state = getQueryState(delegateCallId);
      state.dirty = true;
      if (state.timer !== null) {
        return;
      }
      state.timer = window.setTimeout(() => {
        state.timer = null;
        if (!state.dirty) return;
        state.dirty = false;
        const view = taskViewsRef.current[delegateCallId];
        runFetch(signalConversationId, delegateCallId, view?.latestSeq ?? 0);
      }, SIGNAL_DEBOUNCE_MS);
    },
    [getQueryState, runFetch],
  );

  /** 全量拉取（打开右栏 / 切回会话对账：sinceSeq=0 一次性建立完整时间线） */
  const fetchFull = useCallback(
    (targetConversationId: string, delegateCallId: string) => {
      runFetch(targetConversationId, delegateCallId, 0);
    },
    [runFetch],
  );

  /** 订阅：渲染信号 + chat:done / chat:aborted 双保险 + 心跳 + focus 对账 */
  useEffect(() => {
    const unsubSignal = window.electronAPI.executor.onRecordSignal((payload: unknown) => {
      const signal = payload as ExecutorTaskRecordSignal;
      if (!signal?.conversationId || !signal.delegateCallId) return;
      scheduleFetchBySignal(signal);
    });

    // chat:done → 该会话全部任务最后一次增量对账（仍 running → 兜底映射见 applyQueryResult 后处理）
    const unsubDone = window.electronAPI.on('chat:done', (payload: unknown) => {
      const data = payload as { conversationId?: string };
      if (!data?.conversationId) return;
      const views = taskViewsRef.current;
      for (const [delegateCallId, view] of Object.entries(views)) {
        if (view.conversationId !== data.conversationId) continue;
        runFetch(data.conversationId, delegateCallId, view.latestSeq);
      }
    });

    // chat:aborted → 该会话 running 视图本地收敛 aborted（终态信号丢失兜底）
    const unsubAborted = window.electronAPI.on('chat:aborted', (payload: unknown) => {
      const data = payload as { conversationId?: string };
      if (!data?.conversationId) return;
      setTaskViews((prev) => {
        let changed = false;
        const next: Record<string, ExecutorTaskView> = {};
        for (const [delegateCallId, view] of Object.entries(prev)) {
          if (view.conversationId === data.conversationId && view.status === 'running') {
            changed = true;
            next[delegateCallId] = {
              ...view,
              status: 'aborted' as ExecutorTaskRecordStatus,
              finishedAt: view.finishedAt ?? new Date().toISOString(),
            };
          } else {
            next[delegateCallId] = view;
          }
        }
        return changed ? next : prev;
      });
    });

    // 5s 心跳：活跃会话存在 running 任务时逐任务增量对账（长时无信号/hung 兜底）
    const heartbeatTimer = window.setInterval(() => {
      const activeId = conversationIdRef.current;
      if (!activeId) return;
      const views = taskViewsRef.current;
      const hasRunning = Object.values(views).some(
        (view) => view.conversationId === activeId && view.status === 'running' && view.hasRecords,
      );
      if (!hasRunning) return;
      for (const [delegateCallId, view] of Object.entries(views)) {
        if (view.conversationId === activeId && view.status === 'running' && view.hasRecords) {
          runFetch(activeId, delegateCallId, view.latestSeq);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);

    // 窗口 blur→focus 重对账：存在 running 任务时逐任务增量拉一次
    const handleFocus = () => {
      const activeId = conversationIdRef.current;
      if (!activeId) return;
      const views = taskViewsRef.current;
      for (const [delegateCallId, view] of Object.entries(views)) {
        if (
          view.conversationId === activeId &&
          view.status === 'running' &&
          view.hasRecords
        ) {
          runFetch(activeId, delegateCallId, view.latestSeq);
        }
      }
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      unsubSignal();
      unsubDone();
      unsubAborted();
      window.clearInterval(heartbeatTimer);
      window.removeEventListener('focus', handleFocus);
      for (const state of queryStatesRef.current.values()) {
        if (state.timer !== null) {
          window.clearTimeout(state.timer);
          state.timer = null;
        }
        state.dirty = false;
      }
    };
  }, [scheduleFetchBySignal, runFetch]);

  /** 切换会话 → 新活跃会话已知任务全量对账（拉取为准恢复）；右栏目标不属于新会话则自动关闭 */
  const prevConversationIdRef = useRef<string | null>(conversationId);
  useEffect(() => {
    if (prevConversationIdRef.current === conversationId) {
      return;
    }
    prevConversationIdRef.current = conversationId;
    if (conversationId) {
      const known = knownTasksByConversationRef.current.get(conversationId);
      if (known) {
        for (const delegateCallId of known) {
          fetchFull(conversationId, delegateCallId);
        }
      }
    }
    // 右栏目标不属于新活跃会话 → 自动关闭（§8.2 切换会话规则）
    if (activeDelegateCallId) {
      const activeView = taskViewsRef.current[activeDelegateCallId];
      if (!conversationId || !activeView || activeView.conversationId !== conversationId) {
        setActiveDelegateCallId(null);
      }
    }
  }, [conversationId, activeDelegateCallId, fetchFull]);

  const openTask = useCallback(
    (delegateCallId: string) => {
      setActiveDelegateCallId(delegateCallId);
      const targetConversationId =
        taskConversationIndexRef.current.get(delegateCallId) ?? conversationIdRef.current;
      if (targetConversationId) {
        fetchFull(targetConversationId, delegateCallId);
      }
    },
    [fetchFull],
  );

  const closePanel = useCallback(() => {
    setActiveDelegateCallId(null);
  }, []);

  const activeTaskView = activeDelegateCallId
    ? taskViews[activeDelegateCallId] ?? null
    : null;

  const executorTaskMessages = useMemo<ChatMessage[]>(
    () => buildExecutorTaskMessages(taskViews, conversationId),
    [taskViews, conversationId],
  );

  return {
    taskViews,
    openTask,
    closePanel,
    activeDelegateCallId,
    activeTaskView,
    executorTaskMessages,
  };
}
