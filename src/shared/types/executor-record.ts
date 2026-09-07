/**
 * 委派任务执行记录——跨进程共享类型（主进程 record-store 与渲染进程 hook 共同 import）
 *
 * 新版设计方案 §3.2/§3.3：
 * - 显示视图条目（思考 / 工具 / 通知三类，seq 任务内统一单调递增）
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


/** 显示视图条目：任务级通知类（当前仅任务级手动停止通知；静态单时刻条目、无 running/草稿语义、无 status） */
export interface ExecutorNoticeRecord {
  kind: 'notice';
  seq: number;
  /** 通知类型：目前仅 'stop'（任务级手动停止）；未来同类静态通知在此扩联合 */
  type: 'stop';
  /** 展示文本（如“{任务名} 已停止，用户手动取消。”——模板既有，逐字保留） */
  text: string;
  /** 通知产生时刻（ISO；渲染头部时钟 formatEntryClock 取此字段） */
  createdAt: string;
}

/** 显示视图条目：任务级交互消息（用户运行中消息；有状态机——queued→delivered/undelivered，
 *  状态转移经 mutatedSeqs 原位补发，与 notice 的静态单时刻语义不同，故独立第四 kind） */
export interface ExecutorUserMessageRecord {
  kind: 'user-message';
  /** 会话内单调递增序号（nextSeq 统一分配；= 右栏时间线序号） */
  seq: number;
  /** 用户消息原文（显示视图：控制字符净化后全文，不截断；与 modelMessages 注入文本双视图分离） */
  text: string;
  /** queued=排队中（等待安全点注入）；delivered=已送达（已写入 modelMessages，模型下一轮可见）；
   *  undelivered=未送达（任务终态时仍在排队/未获送达证明，终态清扫收敛） */
  state: 'queued' | 'delivered' | 'undelivered';
  /** 入队时刻（ISO；渲染头部时钟 formatEntryClock 取此字段） */
  createdAt: string;
  /** 送达时刻（ISO；仅 state='delivered' 时存在） */
  deliveredAt?: string;
}

/** 显示视图条目：任务级助手回复（子智能体对【用户提示】的回复；有状态机——loading→completed/aborted，
 *  状态转移经 mutatedSeqs 原位补发，与 user-message 的状态机语义同族，故独立第五 kind） */
export interface ExecutorAssistantReplyRecord {
  kind: 'assistant-reply';
  /** 会话内单调递增序号（nextSeq 统一分配；= 右栏时间线序号；必然大于其对应 user-message 条目 seq——
   *  开槽发生在 consumePendingUserMessages 同一同步调用内，紧随本批 delivered 消息之后） */
  seq: number;
  /** 回复正文（completed 态非空；控制字符净化后全文，不截断；首行【助手回复】标记已由后端剥离——
   *  本字段不含标记文本；loading/aborted 态为空串） */
  text: string;
  /** loading=已送达待回复（consumePendingUserMessages 开槽，前端展示 loading 态）；
   *  completed=轮收口剥离标记提取正文完结；aborted=任务终态时仍未收到回复（终态清扫收敛） */
  state: 'loading' | 'completed' | 'aborted';
  /** 开槽时刻（ISO；渲染头部时钟 formatEntryClock 取此字段） */
  createdAt: string;
  /** 完结/收敛时刻（ISO；仅 completed/aborted 态存在） */
  finishedAt?: string;
}

export type ExecutorRecordEntry =
  | ExecutorThinkingRecord
  | ExecutorToolRecord
  | ExecutorNoticeRecord
  | ExecutorUserMessageRecord
  | ExecutorAssistantReplyRecord;

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

/** executor:send-task-message 请求参数（渲染→主，invoke） */
export interface ExecutorTaskMessageSendParams {
  conversationId: string;
  delegateCallId: string;
  message: string;
}

/** executor:send-task-message 受理失败原因（后端主进程产生；unavailable/ipc-error 为渲染层自产） */
export type ExecutorTaskMessageSendFailReason =
  | 'empty'            // 消息 trim 后为空（前端已拦截，双保险）
  | 'too-long'         // 超过单条上限（EXECUTOR_TASK_MESSAGE_MAX_LENGTH，默认 4000）
  | 'queue-full'       // 排队队列超上限（EXECUTOR_TASK_MESSAGE_MAX_PENDING，默认 10）
  | 'not-found'        // 会话/任务不存在或已清理
  | 'terminal'         // 任务已终态（status !== 'running'）
  | 'stop-requested'   // 停止请求已冻结（freezeForStop 已置、终态未收敛窗口）
  | 'unavailable'      // 渲染层：preload 方法不存在（类型收窄命中空）
  | 'ipc-error';       // 渲染层：invoke 异常

/** executor:send-task-message 返回（受理结果；受理后的视觉态由 record-signal 链路驱动） */
export interface ExecutorTaskMessageSendResult {
  accepted: boolean;
  reason?: ExecutorTaskMessageSendFailReason;
}
