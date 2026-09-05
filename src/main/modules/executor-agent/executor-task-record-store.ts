/**
 * 执行子智能体任务内存记录存储（新版设计方案 M1 / §3.2 / §7.2）
 *
 * 双视图共享存储：
 * - modelMessages（真实内容视图）：executor 循环唯一 push 目标，与给大模型的上下文
 *   （runtimeMessages）同引用共享（adoptMessages 领养语义）——真实视图零加工、显示视图
 *   仅做控制字符净化不回写，保证模型上下文纯净。
 * - records（显示视图）：思考/工具两类条目（append-only、seq 单调、上限 500 条），
 *   由结构化边界（思考 delta / 轮 seal / 工具事件 / 终态）驱动更新。
 *
 * 渲染信号：内建 200ms leading+trailing 节流发射 executor:record-signal（极小载荷），
 * 轮 seal / 工具事件 / 终态立即发；终态前冲刷并作废挂起 trailing（保证终态信号最后一条）。
 *
 * 草稿规则 R-draft-1~7（思考中流未结束时的中间快照保留规则）：
 * - R-draft-1 草稿创建：本轮首个 reasoning delta 到达时创建 running 草稿条目；
 * - R-draft-2 草稿更新：后续 delta 追加（不新增 seq），显示文本存净化后全文不截断；
 * - R-draft-3 草稿外流：任何增量查询响应恒定携带当前 running 草稿最新全文；
 * - R-draft-4 草稿 seal：onTurnEnd 用 extractAssistantReasoning 权威全文覆盖收口；
 * - R-draft-5 空思考轮：该轮 reasoning 为空 → 不建草稿、不产生思考条目；
 * - R-draft-6 重试复位：onStreamRetry → 当前 running 草稿整体清空重建；
 * - R-draft-7 任务终态：仍有 running 草稿 → 以当前累积文本强制 seal 为 completed。
 *
 * 幂等守卫：终态后全部写入 API no-op（防迟到回调写脏）；endToolCall 对已终态工具条目
 * 不再转移状态；markTerminal 幂等。
 */

import type OpenAI from 'openai';

import { eventBus } from '../event-bus/event-bus';
import { EXECUTOR_RECORD_SIGNAL_EVENT } from '../../constants/events';
import { resolveExecutorToolProgressDisplayName } from '../../constants/agent';
import { getDynamicExecutorToolMeta } from '../../tools/executor-registry';
import type {
  ExecutorRecordEntry,
  ExecutorTaskRecordQueryResult,
  ExecutorTaskRecordSignal,
  ExecutorTaskRecordStatus,
  ExecutorThinkingRecord,
  ExecutorToolRecord,
} from '@shared/types/executor-record';

/**
 * 与 executor-agent.ts 内部 RuntimeMessage 为同一类型定义
 * （OpenAI.Chat.ChatCompletionMessageParam 别名；此处独立声明避免与 executor-agent 形成运行时循环依赖，
 *  结构化类型保证两者完全兼容）
 */
export type RuntimeMessage = OpenAI.Chat.ChatCompletionMessageParam;

// ============================================================
// 显示视图构造常量（上限，§4.2 脱敏格式化规则）
// 2026-09-04 四点修复 Q1/Q2：思考文本 / 工具参数 / 工具结果预览均存净化后全文，
// 显示层字数截断机制（truncateDisplay + 3 个阈值常量 + 尾标）已整体移除（零死代码）。
// ============================================================

/** 显示视图条目上限（超限逐出最老 thinking 条目） */
const MAX_RECORDS = 500;
/** 渲染信号节流窗口（leading+trailing；算法逐字对齐 main-agent 既有 emitSnapshotSignal 模式） */
const RECORD_SIGNAL_EMIT_MIN_INTERVAL_MS = 200;

/** 剥离 C0/C1 控制字符（保留 \n \t）——仅作用于显示视图，真实视图零加工 */
function sanitizeDisplayText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

/** 工具参数预览：尝试 JSON 美化（失败则保持原样），存净化后全文（不截断） */
function buildArgsPreview(rawArguments: string): string {
  const raw = sanitizeDisplayText(rawArguments ?? '');
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // JSON 解析失败：保持原样
  }
  return raw;
}

/** 工具结果预览：stringifyToolResult 产物净化后全文（不截断） */
function buildResultPreview(message: string): string {
  return sanitizeDisplayText(message ?? '');
}

/**
 * 工具条目显示名解析（查询出口 buildIncrementalEntries 统一附加）：
 * - 非 script_tool 条目：维持既有三级回退映射（内置 EXECUTOR_TOOL_PROGRESS_NAMES[toolName] ?? toolName；
 *   动态工具 manifest.progressName→displayName→name），行为与改造前完全一致；
 * - script_tool 条目：按条目参数 action 两分支动态化——action='查看协议' → `查询 {tool_name} 工具协议`；
 *   action='调用' → `调用 {tool_name} 工具`；参数数据缺失 / action 不属于两者 / tool_name 缺失或纯空白 /
 *   argsPreview 非合法 JSON 对象 → 一律回退内置映射兜底值（script_tool→'经验工具库调用'，映射本身不改）。
 *   数据来源 argsPreview：条目模型仅保存该参数预览（beginToolCall 由原始 args JSON 美化生成，合法 JSON
 *   可再次解析还原 action/tool_name 原值），出口侧不保存原始 args，故 argsPreview 为唯一参数载体。
 */
function resolveToolRecordDisplayName(record: ExecutorToolRecord): string {
  if (record.name !== 'script_tool') {
    return resolveExecutorToolProgressDisplayName(
      record.name,
      getDynamicExecutorToolMeta(record.name),
    );
  }
  let action = '';
  let toolName = '';
  try {
    const parsed: unknown = JSON.parse(record.argsPreview ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const args = parsed as { action?: unknown; tool_name?: unknown };
      if (typeof args.action === 'string') {
        action = args.action.trim();
      }
      if (typeof args.tool_name === 'string' && args.tool_name.trim()) {
        toolName = args.tool_name;   // 取原值上屏：仅以 trim 校验非空白，不截断不改写
      }
    }
  } catch {
    // argsPreview 非合法 JSON：无法解析参数 → 走兜底回退
  }
  if (action === '查看协议' && toolName) {
    return `查询 ${toolName} 工具协议`;
  }
  if (action === '调用' && toolName) {
    return `调用 ${toolName} 工具`;
  }
  return resolveExecutorToolProgressDisplayName(
    record.name,
    getDynamicExecutorToolMeta(record.name),
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

// ============================================================
// 会话（双视图宿主）
// ============================================================

/**
 * 单个委派任务的内存记录会话（双视图宿主）。
 * 主进程侧句柄：beginExecutorTaskRecord 创建，executor-agent（adoptMessages）与
 * main-agent 委派闭包（思考/工具/终态桥接）为写入方。
 */
export interface ExecutorTaskRecordSession {
  readonly conversationId: string;
  /** 委派工具调用 id = 主智能体 delegate_executor 的 toolCall.id（前端寻址主键） */
  readonly delegateCallId: string;
  /** 委派任务 uuid */
  readonly taskId: string;
  /** 承载该委派批次的 assistant 消息 id */
  readonly messageId: string;
  /** 任务名（委派参数 taskname 解析，规则与 main-agent 既有先例一致） */
  readonly taskName: string;
  readonly createdAt: string;
  /** ★ 真实内容视图：executor 循环唯一 push 目标，与 completeExecutorTurn 入参同引用（模型上下文共享） */
  readonly modelMessages: RuntimeMessage[];
  /** ★ 显示视图：按 seq 升序的记录条目（上限 500 条） */
  readonly records: ExecutorRecordEntry[];
  /** running → completed/failed/aborted；终态后 records 冻结只读 */
  status: ExecutorTaskRecordStatus;
  finishedAt?: string;
  /** 当前最新 seq（信号与增量查询的对账基准） */
  latestSeq: number;

  /** 初始消息写入 modelMessages 并返回该数组引用（adoptMessages 领养语义） */
  adoptMessages(initial: RuntimeMessage[]): RuntimeMessage[];
  /** 草稿创建/追加（R-draft-1/2/3）+ 节流信号 */
  appendThinkingDelta(delta: string): void;
  /** 草稿 seal（R-draft-4/5；无草稿且 reasoning 非空 → 直接补建 completed 条目）+ 立即信号 */
  sealThinkingTurn(reasoning: string): void;
  /** 工具条目 running（argsPreview 构造）+ 立即信号 */
  beginToolCall(info: { callId: string; name: string; args: string }): void;
  /** 工具条目终态（completed/failed，幂等守卫）+ resultPreview + 立即信号 */
  endToolCall(info: { callId: string; success: boolean; message: string }): void;
  /** onStreamRetry 复位（R-draft-6）+ 立即信号 */
  resetThinkingDraft(): void;
  /** 终态收敛（R-draft-7、running 工具条目处置）+ 冲刷节流 + 立即终态信号 + 冻结 */
  markTerminal(status: 'completed' | 'failed' | 'aborted'): void;
}

class ExecutorTaskRecordSessionImpl implements ExecutorTaskRecordSession {
  readonly conversationId: string;
  readonly delegateCallId: string;
  readonly taskId: string;
  readonly messageId: string;
  readonly taskName: string;
  readonly createdAt: string;
  readonly modelMessages: RuntimeMessage[] = [];
  readonly records: ExecutorRecordEntry[] = [];
  status: ExecutorTaskRecordStatus = 'running';
  finishedAt?: string;
  latestSeq = 0;

  /** 草稿未截断原文累积器（显示文本由其截断派生；终态/seal 时清空） */
  private draftRawText = '';
  /** 终态冻结标记（终态后全部写入 API no-op） */
  private terminal = false;
  /**
   * 原位变更条目 seq 登记（seal / 工具终态 / 终态收敛等不新增 seq 的状态转移）：
   * 增量查询将这些条目一并下发（客户端按 seq 覆盖合并，兑现"草稿/工具状态更新"语义），
   * 服务完成后即剪除（单客户端应用，窗口内条目数与两次查询间转移数同阶）。
   */
  private mutatedSeqs = new Set<number>();
  /** 200ms leading+trailing 节流状态 */
  private lastSignalEmitAt = 0;
  private pendingSignal: ExecutorTaskRecordSignal | null = null;
  private signalTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(params: {
    conversationId: string;
    delegateCallId: string;
    taskId: string;
    messageId: string;
    taskName: string;
  }) {
    this.conversationId = params.conversationId;
    this.delegateCallId = params.delegateCallId;
    this.taskId = params.taskId;
    this.messageId = params.messageId;
    this.taskName = params.taskName;
    this.createdAt = nowIso();
  }

  /** 当前 running 思考草稿条目（至多一个；records 末尾优先反向查找） */
  private get runningDraft(): ExecutorThinkingRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const record = this.records[i];
      if (record.kind === 'thinking') {
        return record.status === 'running' ? record : undefined;
      }
    }
    return undefined;
  }

  private nextSeq(): number {
    this.latestSeq += 1;
    return this.latestSeq;
  }

  /** 显示视图上限治理：超限逐出最老 thinking 条目（无 thinking 条目时兜底逐出最老条目） */
  private evictOverflow(): void {
    while (this.records.length > MAX_RECORDS) {
      const thinkingIndex = this.records.findIndex((record) => record.kind === 'thinking');
      const evictIndex = thinkingIndex >= 0 ? thinkingIndex : 0;
      const [evicted] = this.records.splice(evictIndex, 1);
      if (!evicted) {
        break;
      }
    }
  }

  private buildSignal(): ExecutorTaskRecordSignal {
    return {
      conversationId: this.conversationId,
      delegateCallId: this.delegateCallId,
      taskId: this.taskId,
      latestSeq: this.latestSeq,
      status: this.status,
      updatedAt: nowIso(),
    };
  }

  private cancelPendingSignalTimer(): void {
    if (this.signalTimerId !== null) {
      clearTimeout(this.signalTimerId);
      this.signalTimerId = null;
    }
  }

  /**
   * 信号发射（200ms leading+trailing 节流；immediate 立发并作废挂起 trailing）
   * 算法逐字对齐 main-agent.ts 既有 emitSnapshotSignal 已验证模式。
   */
  private emitSignal(immediate: boolean): void {
    const signal = this.buildSignal();
    if (immediate) {
      this.cancelPendingSignalTimer();
      this.pendingSignal = null;
      this.lastSignalEmitAt = Date.now();
      eventBus.emit(EXECUTOR_RECORD_SIGNAL_EVENT, signal);
      return;
    }
    const now = Date.now();
    if (now - this.lastSignalEmitAt >= RECORD_SIGNAL_EMIT_MIN_INTERVAL_MS) {
      this.lastSignalEmitAt = now;
      eventBus.emit(EXECUTOR_RECORD_SIGNAL_EVENT, signal);   // leading
      return;
    }
    this.pendingSignal = signal;                             // trailing：窗口末必补发
    if (this.signalTimerId === null) {
      this.signalTimerId = setTimeout(() => {
        this.signalTimerId = null;
        this.lastSignalEmitAt = Date.now();
        if (this.pendingSignal) {
          const pending = this.pendingSignal;
          this.pendingSignal = null;
          eventBus.emit(EXECUTOR_RECORD_SIGNAL_EVENT, pending);
        }
      }, RECORD_SIGNAL_EMIT_MIN_INTERVAL_MS - (now - this.lastSignalEmitAt));
    }
  }

  adoptMessages(initial: RuntimeMessage[]): RuntimeMessage[] {
    if (this.terminal) {
      return this.modelMessages;
    }
    this.modelMessages.push(...initial);
    return this.modelMessages;
  }

  appendThinkingDelta(delta: string): void {
    if (this.terminal || !delta) {
      return;
    }
    const draft = this.runningDraft;
    if (!draft) {
      // R-draft-1 草稿创建
      this.draftRawText = sanitizeDisplayText(delta);
      this.records.push({
        kind: 'thinking',
        seq: this.nextSeq(),
        status: 'running',
        text: this.draftRawText,
        startedAt: nowIso(),
      });
    } else {
      // R-draft-2 草稿追加（不新增 seq；显示文本存净化后全文，不截断不回写真实内容）
      this.draftRawText = `${this.draftRawText}${sanitizeDisplayText(delta)}`;
      draft.text = this.draftRawText;
    }
    this.evictOverflow();
    this.emitSignal(false);
  }

  sealThinkingTurn(reasoning: string): void {
    if (this.terminal) {
      return;
    }
    const authoritative = sanitizeDisplayText(reasoning ?? '');
    const draft = this.runningDraft;
    if (draft) {
      // R-draft-4 草稿 seal：权威全文覆盖；权威为空时保留已累积草稿文本（delta 已真实发生）
      draft.text = authoritative.trim() ? authoritative : this.draftRawText;
      draft.status = 'completed';
      draft.finishedAt = nowIso();
      this.draftRawText = '';
      this.mutatedSeqs.add(draft.seq);   // 同 seq 状态转移：登记供增量查询补发
    } else if (authoritative.trim()) {
      // 无草稿且 reasoning 非空 → 直接补建 completed 条目（幂等补账）
      this.records.push({
        kind: 'thinking',
        seq: this.nextSeq(),
        status: 'completed',
        text: authoritative,
        startedAt: nowIso(),
        finishedAt: nowIso(),
      });
      this.evictOverflow();
    }
    // R-draft-5 空思考轮：无草稿且权威为空 → 不建条目
    this.emitSignal(true);
  }

  beginToolCall(info: { callId: string; name: string; args: string }): void {
    if (this.terminal || !info.callId) {
      return;
    }
    // 同 callId 幂等：running 条目更新元数据，已终态条目不回退
    const existing = this.records.find(
      (record): record is ExecutorToolRecord =>
        record.kind === 'tool' && record.callId === info.callId,
    );
    if (existing) {
      if (existing.status === 'running') {
        existing.name = info.name;
        existing.argsPreview = buildArgsPreview(info.args);
        this.mutatedSeqs.add(existing.seq);   // 同 seq 元数据更新：登记供增量查询补发
      }
      this.emitSignal(true);
      return;
    }
    this.records.push({
      kind: 'tool',
      seq: this.nextSeq(),
      callId: info.callId,
      name: info.name,
      status: 'running',
      argsPreview: buildArgsPreview(info.args),
      startedAt: nowIso(),
    });
    this.evictOverflow();
    this.emitSignal(true);
  }

  endToolCall(info: { callId: string; success: boolean; message: string }): void {
    if (this.terminal || !info.callId) {
      return;
    }
    const target = this.records.find(
      (record): record is ExecutorToolRecord =>
        record.kind === 'tool' && record.callId === info.callId,
    );
    if (!target) {
      return;
    }
    // 幂等守卫：completed/failed 不再转移
    if (target.status !== 'running') {
      return;
    }
    target.status = info.success ? 'completed' : 'failed';
    target.resultPreview = buildResultPreview(info.message);
    target.finishedAt = nowIso();
    this.mutatedSeqs.add(target.seq);   // 同 seq 状态转移：登记供增量查询补发
    this.emitSignal(true);
  }

  resetThinkingDraft(): void {
    if (this.terminal) {
      return;
    }
    const draft = this.runningDraft;
    if (draft) {
      const index = this.records.indexOf(draft);
      if (index >= 0) {
        this.records.splice(index, 1);
      }
    }
    this.draftRawText = '';
    this.emitSignal(true);
  }

  markTerminal(status: 'completed' | 'failed' | 'aborted'): void {
    if (this.terminal) {
      return;
    }
    // R-draft-7：running 草稿强制 seal（已产生内容不因终态否定）
    const draft = this.runningDraft;
    if (draft) {
      draft.status = 'completed';
      draft.finishedAt = nowIso();
      this.draftRawText = '';
      this.mutatedSeqs.add(draft.seq);   // 同 seq 状态转移：登记供增量查询补发
    }
    // running 工具条目处置（§8.1）：终态未收口的工具条目 → failed + 备注
    const finishedAt = nowIso();
    for (const record of this.records) {
      if (record.kind === 'tool' && record.status === 'running') {
        record.status = 'failed';
        record.finishedAt = finishedAt;
        if (!record.resultPreview) {
          record.resultPreview = status === 'aborted' ? '已取消' : '执行中断';
        }
        this.mutatedSeqs.add(record.seq);   // 同 seq 状态转移：登记供增量查询补发
      }
    }
    this.status = status;
    this.finishedAt = finishedAt;
    this.terminal = true;
    // 终态冲刷：作废挂起 trailing（clearTimeout 模式）后立即发终态信号（保证为该任务最后一条）
    this.cancelPendingSignalTimer();
    this.pendingSignal = null;
    this.lastSignalEmitAt = Date.now();
    eventBus.emit(EXECUTOR_RECORD_SIGNAL_EVENT, this.buildSignal());
  }

  /** 清理时冲刷挂起定时器（防清理后迟到信号） */
  dispose(): void {
    this.cancelPendingSignalTimer();
    this.pendingSignal = null;
  }

  /**
   * 增量条目视图（查询出口内部使用）：
   * seq > sinceSeq 的条目 ∪ 当前 running 思考草稿（恒返最新全文，R-draft-3）
   * ∪ 原位变更登记条目（seal/工具终态等同 seq 状态转移，兑现"已存在者覆盖"合并语义）。
   * 服务完成后剪除已下发的登记（单客户端应用）。
   */
  buildIncrementalEntries(sinceSeq: number): ExecutorRecordEntry[] {
    let draft: ExecutorThinkingRecord | undefined;
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const record = this.records[i];
      if (record.kind === 'thinking') {
        if (record.status === 'running') {
          draft = record;
        }
        break;
      }
    }
    const entries = this.records
      .filter(
        (record) =>
          record.seq > sinceSeq || record === draft || this.mutatedSeqs.has(record.seq),
      )
      .map((record) => {
        if (record.kind === 'tool') {
          return {
            ...record,
            displayName: resolveToolRecordDisplayName(record),
          } satisfies ExecutorToolRecord;
        }
        return { ...record } satisfies ExecutorThinkingRecord;
      });
    for (const record of this.records) {
      if (this.mutatedSeqs.has(record.seq)) {
        this.mutatedSeqs.delete(record.seq);
      }
    }
    return entries;
  }
}

// ============================================================
// 全局会话存储：Map<conversationId, Map<delegateCallId, session>>
// ============================================================

const taskRecordSessions = new Map<string, Map<string, ExecutorTaskRecordSessionImpl>>();

/**
 * 创建并登记 executor 任务记录会话（委派闭包启动时调用；发一次 running 信号（立即））
 */
export function beginExecutorTaskRecord(params: {
  conversationId: string;
  delegateCallId: string;
  taskId: string;
  messageId: string;
  taskName: string;
}): ExecutorTaskRecordSession {
  let conversationSessions = taskRecordSessions.get(params.conversationId);
  if (!conversationSessions) {
    conversationSessions = new Map();
    taskRecordSessions.set(params.conversationId, conversationSessions);
  }
  const previous = conversationSessions.get(params.delegateCallId);
  if (previous) {
    previous.dispose();
  }
  const session = new ExecutorTaskRecordSessionImpl(params);
  conversationSessions.set(params.delegateCallId, session);
  // 任务出现即立发一次 running 信号（渲染端可立即感知任务存在并拉取）
  eventBus.emit(EXECUTOR_RECORD_SIGNAL_EVENT, {
    conversationId: session.conversationId,
    delegateCallId: session.delegateCallId,
    taskId: session.taskId,
    latestSeq: session.latestSeq,
    status: session.status,
    updatedAt: nowIso(),
  });
  return session;
}

/**
 * 增量查询（executor:get-task-record 唯一后端出口）
 * - sinceSeq 缺省/0 = 全量；
 * - 服务端 latestSeq < 请求 sinceSeq → reset=true（会话已清理重建，前端整体重置）；
 * - 工具条目在出口统一经三级回退映射 displayName 后随条目下发。
 */
export function queryExecutorTaskRecord(params: {
  conversationId: string;
  delegateCallId: string;
  sinceSeq?: number;
}): ExecutorTaskRecordQueryResult {
  const session = taskRecordSessions.get(params.conversationId)?.get(params.delegateCallId);
  if (!session) {
    return {
      found: false,
      taskName: '',
      status: 'completed',
      latestSeq: 0,
      entries: [],
    };
  }
  const sinceSeq =
    typeof params.sinceSeq === 'number' && params.sinceSeq > 0 ? params.sinceSeq : 0;
  const reset = session.latestSeq < sinceSeq;

  // 增量条目：seq > sinceSeq ∪ 当前 running 草稿（R-draft-3 恒返）∪ 原位变更登记条目
  const entries: ExecutorRecordEntry[] = session.buildIncrementalEntries(sinceSeq);

  return {
    found: true,
    taskName: session.taskName,
    status: session.status,
    latestSeq: session.latestSeq,
    entries,
    ...(reset ? { reset: true } : {}),
  };
}

/**
 * 清理会话全部记录（幂等；调用时机：轮末 resetConversationTasksDir / conv:delete）
 */
export function clearExecutorTaskRecords(conversationId: string): void {
  const conversationSessions = taskRecordSessions.get(conversationId);
  if (!conversationSessions) {
    return;
  }
  for (const session of conversationSessions.values()) {
    session.dispose();
  }
  taskRecordSessions.delete(conversationId);
}
