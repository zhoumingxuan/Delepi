/**
 * 执行者任务级进程台账（jobList）。
 *
 * 设计边界（对齐技术方案 ③/D6/D7/D8）：
 * - 一任务一份：由 runDelegatedTask 在任务入口创建，经 ToolRuntimeContext.jobList 透传给
 *   run_shell / run_with_python，任务收敛时由外层 finally 统一收网；
 * - 纯内存：不落盘、不写执行日志、不进入 ToolResult 与模型可见上下文；child 句柄永不序列化；
 * - 只按「已登记 PID + 已持有 child 句柄」精确终止：不做进程树枚举、不做外部手段推断后代；
 * - 挂起条目（suspended=true）永不使用负 PID（进程组）终止：挂起 spawn 未设置 detached，
 *   与主进程同组，负 PID 会打到应用自身进程组，属灾难级错误；
 * - 收网永不抛错：任何失败只体现在条目 status = 'reap_failed' 上，不覆盖任务返回值与原始异常。
 */
import type { ChildProcess } from 'node:child_process';

/** 产生台账条目的工具 */
export type TaskProcessTool = 'run_shell' | 'run_with_python';

/** 条目生命周期状态：仅 running 可变，其余状态一律幂等跳过 */
export type TaskProcessStatus = 'running' | 'exited' | 'reaped' | 'reap_failed';

/** 离开 running 的成因：正常退出 / 启动失败 / 执行超时 / 中止 / 任务收网 */
export type TaskProcessCloseReason =
  | 'natural'
  | 'spawn_error'
  | 'timeout'
  | 'abort'
  | 'task_cleanup';

/** 单条进程台账（child 仅内存持有，永不序列化） */
export type TaskJobListEntry = {
  /** 子进程 PID（整数且 > 0） */
  pid: number;
  /** 产生该条目的工具 */
  tool: TaskProcessTool;
  /** true = 挂起模式创建；false = 非挂起 */
  suspended: boolean;
  /** 生命周期状态 */
  status: TaskProcessStatus;
  /** 登记时间（epoch 毫秒） */
  registeredAt: number;
  /** 首次离开 running 的时间（epoch 毫秒） */
  closedAt: number | null;
  /** 离开 running 的成因 */
  closeReason: TaskProcessCloseReason | null;
  /** 进程退出码（诊断字段） */
  closeCode: number | null;
  /** 终止信号（诊断字段） */
  closeSignal: NodeJS.Signals | null;
  /** 子进程句柄（存活判定与终止的权威依据；仅内存） */
  child?: ChildProcess;
};

/** 任务级进程台账容器（一个执行者任务一份） */
export type TaskJobList = {
  /** 委派任务 ID（仅诊断，可空） */
  taskId?: string;
  /** 创建时间（epoch 毫秒） */
  createdAt: number;
  /** 收网开始后置 true，之后不再回退 */
  closed: boolean;
  /** 键为 PID 的条目表 */
  entries: Map<number, TaskJobListEntry>;
};

/**
 * 挂起进程是否纳入任务结束清理（一句话开关）。
 * 用户口径为「只清理非挂起」，故默认 false；改为 true 时挂起条目参与收网，
 * 但终止仍走独立分支（永不使用负 PID）。
 */
export const CLEANUP_SUSPENDED_PROCESSES = false;

/** 收网终止后的确认预算（毫秒） */
export const REAP_CONFIRM_BUDGET_MS = 400;
/** 收网确认轮询间隔（毫秒） */
export const REAP_CONFIRM_INTERVAL_MS = 20;

/** 创建任务级台账（任务入口调用，一任务一份） */
export function createTaskJobList(taskId?: string): TaskJobList {
  return {
    taskId,
    createdAt: Date.now(),
    closed: false,
    entries: new Map<number, TaskJobListEntry>(),
  };
}

/**
 * 挂起条目的终止（独立分支，永不使用负 PID）：
 * 挂起 spawn 未设置 detached，与主进程同组，负 PID 会命中应用自身进程组。
 */
function terminateSuspendedProcess(pid: number, child?: ChildProcess): void {
  if (process.platform === 'win32') {
    try {
      if (child) {
        child.kill();
        return;
      }
    } catch {
      // 句柄终止失败 → 回退单 PID 终止
    }
    try {
      process.kill(pid);
    } catch {
      // 进程已退出或无权限：静默，由收网确认结果决定终态
    }
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 进程已退出（ESRCH）或无权限：静默
  }
}

/**
 * 非挂起条目的终止（独立分支）：
 * POSIX 先按创建期建立的进程组终止（非挂起 spawn detached=true，pid 即组长），失败回退单 PID；
 * Windows 走已持有句柄，失败回退单 PID。
 */
function terminateNonSuspendedProcess(pid: number, child?: ChildProcess): void {
  if (process.platform === 'win32') {
    try {
      if (child) {
        child.kill();
        return;
      }
    } catch {
      // 句柄终止失败 → 回退单 PID 终止
    }
    try {
      process.kill(pid);
    } catch {
      // 静默
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
    return;
  } catch {
    // 进程组已不存在等竞态：回退单 PID 强杀
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 静默
  }
}

/**
 * 登记 PID（spawn 返回后立即调用）。
 * - list 为 undefined 时直接返回（空 context 降级）；
 * - PID 非正整数直接丢弃（不写条目、不抛错）；
 * - 收网已开始（closed=true）时不写条目，立即按 suspended 分流终止新进程（防收网后漏网）；
 * - 同一 PID 已处于 running 时忽略重复登记；已处于终态时覆盖为新条目。
 */
export function registerTaskProcess(
  list: TaskJobList | undefined,
  pid: unknown,
  tool: TaskProcessTool,
  suspended: boolean,
  child?: ChildProcess,
): void {
  if (!list) {
    return;
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (list.closed) {
    if (suspended) {
      terminateSuspendedProcess(pid, child);
    } else {
      terminateNonSuspendedProcess(pid, child);
    }
    return;
  }
  const existing = list.entries.get(pid);
  if (existing && existing.status === 'running') {
    return;
  }
  list.entries.set(pid, {
    pid,
    tool,
    suspended,
    status: 'running',
    registeredAt: Date.now(),
    closedAt: null,
    closeReason: null,
    closeCode: null,
    closeSignal: null,
    child,
  });
}

/**
 * 销账：仅 status === 'running' 的条目可写（其余状态幂等跳过）。
 * 主通道为 child 'exit' 事件；'error' 仅在「句柄确认已终止」时以 spawn_error 补充。
 */
export function markTaskProcessClosed(
  list: TaskJobList | undefined,
  pid: number,
  reason: TaskProcessCloseReason,
  code?: number | null,
  signal?: NodeJS.Signals | null,
): void {
  if (!list) {
    return;
  }
  const entry = list.entries.get(pid);
  if (!entry || entry.status !== 'running') {
    return;
  }
  entry.status = 'exited';
  entry.closedAt = Date.now();
  entry.closeReason = reason;
  entry.closeCode = code ?? null;
  entry.closeSignal = signal ?? null;
}

/** 存活判定：句柄优先（免疫 PID 复用），process.kill(pid, 0) 兜底复核 */
function isTaskProcessAlive(entry: TaskJobListEntry): boolean {
  if (entry.child && (entry.child.exitCode !== null || entry.child.signalCode !== null)) {
    return false;
  }
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** 预算内确认终止结果：超预算仍存活则判失败 */
async function confirmTaskProcessTerminated(entry: TaskJobListEntry): Promise<boolean> {
  const deadline = Date.now() + REAP_CONFIRM_BUDGET_MS;
  while (Date.now() < deadline) {
    if (!isTaskProcessAlive(entry)) {
      return true;
    }
    await sleep(REAP_CONFIRM_INTERVAL_MS);
  }
  return !isTaskProcessAlive(entry);
}

/**
 * 任务收网：只终止「status === 'running' 且 suspended === false（CLEANUP_SUSPENDED_PROCESSES
 * 为 true 时放宽）且进程仍存活」的条目，并在固定预算内确认终止结果。
 * 自身 try/catch 全包，永不抛出；返回 { scanned, killed, failed }。
 */
export async function reapTaskJobList(
  list: TaskJobList | undefined,
): Promise<{ scanned: number; killed: number; failed: number }> {
  const summary = { scanned: 0, killed: 0, failed: 0 };
  if (!list) {
    return summary;
  }
  list.closed = true;
  try {
    const candidates: TaskJobListEntry[] = [];
    for (const entry of list.entries.values()) {
      if (entry.status !== 'running') {
        continue;
      }
      if (!CLEANUP_SUSPENDED_PROCESSES && entry.suspended) {
        continue;
      }
      candidates.push(entry);
    }

    for (const entry of candidates) {
      summary.scanned += 1;
      try {
        if (!isTaskProcessAlive(entry)) {
          // 扫描瞬间已退出：视作自然关闭，不计入终止
          markTaskProcessClosed(list, entry.pid, 'natural');
          continue;
        }

        if (entry.suspended) {
          terminateSuspendedProcess(entry.pid, entry.child);
        } else {
          terminateNonSuspendedProcess(entry.pid, entry.child);
        }

        // 先落终态再确认：防止随后到达的 exit 事件把「被清理杀掉」改写成「正常关闭」
        if (entry.status === 'running') {
          entry.status = 'reaped';
          entry.closedAt = Date.now();
          entry.closeReason = 'task_cleanup';
        }

        const terminated = await confirmTaskProcessTerminated(entry);
        if (!terminated) {
          entry.status = 'reap_failed';
          summary.failed += 1;
        } else {
          summary.killed += 1;
        }
      } catch {
        summary.failed += 1;
        if (entry.status === 'running' || entry.status === 'reaped') {
          entry.status = 'reap_failed';
          entry.closedAt = Date.now();
          entry.closeReason = 'task_cleanup';
        }
      }
    }
  } catch {
    // 收网永不抛出：任何异常只体现为 failed 计数与条目终态
  }
  return summary;
}
