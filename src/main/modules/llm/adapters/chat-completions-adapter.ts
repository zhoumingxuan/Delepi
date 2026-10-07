/**
 * ChatCompletionsAdapter - CC（Chat Completions）零变化包装适配器
 *
 * P1 零变化包装原则：只做参数搬运与回调分发，全部协议行为（请求体构造
 * openai-client.ts L233-244 流式 / L442-454 非流式、SSE 解析 L257-383、
 * 重试 L424-428）委托现状 streamChat——openai-client.ts 一行不改，
 * "message 原封回传逻辑放在 CC 适配器里面"的入向/出向双层原封落位（§三.2.3）：
 *  - 入向原封：宿主 messages 数组零加工直通（三条红线回传路径产出的 reasoning_content
 *    原样进入请求体，本适配器不认识也不处理该字段）；
 *  - 出向原封：现状 streamChatOnce 构造的 assistantMessage（L388-404）经
 *    AdapterTurnResult.assistantMessage / AdapterFinished.assistantMessage 原样透出。
 *
 * onChunk 拆分（§三.2.2）：现状混合载荷回调（触发条件 changed||finishReasonChanged，
 * P3-7 修复含 finishReason 变化，L353-381）拆分为 reasoning/content 两类 AdapterChunk
 * + S1/S2/S3 段终结信号（§三.2.5 映射表）；reasoning 类与现状 onThinking 同源同频
 * （仅 reasoningDelta 非空触发，L375-377——契约"有值传没值空"）。
 * 拆分顺序保持现状回调时序（onChunk 先于 onThinking，L364-377）：content 类先于
 * reasoning 类发出，保证宿主 F4 切段（forceNewReasoningSegment 标记先置、思考后到新开段）
 * 的段结构语义与现状一致。
 *
 * finishReason 等价保持（决策 D3）：收到 finish_reason 非 null 的 chunk 时发出
 * S3 回调 {type:<末段>, delta:'', cumulative, end:'message', finishReason}——G5 实测
 * finish_reason 位于独立 chunk 且 delta.content=空串，S3 空增量回调与现状 finishReason
 * 变化触发的空增量回调逐字段等价（含 finishReason 字段透传，IPC chat:chunk.finishReason
 * 通道依赖该字段逐层传递，A-04 断言 2）；"end:'message' 不得并入末增量回调"
 * （G5 实测 S3 触发 chunk 与末增量 chunk 天然分离）。
 */

import { streamChat, type ModelConfig, type StreamChunk, type StreamChatResult } from '../openai-client';
import { isModelApiAbortError } from '../model-retry';
import {
  ProtocolAdapter,
  type AdapterChunk,
  type AdapterFinished,
  type AdapterInitResult,
  type AdapterToolCall,
  type AdapterToolMessage,
  type AdapterTurnResult,
} from './protocol-adapter';

export class ChatCompletionsAdapter extends ProtocolAdapter {
  private chunkHandler: ((chunk: AdapterChunk) => void) | null = null;
  private toolCallHandler: ((toolCall: AdapterToolCall) => AdapterToolMessage | undefined) | null = null;
  private finishedHandler: ((finished: AdapterFinished) => void) | null = null;

  // ---- 拆分状态机（每轮 sendMessage 复位；C-1 事件式语义：不假设恰一次切换） ----
  /** 当前活动段类型（最后一次发出增量的段；初始无段） */
  private currentSegment: 'reasoning' | 'content' | null = null;
  /** S3 挂靠末段（R4：该 message 中最后出现的段类型；纯 tool_calls 轮挂靠 content） */
  private lastSegmentType: 'content' | 'reasoning' = 'content';
  /** tool_calls 是否已出现（S2 仅首次切换触发） */
  private toolCallsStarted = false;

  constructor() {
    super();
  }

  /** ① init 覆写（成败化契约 + 协议探查，目标一/二）：继承基类参数校验/配置快照职责，
   *  基类成功后 POST 探查 {baseUrl}/chat/completions——HTTP 404 = 协议不存在 = 初始化
   *  失败；收到任何其他 HTTP 状态响应（含 400/401/403/405）= 协议存在 = 探查通过
   *  （鉴权/参数类状态码恰证端点存在）；网络层失败/超时 = 探查未通过（记录原因）。 */
  async init(config: Parameters<ProtocolAdapter['init']>[0]): Promise<AdapterInitResult> {
    const baseResult = await super.init(config);
    if (!baseResult.success) {
      return baseResult;
    }
    return this.probeProtocolEndpoint('/chat/completions');
  }

  /** ⑤ onChunk 注册（注册期校验 handler 为 function） */
  onChunk(handler: (chunk: AdapterChunk) => void): void {
    if (typeof handler !== 'function') {
      throw new Error('onChunk 注册失败：handler 非 function');
    }
    this.chunkHandler = handler;
  }

  /** ⑥ onToolCall 注册（通知模式默认：handler 返回 undefined；即时模式返回 tool message） */
  onToolCall(
    handler: (toolCall: AdapterToolCall) => AdapterToolMessage | undefined,
  ): void {
    if (typeof handler !== 'function') {
      throw new Error('onToolCall 注册失败：handler 非 function');
    }
    this.toolCallHandler = handler;
  }

  /** ⑦ onFinished 注册（轮级权威终结） */
  onFinished(handler: (finished: AdapterFinished) => void): void {
    if (typeof handler !== 'function') {
      throw new Error('onFinished 注册失败：handler 非 function');
    }
    this.finishedHandler = handler;
  }

  /**
   * ③ sendMessage：排水（同步无 await）→ 委托现状 streamChat → 拆分分发 → 三情形映射。
   * 协议错误重试耗尽 → onFinished(failed) 后 reject；signal 中止 → reject 不触发
   * onFinished（调用前预中止语义，G-CC-09 形态 B；流式中途 abort 由 SDK 优雅终止、
   * streamChat 以部分结果 resolve——G-CC-09 形态 A，onFinished 按 completed 触发）。
   */
  async sendMessage(
    messages: Array<Record<string, unknown>>,
    opts: { multimodal: boolean; signal?: AbortSignal },
  ): Promise<AdapterTurnResult> {
    this.assertUsable('sendMessage');
    this.terminal = false;
    this.currentSegment = null;
    this.lastSegmentType = 'content';
    this.toolCallsStarted = false;

    // 排水：构建请求体之前、同步（无 await）排空 insert 队列（§5.4 硬约束）
    this.drainPendingMessages(messages);

    const emit = (chunk: AdapterChunk): void => {
      if (this.closed || !this.chunkHandler) {
        return;
      }
      try {
        this.chunkHandler(chunk);
      } catch (err) {
        // 回调内异常吞掉记日志不中断生成流（对齐现状 onThinking 尽力而为语义）
        // eslint-disable-next-line no-console
        console.error('[cc-adapter] onChunk 回调异常（已吞掉）:', err);
      }
    };

    // 现状混合载荷回调 → 拆分（顺序：S1/S2 → content 类 → reasoning 类 → S3，
    // content 类先于 reasoning 类保持现状 onChunk→onThinking 触发时序）
    const wrappedOnChunk = (chunk: StreamChunk): void => {
      const hasContentDelta = Boolean(chunk.delta);
      const hasReasoningDelta = Boolean(chunk.reasoningDelta);
      const finishReasonChanged = chunk.finishReason !== null && chunk.finishReason !== undefined;
      const hasToolCalls = Array.isArray(chunk.toolCalls) && chunk.toolCalls.length > 0;

      // S1：R→C 切换点（delta 首次带 content 且此前为 reasoning 段）——先发段终结
      if (hasContentDelta && this.currentSegment === 'reasoning' && chunk.reasoning) {
        emit({ type: 'reasoning', delta: '', cumulative: chunk.reasoning, end: 'segment' });
      }
      // S2：C→tool 切换点（delta 首次带 tool_calls 且此前为 content 段）——先发段终结
      //   （toolCallsStarted 首次到达即置位：S2 仅在 content 段已开启时发出一次）
      if (hasToolCalls && !this.toolCallsStarted) {
        if (this.currentSegment === 'content' && chunk.content) {
          emit({ type: 'content', delta: '', cumulative: chunk.content, end: 'segment' });
        }
        this.toolCallsStarted = true;
      }

      // content 类：★现状每次回调必发（混合载荷 onChunk 半边的等价承载——P3-7 触发条件
      // changed||finishReasonChanged 下，reasoning 帧 / tool_calls 帧 / finish 帧均产生
      // 一次 delta='' 或增量的 chunk 回调，G-CC-01/03/08/09 时间线依赖逐条一致）
      emit({
        type: 'content',
        delta: chunk.delta,
        cumulative: chunk.content,
        finishReason: chunk.finishReason ?? null,
      });
      if (hasContentDelta) {
        this.currentSegment = 'content';
        this.lastSegmentType = 'content';
      }

      // reasoning 类：与现状 onThinking 同源同频（仅 reasoningDelta 非空触发）
      if (hasReasoningDelta) {
        emit({
          type: 'reasoning',
          delta: chunk.reasoningDelta,
          cumulative: chunk.reasoning,
          finishReason: chunk.finishReason ?? null,
        });
        this.currentSegment = 'reasoning';
        this.lastSegmentType = 'reasoning';
      }

      // S3：finish_reason 非 null 的 chunk → 附加契约信号 end:'message'（R4 挂靠末段；
      // 纯 tool_calls 轮挂靠 content 空串；不并入末增量回调——同帧 content 类已承载
      // 现状 finish 回调等价（delta=''+finishReason 透传），S3 为可选消费信号）
      if (finishReasonChanged) {
        const s3Type = this.lastSegmentType;
        const s3Cumulative = s3Type === 'reasoning' ? chunk.reasoning : chunk.content;
        emit({
          type: s3Type,
          delta: '',
          cumulative: s3Cumulative,
          end: 'message',
          finishReason: chunk.finishReason,
        });
      }
    };

    let streamResult: StreamChatResult;
    try {
      streamResult = await streamChat({
        modelConfig: this.apiConfig as ModelConfig,
        messages: messages as unknown as Parameters<typeof streamChat>[0]['messages'],
        tools: this.resolveTools() as unknown as Parameters<typeof streamChat>[0]['tools'],
        signal: opts.signal,
        thinking: { reasoningEffort: this.resolveThinkingLevel() },
        onChunk: wrappedOnChunk,
        onThinking: undefined,
        onStreamRetry: () => this.hooksRef?.onStreamRetry?.(),
      });
    } catch (error) {
      // 中止路径（预中止/重试中 abort）：现状中止即异常路径——不触发 onFinished，原样上抛
      if (opts.signal?.aborted
        || (error instanceof DOMException && error.name === 'AbortError')
        || (error instanceof Error && error.message === 'ABORTED')) {
        throw error;
      }
      // 重试耗尽/致命（ModelApiAbortError）与其他失败：失败轮恒触发 onFinished（R8）后原样上抛
      const message = error instanceof Error ? error.message : String(error);
      this.fireFinished({
        status: 'failed',
        error: { message },
        finishReason: null,
      });
      throw error;
    }

    // onToolCall：resolve 前对组装完毕的 sanitized toolCalls 逐个通知（通知模式默认；
    // 即时模式返回值无处置通道——CC 链路工具消息由宿主构建，返回值不进上下文）
    for (const toolCall of streamResult.toolCalls) {
      if (this.toolCallHandler) {
        try {
          this.toolCallHandler(toolCall);
        } catch (err) {
          // 回调内异常按该工具执行失败处理，不中断生成流
          // eslint-disable-next-line no-console
          console.error('[cc-adapter] onToolCall 回调异常（按该工具执行失败处理）:', err);
        }
      }
    }

    // onFinished 三情形映射（§三.2.4）
    const finished = this.mapFinished(streamResult);
    this.fireFinished(finished);

    return {
      content: streamResult.content,
      reasoning: streamResult.reasoning,
      toolCalls: streamResult.toolCalls,
      finished,
      assistantMessage: streamResult.assistantMessage as unknown as Record<string, unknown>,
      finishReason: streamResult.finishReason,
      model: streamResult.model,
    };
  }

  /** onFinished 三情形映射（CC 侧 §3.2.4 表） */
  private mapFinished(streamResult: StreamChatResult): AdapterFinished {
    const finishReason = streamResult.finishReason;
    const base: Omit<AdapterFinished, 'status'> = {
      assistantMessage: streamResult.assistantMessage as unknown as Record<string, unknown>,
      finishReason,
      model: streamResult.model,
    };
    if (finishReason === 'length') {
      return { ...base, status: 'incomplete', incompleteReason: 'max_output_tokens' };
    }
    if (finishReason === 'content_filter') {
      return { ...base, status: 'incomplete', incompleteReason: 'content_filter' };
    }
    // stop / tool_calls / null（流式中途 abort 优雅 resolve 部分结果，G-CC-09 形态 A）
    return { ...base, status: 'completed' };
  }

  private fireFinished(finished: AdapterFinished): void {
    if (this.closed || !this.finishedHandler) {
      return;
    }
    try {
      this.finishedHandler(finished);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[cc-adapter] onFinished 回调异常（已吞掉）:', err);
    }
  }
}
