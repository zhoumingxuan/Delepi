/**
 * EventBus 事件总线模块
 * 基于 typed-event-emitter 实现类型安全的事件发布/订阅
 *
 * 事件流设计（v1.2）：
 * - MainAgent 事件 → EventBus → IPC → 前端（白名单推送）
 * - ExecutorAgent 事件 → EventBus → IPC 白名单 → 前端（executor 三通道）
 */

import { EventEmitter } from 'events';
import {
  ASSISTANT_MESSAGE_DONE_EVENT,
  ASSISTANT_MESSAGE_STARTED_EVENT,
  MAIN_AGENT_ABORTED_EVENT,
  MAIN_AGENT_CHUNK_EVENT,
  MAIN_AGENT_COMPRESSION_EVENT,
  MAIN_AGENT_DONE_EVENT,
  MAIN_AGENT_ERROR_EVENT,
  MAIN_AGENT_THINKING_EVENT,
  MAIN_AGENT_TITLE_EVENT,
  MAIN_AGENT_TOOL_CALL_EVENT,
  MAIN_AGENT_TOOL_RESULT_EVENT,
  TOOL_MESSAGE_CREATED_EVENT,
  USER_MESSAGE_CREATED_EVENT,
} from '../../constants/events';

// ============================================================
// 事件类型定义
// ============================================================

/** MainAgent 事件（6种，通过 IPC 白名单推送到前端） */
export interface MainAgentEvents {
  /** 思考内容推送 */
  'main-agent:thinking': {
    conversationId: string;
    delta: string;
    /** F2 扩展：完整思考文本 */
    thinking?: string;
    /** F4 扩展：思考分段 */
    segments?: unknown[];
  };
  /** 流式 chunk 推送 */
  'main-agent:chunk': {
    conversationId: string;
    delta: string;
    content: string;
    isThinking: boolean;
    /**
     * ★ Phase 3 P3-7 finishReason 字段(可选)
     * 由 openai-client.ts 在 finish_reason 变化时附加,转发到 IPC chat:chunk 事件
     * 前端 useChat.ts 据此判断 stream 终止原因(set status=success/length_limited)
     */
    finishReason?: string | null;
  };
  /** 工具调用通知 */
  'main-agent:tool-call': {
    conversationId: string;
    callId: string;
    name: string;
    arguments: string;
    /**
     * ★ 修复主/子智能体消息混淆：标识该工具调用为主智能体对执行子智能体的委派
     *   前端可据此把对应 toolCall 渲染为"代理卡片"而非"工具进度"
     *   默认 undefined 时视为普通主智能体工具调用（向后兼容）
     */
    isDelegatedExecutor?: boolean;
  };
  /** 工具调用结果 */
  'main-agent:tool-result': {
    conversationId: string;
    callId: string;
    name: string;
    result: string;
    success: boolean;
  };
  /** 对话完成 */
  'main-agent:done': {
    conversationId: string;
    messageId: string;
    durationMs: number;
  };
  /** 对话标题生成完成（仅首轮触发） */
  'main-agent:title': {
    conversationId: string;
    title: string;
  };
  /** 上下文压缩触发 */
  'main-agent:compression': {
    conversationId: string;
    beforeChars: number;
    afterChars: number;
    threshold: number;
    compressionId: string;
  };
  /** 对话错误 */
  'main-agent:error': {
    conversationId: string;
    error: string;
    errorType: string;
  };
  /** 对话被中止（★ P0-E3：chat:abort handler 触发，IPC 转发至 chat:aborted） */
  'main-agent:aborted': {
    conversationId: string;
  };
  /** Assistant 消息开始，供前端切换当前流式目标消息 */
  'assistant.message.started': {
    conversationId: string;
    message: unknown;
  };
  /** Assistant 消息完成，供前端按后端落库消息 upsert */
  'assistant.message.done': {
    conversationId: string;
    message: unknown;
  };
  /** Tool 消息创建，供前端替换对应执行快照 */
  'tool.message.created': {
    conversationId: string;
    message: unknown;
  };
  /**
   * ★ P6 用户消息创建事件（主进程内部事件总线 → ipc-handlers 转发给 renderer）
   * - 由 main-agent.ts 在 insertMessage(user) 后 emit
   * - ipc-handlers.ts 监听后转发到 IPC_CHAT.USER_MESSAGE_CREATED
   * - 前端 useChat 收到后 replaceLatestLocalUserInList 替换本地乐观 user 消息
   * - payload.message 含 id/role/content/attachments/createdAt
   * - attachments 来自 payload.attachments(持久化在 messages 表 payload_json 中)
   */
  'user.message.created': {
    conversationId: string;
    message: {
      id: string;
      role: 'user';
      content: string;
      attachments?: unknown[];
      createdAt: string;
    };
  };
  /**
   * ★ S3 批次完成事件（M4，对齐 ai_fr types/chat.ts:171-177）
   * - 由 main-agent.ts 批次收口块在全中止判定之前 emit（含全中止批次）
   * - 前端 useChat 按 toolCallIds 收口 running 快照（isError → failed / 否则 completed）
   */
  'tool.batch.completed': {
    conversationId: string;
    toolCallIds: string[];
  };
}

/**
 * ★ Phase 3 P3-8 ExecutorAgent 事件(走 IPC 白名单推送)
 * v2.1 D2：executor:thinking / executor:tool-progress 两数据通道已完全停用删除，
 * 仅保留 executor:snapshot 六字段信号通道（M1 白名单收敛，规则②）：
 * 前端收到信号后触发轻量快照查询 conv:get-running-snapshots 获取运行中任务明细。
 */
export interface ExecutorAgentEvents {
  /**
   * ★ Phase 3 P3-8 executor:snapshot 事件（v2.1 M1：收敛为六字段信号白名单——规则②）
   * 纯信号载荷（main-agent.ts emitSnapshotSignal 唯一出口构造）：前端收到后触发轻量查询
   * conv:get-running-snapshots 获取运行中任务快照明细（信号本身不携带任何过程数据）。
   */
  'executor:snapshot': {
    conversationId: string;
    taskId: string;
    /** 委派工具调用的 callId */
    callId?: string;
    status: 'running' | 'completed' | 'failed';
    /**
     * ★ Phase 3 P3-8 messageId ↔ taskId 关联键
     */
    messageId?: string;
    updatedAt?: string;
  };
}

/** 所有事件类型联合 */
export type AllEvents = MainAgentEvents & ExecutorAgentEvents;

/** 事件名类型 */
export type EventName = keyof AllEvents;

/** 事件载荷类型 */
export type EventPayload<E extends EventName> = AllEvents[E];

// ============================================================
// EventBus 类
// ============================================================

/**
 * 类型安全的事件总线
 *
 * 设计要点：
 * 1. MainAgent 事件：emit → IPC 白名单推送（由 ipc-handlers 订阅转发）
 * 2. ExecutorAgent 事件：emit → EventBus → IPC 白名单 → 前端（executor 三通道）
 */
export class EventBus {
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    // 提升最大监听器数量，避免模块订阅过多时产生警告
    this.emitter.setMaxListeners(100);
  }

  /**
   * 订阅事件
   */
  on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void {
    this.emitter.on(event, listener);
    return () => {
      this.emitter.off(event, listener);
    };
  }

  /**
   * 单次订阅
   */
  once<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): void {
    this.emitter.once(event, listener);
  }

  /**
   * 发布事件
   */
  emit<E extends EventName>(event: E, payload: EventPayload<E>): void {
    this.emitter.emit(event, payload);
  }

  /**
   * 取消订阅
   */
  off<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): void {
    this.emitter.off(event, listener);
  }

  /**
   * 移除指定事件的所有监听器
   */
  removeAllListeners<E extends EventName>(event: E): void {
    this.emitter.removeAllListeners(event);
  }
}

/** 全局单例 */
export const eventBus = new EventBus();
