/**
 * 委派任务执行记录——跨进程共享类型（主进程 record-store 与渲染进程 hook 共同 import）
 *
 * 新版设计方案 §3.2/§3.3：
 * - 显示视图条目（思考 / 工具两类，seq 任务内统一单调递增）
 * - 渲染信号载荷（executor:record-signal，极小信号 <200B）
 * - 增量查询响应（executor:get-task-record，sinceSeq 增量 + running 草稿恒返 + reset 兜底）
 *
 * 放置于 shared 层以保持 renderer → preload → IPC → main 单向依赖（渲染端不 import 主进程模块）。
 * 跨进程以结构化 JSON 传输（IPC 结构化克隆），不含任何主进程内部对象。
 */

/** 显示视图条目：思考类（思考草稿 running → 轮界 seal completed，规则 R-draft-1~7） */
export interface ExecutorThinkingRecord {
  kind: 'thinking';
  /** 会话内单调递增序号（任务维度），跨思考/工具统一编号（= 右栏时间线序号） */
  seq: number;
  /** running=思考中流未结束（草稿）；completed=已 seal（权威全文） */
  status: 'running' | 'completed';
  /** 显示文本（控制字符净化后全文，不截断）；running 期间随 delta 累积，seal 后为权威全文 */
  text: string;
  /** 开始时刻（ISO） */
  startedAt: string;
  /** seal 时刻（ISO） */
  finishedAt?: string;
}

/** 显示视图条目：工具调用类 */
export interface ExecutorToolRecord {
  kind: 'tool';
  seq: number;
  /** 子智能体工具真实 callId（executor-agent onToolCall/onToolResult 回调透传） */
  callId: string;
  /** 原始工具名（如 run_with_python） */
  name: string;
  /** running=执行中 / completed=已完成 / failed=失败（或中断/取消收敛） */
  status: 'running' | 'completed' | 'failed';
  /** 显示用参数全文（控制字符清理；JSON 美化失败则保持原样，不截断） */
  argsPreview: string;
  /** 显示用结果全文（仅工具结束时写入，不截断） */
  resultPreview?: string;
  /** 开始时刻（ISO） */
  startedAt: string;
  /** 结束时刻（ISO） */
  finishedAt?: string;
  /** 查询出口经三级回退映射后的工具显示名（progressName → displayName → 原始名） */
  displayName?: string;
}

export type ExecutorRecordEntry = ExecutorThinkingRecord | ExecutorToolRecord;

/** 任务状态（running → completed / failed / aborted；终态后 records 冻结只读） */
export type ExecutorTaskRecordStatus = 'running' | 'completed' | 'failed' | 'aborted';

/**
 * 渲染信号载荷（executor:record-signal，主→渲染，唯一推送通道）
 * 信号与内容彻底解耦：只携带对账基准，内容一律由渲染端按信号主动拉取。
 */
export interface ExecutorTaskRecordSignal {
  conversationId: string;
  /** 委派工具调用 id（= 主智能体 delegate_executor 的 toolCall.id，前端寻址主键） */
  delegateCallId: string;
  /** 委派任务 uuid（main-agent 委派闭包生成） */
  taskId: string;
  /** 信号发出时刻该任务 latestSeq（单调不减，渲染端乱序守卫与对账基准） */
  latestSeq: number;
  status: ExecutorTaskRecordStatus;
  /** 信号时刻（ISO） */
  updatedAt: string;
}

/**
 * 增量查询响应（executor:get-task-record invoke 返回）
 * 合并规则（渲染端）：reset=true → 整体替换；否则 entries 中已存在 seq 覆盖、不存在按 seq 插入。
 */
export interface ExecutorTaskRecordQueryResult {
  found: boolean;
  taskName: string;
  status: ExecutorTaskRecordStatus;
  latestSeq: number;
  /** seq > sinceSeq 的条目 ∪ 当前 running 思考草稿（恒返最新全文，R-draft-3） */
  entries: ExecutorRecordEntry[];
  /** 服务端 latestSeq < 请求 sinceSeq（会话已清理重建）→ 前端整体重置 */
  reset?: boolean;
}
