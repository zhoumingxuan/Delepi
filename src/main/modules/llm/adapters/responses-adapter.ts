/**
 * ResponsesAdapter - 智谱 /api/v1/responses 端点适配器（完整翻译层）
 *
 * P2 翻译封闭原则：在自有缓冲内完成全部翻译；对宿主数组只读；未知字段一律不透传
 * （白名单机制，结构性免疫服务端 400）。协议事实来源：A3 取证 45 条 + A2 实测 14 轮
 * （G1-G6 形态固化）。
 *
 * 终结判定双锚定（P8，§三.3.6）：
 *  1. 权威锚 = 终结事件全集（response.completed / response.failed / response.incomplete /
 *     独立 error 事件——承载 incomplete_details/usage/error 载荷，不可替代）；
 *  2. 冗余帧锚 = data:[DONE]（A2 实测所有终结路径流末恒发，8/8；到达即停止 SSE 读取）；
 *  3. 严禁依赖连接关闭（EOF）——实测服务器 [DONE] 后不关闭连接（12s socket 超时）；
 *  4. 流耗尽无终结事件兜底 → onFinished{failed, 'protocol-error: stream exhausted...'}；
 *  5. HTTP 200 不作轮次成败判据（A2 实测失败轮 HTTP 仍 200、首个事件即 response.failed）。
 *
 * SSE 事件分发（§三.3.4 表，G3/G4/G6 已取证形态固化）+ S1/S2/S3 信号映射（A4 §5.2）：
 *  - S1 权威锚 = reasoning item 的 output_item.done（9/9 到达；reasoning_text.done 仅纠偏不触发）；
 *  - S2/S3 同刻同源 = message item 的 output_item.done → 单回调 end:'message'（R5 重合合一）；
 *  - onToolCall 铁律 = 仅 function_call item 的 output_item.done（完整快照）触发，
 *    绝不以 added/delta 中间态触发；
 *  - 纯工具轮无 message item → S3 缺席（G4 实证，A4 3.1 不对称论证）。
 *
 * 自有重试器（§三.3.8）：不依赖 runModelApiWithRetry 的 CC 错误形态判定；重试节律对齐
 * 现状工程惯例（1s，MODEL_API_BAD_REQUEST_RETRY_DELAY_MS）；重试边界调用
 * init.hooks.onStreamRetry（红线 R7 复位协议等价承载——契约 R7：end 信号态随思考
 * 增量态一并复位）；上限 5 次，耗尽抛 ModelApiAbortError（宿主 catch 分类链兼容）。
 *
 * 有状态模式（§三.3.1）：previous_response_id + store=true；内部恒 stateful=true 起步
 * （2026-10-07 内聚整改：宿主侧不再外放接线，判断全部 adapter 内自适应）；instructions 每轮重传
 * （官方明文不随 previous_response_id 继承）；首轮响应回显验证——response.completed 的
 * response 对象 store===true 才缓存 lastResponseId 续接，store===false/字段缺失判端点不支持
 * → 本实例内禁用 stateful 后续全量重传（防增量静默丢历史）；服务端指明 id 失效 → 自动回退
 * 无状态完整回传并告警；store/previous_response_id 参数被拒（extra_forbidden/unrecognized
 * 类指纹）→ 仅 stateful 语境永久禁用降级（防重发死循环）。
 */

import {
  ProtocolAdapter,
  type AdapterChunk,
  type AdapterFinished,
  type AdapterInitResult,
  type AdapterToolCall,
  type AdapterToolMessage,
  type AdapterTurnResult,
  type AdapterThinkingLevel,
} from './protocol-adapter';
import { ModelApiAbortError, MODEL_API_RETRY_LIMIT, sleepBeforeRetry } from '../model-retry';

/** 自有重试器节律（1s，对齐现状工程惯例）；重试上限共用 model-retry.ts 导出的 MODEL_API_RETRY_LIMIT（同值 5） */
const RESPONSES_RETRY_DELAY_MS = 1_000;
/** 客户端超时：沿用现状 600s 风格起步（openai-client.ts L149） */
const RESPONSES_REQUEST_TIMEOUT_MS = 600_000;

/** 可重试错误码（智谱字符串错误码分类表，§三.3.8） */
const RETRYABLE_ERROR_CODES = new Set([
  'rate_limit_exceeded',
  'slow_down',
  'server_error',
  'server_is_overloaded',
]);

/** HTTP 状态级可重试（SSE 未建立时的传输层分类；C-5 处置） */
const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);

/** Responses input item 白名单（智谱仅支持 message/function_call/function_call_output/reasoning 四种） */
type ResponsesInputItem = Record<string, unknown>;

/** 流式事件宽松载荷 */
type LooseEvent = {
  type?: string;
  item?: Record<string, unknown> | null;
  delta?: string;
  text?: string;
  response?: Record<string, unknown> | null;
  code?: string;
  message?: string;
  output_index?: number;
  content_index?: number;
};

export class ResponsesAdapter extends ProtocolAdapter {
  private chunkHandler: ((chunk: AdapterChunk) => void) | null = null;
  private toolCallHandler: ((toolCall: AdapterToolCall) => AdapterToolMessage | undefined) | null = null;
  private finishedHandler: ((finished: AdapterFinished) => void) | null = null;

  /** 有状态模式（内部恒 true 起步——2026-10-07 内聚整改后宿主不再传 stateful；端点不支持经首轮 store 回显验证自动禁用） */
  private stateful = false;
  /** 有状态：上一轮 response.id 缓存（7 天有效期；失效自动降级；仅 response.store===true 回显后缓存） */
  private lastResponseId: string | null = null;
  /** 有状态：宿主数组已消费长度快照（本轮新 item = messages[lastConsumed:]） */
  private lastConsumedMessageCount = 0;

  /** reasoning item 接受性降级（2026-10-07）：端点 400 校验指纹判『期望 input_text 实得
   *  reasoning_text』（vllm /v1/responses input 联合类型不接受任何专用 reasoning item——
   *  占位/真实同型 400 实测）→ 本实例永久禁用 reasoning item 回传（真实+占位都不发）。 */
  private reasoningItemReturnDisabled = false;

  /** must-be-passed-back 复位重发实例级限次 guard（2026-10-07 供给链单点缺陷修复）：
   *  reasoning 剥离态后续工具轮命中 DeepSeek『The `reasoning_text` in the thinking mode
   *  must be passed back to the API』400 时，复位剥离标志恢复 reasoning 回传并重发一次；
   *  guard 置位后本实例不再二次复位重发（第二次命中按原错误失败上抛，防与 vllm 指纹
   *  形成置位→剥离→复位→再发震荡）。 */
  private reasoningMustPassBackResetDone = false;

  constructor() {
    super();
  }

  /** init 扩展（非静默偏离，方案 §三.3.1）：stateful 内聚整改（2026-10-07）——init 不再
   *  接收 stateful 扩展键（类型交集同步收敛），内部恒以 stateful=true 起步，端点是否真支持
   *  经首轮 store 回显验证自动判定（不支持自动禁用）；成败化契约（目标一/二）：基类校验/
   *  快照成功后 POST 探查 {baseUrl}/responses——HTTP 404 = 协议不存在 = 初始化失败（智谱
   *  Coding 端点预期 404 → 降级链换 CC）；任何其他 HTTP 状态 = 协议存在 = 探查通过；
   *  网络层失败/超时 = 探查未通过。 */
  async init(config: Parameters<ProtocolAdapter['init']>[0]): Promise<AdapterInitResult> {
    const baseResult = await super.init(config);
    if (!baseResult.success) {
      return baseResult;
    }
    this.stateful = true;
    this.lastResponseId = null;
    this.lastConsumedMessageCount = 0;
    this.reasoningItemReturnDisabled = false;
    this.reasoningMustPassBackResetDone = false;
    return this.probeProtocolEndpoint('/responses');
  }

  onChunk(handler: (chunk: AdapterChunk) => void): void {
    if (typeof handler !== 'function') {
      throw new Error('onChunk 注册失败：handler 非 function');
    }
    this.chunkHandler = handler;
  }

  onToolCall(handler: (toolCall: AdapterToolCall) => AdapterToolMessage | undefined): void {
    if (typeof handler !== 'function') {
      throw new Error('onToolCall 注册失败：handler 非 function');
    }
    this.toolCallHandler = handler;
  }

  onFinished(handler: (finished: AdapterFinished) => void): void {
    if (typeof handler !== 'function') {
      throw new Error('onFinished 注册失败：handler 非 function');
    }
    this.finishedHandler = handler;
  }

  // ============================================================
  // sendMessage：翻译 → 请求 → SSE 分发 → 双锚定终结
  // ============================================================

  async sendMessage(
    messages: Array<Record<string, unknown>>,
    opts: { multimodal: boolean; signal?: AbortSignal },
  ): Promise<AdapterTurnResult> {
    this.assertUsable('sendMessage');
    opts.signal?.throwIfAborted();
    this.terminal = false;

    // 排水：构建协议请求体之前、同步（无 await）排空 insert 队列（§5.4 硬约束）
    this.drainPendingMessages(messages);

    // ---- 翻译（宿主数组只读；翻译产物进自有缓冲） ----
    const translation = this.translateMessages(messages, opts.multimodal);
    const instructions = this.systemMessage || translation.systemFromMessages || undefined;
    // 有状态模式：本轮新 item = 宿主数组自 lastConsumedMessageCount 起的新消息翻译产物
    //   （上一轮已上传部分不重传；无状态模式恒全量）
    const sliceStart = this.stateful && this.lastResponseId
      ? (translation.itemStartByHostIndex[Math.min(this.lastConsumedMessageCount, messages.length)]
        ?? translation.inputItems.length)
      : 0;
    // let：reasoning item 降级重发时重算（剥离后重译切片）
    let newItems = translation.inputItems.slice(sliceStart);
    if (!this.stateful || !this.lastResponseId) {
      this.lastConsumedMessageCount = messages.length;
    }

    // ---- 请求体构造（§三.3.7 表） ----
    const buildBody = (): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: this.apiConfig!.model,
        stream: true,
        input: newItems,
      };
      if (instructions) {
        body.instructions = instructions;
      }
      const reasoning = buildReasoningParam(this.resolveThinkingLevel());
      if (reasoning) {
        body.reasoning = reasoning;
      }
      const tools = this.translateTools(this.resolveTools());
      if (tools) {
        body.tools = tools;
      }
      if (this.stateful) {
        body.store = true;
        if (this.lastResponseId) {
          body.previous_response_id = this.lastResponseId;
        }
      }
      // 智谱未声明参数一律不发：include / truncation / parallel_tool_calls / moderation /
      // temperature / reasoning.summary —— 白名单机制（P2）
      return body;
    };

    let attempt = 0;
    // 有状态降级标志（previous_response_id 失效 → 自动回退无状态完整回传并告警，单次）
    let statefulFallbackNeeded = false;
    // reasoning item 降级标志（指纹命中 → 剥离全部 reasoning item 后幂等重发一次，单次）
    let reasoningItemFallbackNeeded = false;
    // must-be-passed-back 复位重发标志（剥离态命中 DeepSeek 强校验指纹 → 复位恢复后重发一次，单次）
    let reasoningMustPassBackRestoreNeeded = false;

    while (true) {
      if (opts.signal?.aborted) {
        throw opts.signal.reason ?? new Error('ABORTED');
      }

      let body = buildBody();
      if (reasoningItemFallbackNeeded) {
        // 去除 reasoning item 后幂等重发（单次）：禁用标志已生效，重译自动剥离全部
        // reasoning item（真实+占位都不发），其余请求形态（stateful 续接切片/instructions/
        // reasoning 参数/tools）保持不变。
        reasoningItemFallbackNeeded = false;
        const retry = this.translateMessages(messages, opts.multimodal);
        const retryStart = this.stateful && this.lastResponseId
          ? (retry.itemStartByHostIndex[Math.min(this.lastConsumedMessageCount, messages.length)]
            ?? retry.inputItems.length)
          : 0;
        newItems = retry.inputItems.slice(retryStart);
        body = buildBody();
      }
      if (reasoningMustPassBackRestoreNeeded) {
        // 复位重发：剥离标志已复位（translateMessages 恢复发射 reasoning item——真实内容
        // 优先），按当前 stateful/
        // lastResponseId 实际状态重译构造重发体（禁用态=全量切片；有状态态=对应增量切片
        // 中恢复 reasoning item），其余请求形态（instructions/reasoning 参数/tools）不变。
        reasoningMustPassBackRestoreNeeded = false;
        const retry = this.translateMessages(messages, opts.multimodal);
        const retryStart = this.stateful && this.lastResponseId
          ? (retry.itemStartByHostIndex[Math.min(this.lastConsumedMessageCount, messages.length)]
            ?? retry.inputItems.length)
          : 0;
        newItems = retry.inputItems.slice(retryStart);
        body = buildBody();
      }
      if (statefulFallbackNeeded) {
        // 降级重发：无状态完整回传（input 全量、无 previous_response_id/store）
        this.lastResponseId = null;
        statefulFallbackNeeded = false;
        const full = this.translateMessages(messages, opts.multimodal);
        body = {
          model: this.apiConfig!.model,
          stream: true,
          input: full.inputItems,
          ...(instructions ? { instructions } : {}),
          ...(buildReasoningParam(this.resolveThinkingLevel())
            ? { reasoning: buildReasoningParam(this.resolveThinkingLevel()) } : {}),
          ...(this.translateTools(this.resolveTools())
            ? { tools: this.translateTools(this.resolveTools())! } : {}),
        };
      }

      let outcome: ResponsesTurnOutcome;
      try {
        outcome = await this.executeStreamRequest(body, opts.signal);
        opts.signal?.throwIfAborted();
      } catch (error) {
        if (opts.signal?.aborted
          || (error instanceof DOMException && error.name === 'AbortError')
          || (error instanceof Error && error.message === 'ABORTED')) {
          throw error; // 中止即异常路径：不触发 onFinished，原样上抛
        }
        // 有状态失效检测：服务端错误指明 previous_response_id 失效 → 降级重发一次
        if (this.stateful && this.lastResponseId && isPreviousResponseIdInvalidError(error)) {
          // eslint-disable-next-line no-console
          console.warn(
            '[responses-adapter] previous_response_id 失效（7 天有效期可能已过），自动降级无状态完整回传',
          );
          statefulFallbackNeeded = true;
          continue;
        }
        // stateful 专属参数被拒（store/previous_response_id 端点不支持，extra_forbidden/
        // unrecognized/unknown parameter 类指纹）：仅 stateful 语境降级——永久禁用本实例
        // stateful（重发体不再携带被拒参数，防降级重发死循环），全量重传保持历史完整。
        if (this.stateful && isStatefulParameterRejectedError(error)) {
          // eslint-disable-next-line no-console
          console.warn(
            '[responses-adapter] stateful 参数被端点拒绝（store/previous_response_id 不支持），本实例自动禁用 stateful 并全量重传',
          );
          this.stateful = false;
          this.lastResponseId = null;
          statefulFallbackNeeded = true;
          continue;
        }
        // reasoning input item 被拒检测（2026-10-07）：端点 400 校验指纹『期望 input_text
        // 实得 reasoning_text』（vllm/pydantic loc ResponseInputTextParam.type 形态）→ 本
        // 实例永久禁用 reasoning item 回传（真实+占位都不发，后续轮 translateMessages 剥离）
        // 并去除后幂等重发一次（标志置位防重发死循环）；重发仍失败按原错误正常失败。
        // DeepSeek 官方 must-be-passed-back 400 与该指纹严格互斥（不含 input_text，首门即
        // 拒）不会误触发——DeepSeek 端占位回传机制零影响。
        if (!this.reasoningItemReturnDisabled && isReasoningItemRejectedError(error)) {
          // eslint-disable-next-line no-console
          console.warn(
            '[responses-adapter] reasoning item 被端点拒绝（input 校验期望 input_text 实得 reasoning_text），本实例自动禁用 reasoning item 回传（真实+占位，后续轮全不发）并去除后重发',
          );
          this.reasoningItemReturnDisabled = true;
          reasoningItemFallbackNeeded = true;
          continue;
        }
        // must-be-passed-back 复位门（2026-10-07 供给链单点缺陷修复）：剥离态
        // （reasoningItemReturnDisabled 置位后）后续工具轮请求 input 必然缺前置
        // reasoning_text → DeepSeek thinking+tools 强校验 400『The `reasoning_text`
        // in the thinking mode must be passed back to the API』（13 项端点实测矩阵实证
        // 的充要回声）→ 复位剥离标志、恢复 reasoning item 回传并按当前 stateful/
        // lastResponseId 状态重发一次（实例级 guard 限一次，防与 vllm 指纹置位/复位
        // 震荡）；第二次仍命中按原错误直接失败上抛。未置位场景不重发（占位机制正常时
        // 该 400 与客户端剥离无关，重发无意义）。指纹与 vllm 三重门天然互斥
        // （must-be-passed-back 错误体不含 input_text 关键词，互斥首门即拒；vllm 形态
        // 不含 must be passed back）。
        if (this.reasoningItemReturnDisabled && !this.reasoningMustPassBackResetDone
          && isReasoningMustBePassedBackError(error)) {
          // eslint-disable-next-line no-console
          console.warn(
            '[responses-adapter] 剥离态命中 must-be-passed-back 400（thinking 模式要求回传 reasoning_text），复位剥离标志、恢复 reasoning item 回传后重发一次（实例级限次）',
          );
          this.reasoningItemReturnDisabled = false;
          this.reasoningMustPassBackResetDone = true;
          reasoningMustPassBackRestoreNeeded = true;
          continue;
        }
        const classified = classifyError(error);
        if (classified.retryable) {
          if (attempt >= MODEL_API_RETRY_LIMIT) {
            const abortError = new ModelApiAbortError({
              cause: error,
              retryCount: attempt,
              message: `Responses 端点错误已重试 ${MODEL_API_RETRY_LIMIT} 次，按取消处理：${errorMessage(error)}`,
            });
            this.fireFinished({ status: 'failed', error: { message: abortError.message }, finishReason: null });
            throw abortError;
          }
          attempt += 1;
          // 重试边界：复位协议回调（红线 R7 等价承载；end 信号态随思考增量态一并复位——契约 R7）
          this.hooksRef?.onStreamRetry?.();
          await sleepBeforeRetry(RESPONSES_RETRY_DELAY_MS, opts.signal);
          continue;
        }
        // 不可重试失败：失败轮恒触发 onFinished（R8）后原样上抛
        const message = errorMessage(error);
        const code = errorCode(error);
        this.fireFinished({
          status: 'failed',
          error: { ...(code ? { code } : {}), message },
          finishReason: null,
        });
        throw error;
      }

      // ---- 流内失败分类（SSE 终结事件 failed/error：HTTP 200 不作判据） ----
      if (outcome.kind === 'failed') {
        const code = outcome.error?.code ?? '';
        if (RETRYABLE_ERROR_CODES.has(code)) {
          if (attempt >= MODEL_API_RETRY_LIMIT) {
            const abortError = new ModelApiAbortError({
              cause: new Error(outcome.error?.message ?? 'response.failed'),
              retryCount: attempt,
              message: `Responses 端点错误已重试 ${MODEL_API_RETRY_LIMIT} 次，按取消处理：${outcome.error?.message ?? ''}`,
            });
            this.fireFinished({ status: 'failed', error: { message: abortError.message }, finishReason: null });
            throw abortError;
          }
          attempt += 1;
          this.hooksRef?.onStreamRetry?.();
          await sleepBeforeRetry(RESPONSES_RETRY_DELAY_MS, opts.signal);
          continue;
        }
        // 不可重试：onFinished(failed) + reject（宿主 catch 分类链处理）
        this.fireFinished({
          status: 'failed',
          error: { ...(code ? { code } : {}), message: outcome.error?.message ?? 'response.failed' },
          finishReason: null,
        });
        throw new Error(`[responses] ${code ? code + ': ' : ''}${outcome.error?.message ?? 'response.failed'}`);
      }

      // ---- 成功/截断终结 ----
      const finished = this.buildFinished(outcome);
      this.fireFinished(finished);
      if (this.stateful && outcome.kind === 'completed') {
        // 首轮响应回显验证（通用适配，2026-10-07）：OpenAI 系响应对象固定回显 store 字段
        // （官方 Cookbook 实测天然探测点）；response.store===true 判支持并缓存 lastResponseId；
        // store===false 或字段缺失（DeepSeek 官方 The API is stateless / Sub2API CN 上游剥离）
        // 判不支持 → 本实例内禁用 stateful（后续轮全量重传防增量静默丢历史——禁用后 buildBody
        // 不再携带 store/previous_response_id 且恒全量切片）。
        if (outcome.responseId && outcome.storeEcho === true) {
          this.lastResponseId = outcome.responseId;
          this.lastConsumedMessageCount = messages.length;
        } else {
          this.stateful = false;
          this.lastResponseId = null;
          // eslint-disable-next-line no-console
          console.warn(
            '[responses-adapter] 有状态模式回显验证未通过（response.store!==true 或字段缺失），本实例自动禁用 stateful，后续轮全量重传',
          );
        }
      }
      return this.buildTurnResult(outcome, finished);
    }
  }

  // ============================================================
  // 翻译层（§三.3.2 / §三.3.5，白名单，宿主数组只读）
  // ============================================================

  private translateMessages(
    messages: Array<Record<string, unknown>>,
    multimodal: boolean,
  ): {
    inputItems: ResponsesInputItem[];
    systemFromMessages: string;
    /** 宿主消息下标 → 翻译产物起始 item 下标映射（长度 = messages.length + 1；末项 = 全量终点） */
    itemStartByHostIndex: number[];
  } {
    const inputItems: ResponsesInputItem[] = [];
    let systemFromMessages = '';
    const itemStartByHostIndex: number[] = [];
    // 逐调用配对发射登记：已被 assistant 分支配对发射的宿主 tool 消息下标（主循环跳过防重复发射）
    const pairedToolIndexes = new Set<number>();
    for (let i = 0; i < messages.length; i += 1) {
      // 记录该宿主消息翻译产物的起始 item 下标（含 system 剥离后的空洞映射）
      itemStartByHostIndex[i] = inputItems.length;
      const message = messages[i];
      const role = typeof message.role === 'string' ? message.role : '';
      // system 剥离 → instructions 单一来源（init.systemMessage 权威；数组 system 仅兜底）
      if (role === 'system') {
        if (!systemFromMessages && typeof message.content === 'string') {
          systemFromMessages = message.content;
        }
        continue;
      }
      if (role === 'user') {
        inputItems.push(...translateUserMessage(message, multimodal));
        continue;
      }
      if (role === 'assistant') {
        const { reasoning, calls, text } = buildAssistantItems(message);
        // reasoning item 接受性降级剥离（2026-10-07）：本实例已被端点指纹判『拒 reasoning
        // input item』后真实+占位一律不发（vllm 占位/真实同型 400 实测；DeepSeek 端不命中
        // 指纹零影响，占位机制照常）
        const reasoningItems = this.reasoningItemReturnDisabled ? [] : reasoning;
        if (calls.length === 0) {
          // 无有效 tool_calls：与原翻译路径一致（reasoning → output_text）
          inputItems.push(...reasoningItems, ...text);
          continue;
        }
        // 逐调用配对相邻发射：每个 function_call 紧随其按 tool_call id 配对的 function_call_output；
        // 配对域 = 紧随本 assistant 的连续 tool 消息批次，依宿主序一次前向遍历按 id 命中即配
        inputItems.push(...reasoningItems);
        for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
          const call = calls[callIndex];
          inputItems.push(call.item);
          for (let j = i + 1; j < messages.length; j += 1) {
            const toolMessage = messages[j];
            if (typeof toolMessage.role !== 'string' || toolMessage.role !== 'tool') {
              break; // 连续 tool 批次结束
            }
            if (pairedToolIndexes.has(j)) {
              continue; // 已被先前 call 配对消费
            }
            const toolCallId = typeof toolMessage.tool_call_id === 'string'
              ? toolMessage.tool_call_id
              : '';
            if (toolCallId && toolCallId === call.id) {
              inputItems.push(translateToolMessage(toolMessage));
              pairedToolIndexes.add(j);
              break;
            }
          }
        }
        inputItems.push(...text);
        continue;
      }
      if (role === 'tool') {
        // 已配对发射过的输出不重复发射；未配对（无对应 function_call 的孤儿输出）仍按宿主序发射
        if (!pairedToolIndexes.has(i)) {
          inputItems.push(translateToolMessage(message));
        }
        continue;
      }
      // 其他历史形态（function role 等）现状链路不产生 → 不生成（A1）
    }
    itemStartByHostIndex[messages.length] = inputItems.length;
    return { inputItems, systemFromMessages, itemStartByHostIndex };
  }

  /** 工具定义转换：OpenAI Chat 嵌套形态 → Responses 扁平形态（§三.3.5） */
  private translateTools(
    tools: Array<Record<string, unknown>> | undefined,
  ): Array<Record<string, unknown>> | undefined {
    if (!tools || !tools.length) {
      return undefined;
    }
    const out: Array<Record<string, unknown>> = [];
    for (const tool of tools) {
      const fn = (tool as { function?: Record<string, unknown> }).function;
      if (!fn || typeof fn !== 'object') {
        continue; // 白名单：非 function 形态不透传
      }
      const flat: Record<string, unknown> = { type: 'function' };
      if (typeof fn.name === 'string') flat.name = fn.name;
      if (typeof fn.description === 'string') flat.description = fn.description;
      if (fn.parameters && typeof fn.parameters === 'object') flat.parameters = fn.parameters;
      out.push(flat);
    }
    return out.length ? out : undefined;
  }

  // ============================================================
  // HTTP + SSE 读取与事件分发（双锚定）
  // ============================================================

  private async executeStreamRequest(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<ResponsesTurnOutcome> {
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), RESPONSES_REQUEST_TIMEOUT_MS);
    const onUserAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeoutTimer);
        throw signal.reason ?? new Error('ABORTED');
      }
      signal.addEventListener('abort', onUserAbort, { once: true });
    }
    let res: Response;
    try {
      res = await fetch(`${trimBaseUrl(this.apiConfig!.baseUrl)}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiConfig!.apiKey}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onUserAbort);
      // 传输层错误归一化为带 name/code 的 Error 交分类器（C-5）
      if (signal?.aborted) {
        throw signal.reason ?? new Error('ABORTED');
      }
      throw normalizeTransportError(error);
    } finally {
      // fetch 已 settle：超时计时器仅在流读取期间保留
    }

    // HTTP 非 200：进入错误分类（HTTP 200 不作成功判据——仅放行读取 SSE）
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      clearTimeout(timeoutTimer);
      if (signal) signal.removeEventListener('abort', onUserAbort);
      let code = '';
      let message = errBody.slice(0, 500) || `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(errBody) as { error?: { code?: string; message?: string } };
        if (parsed?.error) {
          code = typeof parsed.error.code === 'string' ? parsed.error.code : '';
          if (typeof parsed.error.message === 'string') message = parsed.error.message;
        }
      } catch {
        // 非 JSON 错误体：保留原文片段
      }
      const error = new Error(`[responses] ${code ? code + ': ' : ''}${message}`) as Error & { code?: string; status?: number };
      error.code = code || String(res.status);
      error.status = res.status;
      throw error;
    }

    // ---- SSE 增量重组读取（chunked 分帧正确重组：按行缓冲，绝不分帧即解析） ----
    const state = new ResponsesStreamState();
    const reader = res.body?.getReader();
    if (!reader) {
      clearTimeout(timeoutTimer);
      if (signal) signal.removeEventListener('abort', onUserAbort);
      throw new Error('[responses] 响应无 body（流不可读）');
    }
    try {
      const decoder = new TextDecoder();
      let buffer = '';
      let stopped = false;
      const processLine = (rawLine: string): void => {
        if (stopped) return;
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line === '') {
          // SSE 事件边界（空行）：分发收集到的 event/data
          const shouldStop = state.dispatchEvent(this);
          if (shouldStop) stopped = true;
          return;
        }
        if (line.startsWith('event:')) {
          state.currentEvent = line.slice(6).trim();
          return;
        }
        if (line.startsWith('data:')) {
          state.currentData += (state.currentData ? '\n' : '') + line.slice(5).trimStart();
          return;
        }
        // 注释行/未知行：安全忽略
      };
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break; // 流耗尽（reader 自然结束）
        buffer += decoder.decode(value, { stream: true });
        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx >= 0) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          processLine(line);
          if (stopped) break;
          newlineIdx = buffer.indexOf('\n');
        }
      }
      // 流耗尽兜底：无终结事件 → protocol-error（§三.3.6-4；禁 EOF 判定——到达此点
      // 意味着连接关闭而未收到终结事件/[DONE]，属协议完整性违例）
      if (!state.terminalFired) {
        state.finishAsExhausted();
      }
      return state.buildOutcome();
    } finally {
      // 停止读取：释放底层连接（服务端 [DONE] 后不关闭连接——不主动取消将挂住至超时）
      clearTimeout(timeoutTimer);
      if (signal) signal.removeEventListener('abort', onUserAbort);
      try {
        await reader.cancel();
      } catch {
        // 已取消/已结束：忽略
      }
    }
  }

  // ---- 分发层经 state 回调宿主（由 ResponsesStreamState.dispatchEvent 调用） ----

  /** onChunk 发出（回调内异常吞掉记日志不中断生成流） */
  emitChunk(chunk: AdapterChunk): void {
    if (this.closed || !this.chunkHandler) return;
    try {
      this.chunkHandler(chunk);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[responses-adapter] onChunk 回调异常（已吞掉）:', err);
    }
  }

  /** onToolCall 发出（仅 function_call item output_item.done 完整快照） */
  emitToolCall(toolCall: AdapterToolCall): void {
    if (this.closed || !this.toolCallHandler) return;
    try {
      this.toolCallHandler(toolCall);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[responses-adapter] onToolCall 回调异常（按该工具执行失败处理）:', err);
    }
  }

  private fireFinished(finished: AdapterFinished): void {
    if (this.closed || !this.finishedHandler) return;
    try {
      this.finishedHandler(finished);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[responses-adapter] onFinished 回调异常（已吞掉）:', err);
    }
  }

  private buildFinished(outcome: ResponsesTurnOutcome): AdapterFinished {
    if (outcome.kind === 'completed') {
      return {
        status: 'completed',
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        ...(outcome.model ? { model: outcome.model } : {}),
        assistantMessage: outcome.assistantMessage,
        finishReason: outcome.toolCalls.length > 0 ? 'tool_calls' : 'stop',
      };
    }
    if (outcome.kind === 'incomplete') {
      return {
        status: 'incomplete',
        incompleteReason: outcome.incompleteReason,
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        ...(outcome.model ? { model: outcome.model } : {}),
        assistantMessage: outcome.assistantMessage,
        finishReason: outcome.incompleteReason === 'max_output_tokens' ? 'length' : null,
      };
    }
    return {
      status: 'failed',
      error: { message: outcome.error?.message ?? 'failed' },
      finishReason: null,
    };
  }

  private buildTurnResult(outcome: ResponsesTurnOutcome, finished: AdapterFinished): AdapterTurnResult {
    return {
      content: outcome.content,
      reasoning: outcome.reasoning,
      toolCalls: outcome.toolCalls,
      finished,
      assistantMessage: outcome.assistantMessage,
      finishReason: finished.finishReason ?? null,
      model: outcome.model,
    };
  }

  protected releaseResources(): void {
    this.lastResponseId = null;
    this.lastConsumedMessageCount = 0;
    this.chunkHandler = null;
    this.toolCallHandler = null;
    this.finishedHandler = null;
  }
}

// ============================================================
// SSE 分发状态机（独立类：单轮隔离，事件序严格对齐 A2 实测形态）
// ============================================================

class ResponsesStreamState {
  currentEvent = '';
  currentData = '';
  terminalFired = false;

  /** 流内累积 */
  private reasoningAcc = '';
  private contentAcc = '';
  private toolCalls: AdapterToolCall[] = [];
  /** 当前 item 类型窗口（reasoning / message / function_call；item 生命周期内有效） */
  private currentItemTypes: Array<'reasoning' | 'message' | 'function_call' | null> = [];
  private s1OpenReasoning = false;

  private outcome: ResponsesTurnOutcome | null = null;

  /** 分发单个 SSE 事件（event+data 已收集完整）；返回 true = 停止读取 */
  dispatchEvent(adapter: ResponsesAdapter): boolean {
    const eventType = this.currentEvent || inferEventTypeFromData(this.currentData);
    const dataRaw = this.currentData;
    this.currentEvent = '';
    this.currentData = '';

    // [DONE] 流帧终结冗余确认（不承载语义；到达即停止读取——P8 第 2 条）
    if (dataRaw === '[DONE]') {
      return true;
    }

    let event: LooseEvent | null = null;
    if (dataRaw) {
      try {
        event = JSON.parse(dataRaw) as LooseEvent;
      } catch {
        // data 解析失败（chunked 切裂残留等）：event: 行为权威事件类型恢复源（A2 教训），
        // 无载荷可分发时安全跳过该事件（不中断流）
        return false;
      }
    }

    switch (eventType) {
      case 'response.created':
      case 'response.in_progress':
        return false; // 非终结，无信号
      default:
        break;
    }

    if (!event) {
      return false;
    }

    switch (eventType) {
      // ---- reasoning item 生命周期（G6 已实测顺序化） ----
      case 'response.output_item.added': {
        const item = event.item ?? {};
        const itemType = typeof item.type === 'string' ? item.type : '';
        if (itemType === 'reasoning') {
          // 开启 reasoning 累积窗口（不回调）
          this.s1OpenReasoning = true;
        }
        return false;
      }
      case 'response.content_part.added':
        return false; // part 结构事件仅实现细节，不产出信号
      case 'response.reasoning_text.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) {
          this.reasoningAcc += delta;
          adapter.emitChunk({ type: 'reasoning', delta, cumulative: this.reasoningAcc });
        }
        return false;
      }
      case 'response.reasoning_summary_text.delta': {
        // OpenAI 端点预留（智谱无）：归入 reasoning，与 reasoning_text 并存时按到达顺序拼接
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) {
          this.reasoningAcc += delta;
          adapter.emitChunk({ type: 'reasoning', delta, cumulative: this.reasoningAcc });
        }
        return false;
      }
      case 'response.reasoning_text.done':
      case 'response.reasoning_summary_text.done': {
        // cumulative 校验纠偏（done 携带该段完整 text），不推送
        if (typeof event.text === 'string' && event.text) {
          this.reasoningAcc = event.text;
        }
        return false;
      }
      case 'response.output_item.done': {
        const item = event.item ?? {};
        const itemType = typeof item.type === 'string' ? item.type : '';
        if (itemType === 'reasoning') {
          // ★ S1 权威锚点：reasoning item 的 output_item.done（9/9 到达；恒先于后继 item added）
          if (this.s1OpenReasoning) {
            adapter.emitChunk({
              type: 'reasoning',
              delta: '',
              cumulative: this.reasoningAcc,
              end: 'segment',
            });
            this.s1OpenReasoning = false;
          }
          return false;
        }
        if (itemType === 'message') {
          // ★ S2/S3 同刻同源：message item done → 单回调 end:'message'（R5 重合合一；
          //   空 message item 亦发一次——R3 每条实际存在的 message 恰一次）
          adapter.emitChunk({
            type: 'content',
            delta: '',
            cumulative: this.contentAcc,
            end: 'message',
          });
          return false;
        }
        if (itemType === 'function_call') {
          // ★ onToolCall 触发铁律：仅 output_item.done 完整快照（绝不以 added/delta 中间态触发）
          const callId = typeof item.call_id === 'string' ? item.call_id : '';
          const name = typeof (item as { name?: unknown }).name === 'string'
            ? (item as { name: string }).name : '';
          const args = typeof (item as { arguments?: unknown }).arguments === 'string'
            ? (item as { arguments: string }).arguments : '';
          if (callId && name) {
            const toolCall: AdapterToolCall = {
              id: callId, // call_id ↔ 宿主 id 恒等直传（§三.3.5）
              type: 'function',
              function: { name, arguments: args },
            };
            this.toolCalls.push(toolCall);
            adapter.emitToolCall(toolCall);
          }
          return false;
        }
        return false; // 未知 item 类型：安全忽略（白名单）
      }
      // ---- message item 增量（G3 已固化：response.output_text.delta/.done） ----
      case 'response.output_text.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) {
          this.contentAcc += delta;
          adapter.emitChunk({ type: 'content', delta, cumulative: this.contentAcc });
        }
        return false;
      }
      case 'response.output_text.done': {
        if (typeof event.text === 'string' && event.text) {
          this.contentAcc = event.text; // cumulative 校验纠偏，不推送
        }
        return false;
      }
      case 'response.content_part.done':
        return false;
      // ---- function_call 增量（G4 序列；中间态零触发） ----
      case 'response.function_call_arguments.delta':
      case 'response.function_call_arguments.done':
        return false; // 可选增量缓存：完整快照以 output_item.done 为准
      // ---- 终结事件全集（权威锚，P8 第 1 条） ----
      case 'response.completed': {
        const response = event.response ?? {};
        this.applyCompletedSnapshot(response);
        this.outcome = {
          kind: 'completed',
          content: this.contentAcc,
          reasoning: this.reasoningAcc,
          toolCalls: this.toolCalls,
          usage: extractUsage(response),
          model: typeof response.model === 'string' ? response.model : undefined,
          responseId: typeof response.id === 'string' ? response.id : undefined,
          storeEcho: typeof response.store === 'boolean' ? response.store : undefined,
          assistantMessage: buildAssistantMessage(this.contentAcc, this.toolCalls),
        };
        this.terminalFired = true;
        return true; // 终结事件到达即停止 SSE 消费（不等待 [DONE]/EOF）
      }
      case 'response.incomplete': {
        const response = event.response ?? {};
        this.applyCompletedSnapshot(response);
        const reasonRaw = ((response.incomplete_details ?? {}) as { reason?: unknown }).reason;
        const reason = typeof reasonRaw === 'string' ? reasonRaw : undefined;
        this.outcome = {
          kind: 'incomplete',
          content: this.contentAcc,
          reasoning: this.reasoningAcc,
          toolCalls: this.toolCalls,
          incompleteReason: (reason === 'max_output_tokens' || reason === 'max_messages'
            || reason === 'content_filter' || reason === 'steered') ? reason : undefined,
          usage: extractUsage(response),
          model: typeof response.model === 'string' ? response.model : undefined,
          responseId: typeof response.id === 'string' ? response.id : undefined,
          assistantMessage: buildAssistantMessage(this.contentAcc, this.toolCalls),
        };
        this.terminalFired = true;
        return true;
      }
      case 'response.failed': {
        const response = event.response ?? {};
        const error = (response.error ?? {}) as { code?: unknown; message?: unknown };
        this.outcome = {
          kind: 'failed',
          content: this.contentAcc,
          reasoning: this.reasoningAcc,
          toolCalls: this.toolCalls,
          error: {
            ...(typeof error.code === 'string' ? { code: error.code } : {}),
            message: typeof error.message === 'string' ? error.message : 'response.failed',
          },
          usage: undefined,
          model: undefined,
          responseId: typeof response.id === 'string' ? response.id : undefined,
          assistantMessage: undefined,
        };
        this.terminalFired = true;
        return true;
      }
      case 'error': {
        // 独立 error 事件（type 字面 error）：分发层独立处理（不依赖 response.failed 先行，C-3）
        this.outcome = {
          kind: 'failed',
          content: this.contentAcc,
          reasoning: this.reasoningAcc,
          toolCalls: this.toolCalls,
          error: {
            ...(typeof event.code === 'string' ? { code: event.code } : {}),
            message: typeof event.message === 'string' ? event.message : 'error event',
          },
          usage: undefined,
          model: undefined,
          responseId: undefined,
          assistantMessage: undefined,
        };
        this.terminalFired = true;
        return true;
      }
      default:
        // 未知事件：安全忽略（智谱事件全集 19 种之外/no-op；白名单）
        return false;
    }
  }

  /** completed/incomplete 内嵌 output 全量快照纠偏（item 级权威全文覆盖流内累积） */
  private applyCompletedSnapshot(response: Record<string, unknown>): void {
    const output = Array.isArray(response.output) ? (response.output as Array<Record<string, unknown>>) : null;
    if (!output) {
      return;
    }
    let reasoning = '';
    let content = '';
    const toolCalls: AdapterToolCall[] = [];
    for (const item of output) {
      const itemType = typeof item.type === 'string' ? item.type : '';
      if (itemType === 'reasoning') {
        reasoning += extractItemText(item);
      } else if (itemType === 'message') {
        content += extractItemText(item);
      } else if (itemType === 'function_call') {
        const callId = typeof item.call_id === 'string' ? item.call_id : '';
        const name = typeof item.name === 'string' ? item.name : '';
        const args = typeof item.arguments === 'string' ? item.arguments : '';
        if (callId && name) {
          toolCalls.push({ id: callId, type: 'function', function: { name, arguments: args } });
        }
      }
    }
    if (reasoning) this.reasoningAcc = reasoning;
    if (content) this.contentAcc = content;
    if (toolCalls.length) this.toolCalls = toolCalls;
  }

  /** 流耗尽兜底（无终结事件/[DONE] 而连接关闭——协议完整性守卫，§三.3.6-4） */
  finishAsExhausted(): void {
    this.outcome = {
      kind: 'failed',
      content: this.contentAcc,
      reasoning: this.reasoningAcc,
      toolCalls: this.toolCalls,
      error: { message: 'protocol-error: stream exhausted without terminal event' },
      usage: undefined,
      model: undefined,
      responseId: undefined,
      assistantMessage: undefined,
    };
    this.terminalFired = true;
  }

  buildOutcome(): ResponsesTurnOutcome {
    if (!this.outcome) {
      this.finishAsExhausted();
    }
    return this.outcome!;
  }
}

// ============================================================
// 类型与纯函数
// ============================================================

type ResponsesTurnOutcome = {
  kind: 'completed' | 'incomplete' | 'failed';
  content: string;
  reasoning: string;
  toolCalls: AdapterToolCall[];
  incompleteReason?: 'max_output_tokens' | 'max_messages' | 'content_filter' | 'steered';
  error?: { code?: string; message: string };
  usage?: AdapterFinished['usage'];
  model?: string;
  responseId?: string;
  /** response.completed 回显的 response.store 布尔原样（字段缺失=undefined）——有状态回显验证探测点 */
  storeEcho?: boolean;
  assistantMessage?: Record<string, unknown>;
};

/** user 消息翻译（§三.3.2 表；image_url→input_image 平铺剔除 detail；multimodal=false 含图 fail-fast） */
function translateUserMessage(
  message: Record<string, unknown>,
  multimodal: boolean,
): ResponsesInputItem[] {
  const content = message.content;
  if (typeof content === 'string') {
    return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: content }] }];
  }
  if (!Array.isArray(content)) {
    // 现状不产生的形态：白名单跳过
    return [];
  }
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      parts.push({ type: 'input_text', text: record.text });
      continue;
    }
    if (record.type === 'image_url') {
      if (!multimodal) {
        // fail-fast：宿主 bug 优于服务端 400（§三.3.5）
        throw new Error('[responses-adapter] multimodal=false 但消息含 image part（fail-fast 拒绝）');
      }
      const imageUrl = record.image_url as { url?: unknown } | undefined;
      if (imageUrl && typeof imageUrl.url === 'string') {
        // 平铺字符串，剔除 detail（智谱无此字段）
        parts.push({ type: 'input_image', image_url: imageUrl.url });
      }
      continue;
    }
    // 未知 part 类型：不透传（白名单）
  }
  return [{ type: 'message', role: 'user', content: parts }];
}

/** assistant 消息翻译拆解（§三.3.2 表：reasoning_content→InputReasoning 文本态 + function_call 清单
 *  + output_text 回放）。仅负责项构造；fc/fco 逐调用配对相邻发射由 translateMessages 编排。 */
function buildAssistantItems(message: Record<string, unknown>): {
  reasoning: ResponsesInputItem[];
  calls: Array<{ id: string; item: ResponsesInputItem }>;
  text: ResponsesInputItem[];
} {
  const reasoning: ResponsesInputItem[] = [];
  const calls: Array<{ id: string; item: ResponsesInputItem }> = [];
  const text: ResponsesInputItem[] = [];
  const reasoningContent = message.reasoning_content;
  if (typeof reasoningContent === 'string' && reasoningContent) {
    // InputReasoning Required 仅 type+content（无需 id/encrypted_content；本地 payload.thinking 纯文本直接承载）
    reasoning.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: reasoningContent }] });
  }
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== 'object') continue;
      const record = toolCall as Record<string, unknown>;
      const fn = record.function as Record<string, unknown> | undefined;
      if (!fn) continue;
      const id = typeof record.id === 'string' ? record.id : '';
      const name = typeof fn.name === 'string' ? fn.name : '';
      const args = typeof fn.arguments === 'string' ? fn.arguments : '{}';
      if (id && name) {
        calls.push({ id, item: { type: 'function_call', name, call_id: id, arguments: args } });
      }
    }
  }
  const content = message.content;
  if (typeof content === 'string' && content) {
    text.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] });
  }
  return { reasoning, calls, text };
}

/** tool 消息翻译（output 仅字符串；非 string 防御性 JSON 序列化） */
function translateToolMessage(message: Record<string, unknown>): ResponsesInputItem {
  const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
  const raw = message.content;
  const output = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  return { type: 'function_call_output', call_id: callId, output };
}

/** reasoning effort 透传（2026-10-07 用户拍板：服务端默认都开 thinking；不转换——vllm 有 xhigh 枚举）：
 *  空串→undefined 不发 reasoning 参数（服务端默认开 thinking——DeepSeek 官方与 vllm 双端点实测：
 *  不带 reasoning 参数时首个产出 item 均为 reasoning）；任何非空档位原样透传 {effort:level} 零收敛
 *  （vllm pydantic 白名单 {none,minimal,low,medium,high,xhigh,max} 原生含 xhigh/minimal，2026-10-07
 *  ultra→400 literal_error 一手实测；DeepSeek 官方宽松放行任意字符串并按文档映射 xhigh→high/
 *  minimal→low）；未知字符串同样原样透传，枚举校验交由服务端（400 即既有错误分类路径）。 */
function buildReasoningParam(level: AdapterThinkingLevel): { effort: Exclude<AdapterThinkingLevel, ''> } | undefined {
  if (!level) {
    return undefined; // 空串→不发送 reasoning 参数（服务端默认开 thinking）
  }
  return { effort: level };
}

function extractUsage(response: Record<string, unknown>): AdapterFinished['usage'] {
  const usage = response.usage as Record<string, unknown> | null | undefined;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  const out: NonNullable<AdapterFinished['usage']> = {};
  if (typeof usage.input_tokens === 'number') out.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') out.outputTokens = usage.output_tokens;
  if (typeof usage.total_tokens === 'number') out.totalTokens = usage.total_tokens;
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  if (outputDetails && typeof outputDetails.reasoning_tokens === 'number') {
    out.reasoningTokens = outputDetails.reasoning_tokens;
  }
  const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
  if (inputDetails && typeof inputDetails.cached_tokens === 'number') {
    out.cachedTokens = inputDetails.cached_tokens;
  }
  return Object.keys(out).length ? out : undefined;
}

function extractItemText(item: Record<string, unknown>): string {
  const content = item.content;
  if (!Array.isArray(content)) {
    return '';
  }
  let text = '';
  for (const part of content) {
    if (part && typeof part === 'object') {
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') {
        text += record.text;
      }
    }
  }
  return text;
}

/** 宿主统一格式 assistant 消息（形态对齐现状 streamChatOnce 产物 L388-404：
 *  hasToolCalls 时 content=null；reasoning_content 不含——executor 侧补挂逻辑等价保留） */
function buildAssistantMessage(
  content: string,
  toolCalls: AdapterToolCall[],
): Record<string, unknown> {
  const hasToolCalls = toolCalls.length > 0;
  return {
    role: 'assistant',
    content: hasToolCalls ? null : content,
    ...(hasToolCalls
      ? {
          tool_calls: toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: 'function',
            function: { name: toolCall.function.name, arguments: toolCall.function.arguments },
          })),
        }
      : {}),
    refusal: null,
  };
}

/** event: 行缺失时从 data 推断事件类型（A2 实测形态兼容：智谱恒带 event: 行，此为防御） */
function inferEventTypeFromData(dataRaw: string): string {
  if (!dataRaw || dataRaw === '[DONE]') {
    return '';
  }
  try {
    const parsed = JSON.parse(dataRaw) as { type?: string };
    return typeof parsed.type === 'string' ? parsed.type : '';
  } catch {
    return '';
  }
}

function trimBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return trimmed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

/** 错误分类（§三.3.8 分类表：未列枚举默认不可重试——保守策略） */
function classifyError(error: unknown): { retryable: boolean } {
  const code = errorCode(error);
  if (code && RETRYABLE_ERROR_CODES.has(code)) {
    return { retryable: true };
  }
  const status = error && typeof error === 'object' && 'status' in error
    ? (error as { status?: unknown }).status : undefined;
  if (typeof status === 'number' && RETRYABLE_HTTP_STATUS.has(status)) {
    return { retryable: true };
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'TypeError' || name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') {
    // fetch 网络层失败（TypeError: fetch failed 等）：可重试（对齐现状网络错误 10s 档——
    // 统一 1s 节律为保守收敛，§三.3.8 节律对齐工程惯例）
    return { retryable: true };
  }
  return { retryable: false };
}

/** previous_response_id 失效检测（服务端错误指明：7 天有效期/不存在/store 未开启等）。
 *  'previous_response_not_found'（2026-10-07 补：Sub2API code 形态，与 OpenAI 错误码同形——
 *  错误串 '[responses] previous_response_not_found: not found'，既有三子串全不命中）；既有三关键词保留 */
function isPreviousResponseIdInvalidError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('previous_response_id')
    || message.includes('previous response')
    || message.includes('response not found')
    || message.includes('previous_response_not_found');
}

/** stateful 专属参数（store/previous_response_id）被端点拒绝的指纹：OpenAI 形态
 *  'Unrecognized request argument supplied: store' / 'Unknown parameter: ...' / 'unknown_argument'；
 *  pydantic/vllm 形态 'Extra inputs are not permitted'（code=extra_forbidden）。
 *  仅在 this.stateful 语境下检测（缩小误匹配面：非有状态请求的参数被拒走既有失败路径不降级）。 */
function isStatefulParameterRejectedError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('extra_forbidden')
    || message.includes('extra inputs are not permitted')
    || message.includes('unrecognized request argument')
    || message.includes('unknown parameter')
    || message.includes('unknown_argument');
}

/** reasoning input item 被端点拒绝的 400 校验指纹（2026-10-07 vllm 真实端点实测形态）：
 *  仅命中『端点期望 input_text 而实得 reasoning_text』的 item 类型校验错误——
 *  vllm/pydantic 形态（errBody.slice(0,500) 截断窗口内实测齐备）：
 *   loc 'body.input.N.EasyInputMessageParam.content.M.ResponseInputTextParam.type'
 *   + msg "Input should be 'input_text'" + input 'reasoning_text'；
 *   等价精确形态（expected …'input_text'… got …'reasoning_text'…）同收。
 *  互斥设计：DeepSeek 官方 thinking+tools 强校验 400『The `reasoning_text` in the thinking
 *  mode must be passed back to the API』含 reasoning_text 但绝不含 input_text——首门
 *  『双关键词齐备』即拒，绝不触发本降级（防占位机制被误伤）。 */
function isReasoningItemRejectedError(error: unknown): boolean {
  const lower = errorMessage(error).toLowerCase();
  if (!lower.includes('input_text') || !lower.includes('reasoning_text')) {
    return false; // 互斥首门：缺任一关键词（DeepSeek must-be-passed-back 形态无 input_text）即不命中
  }
  return lower.includes('responseinputtextparam.type')
    || lower.includes("input should be 'input_text'")
    || (/expected.{0,80}'input_text'/.test(lower) && /got.{0,80}'reasoning_text'/.test(lower));
}

/** DeepSeek 官方 thinking+tools 强校验指纹（must-be-passed-back，2026-10-07 端点实测原文）：
 *  『The `reasoning_text` in the thinking mode must be passed back to the API
 *  (request_id: <UUID>)』/ type invalid_request_error / code invalid_request_error——
 *  含 reasoning_text + must be passed back 双关键词（B1 全量版/Q4 续接版错误体逐字段同构）。
 *  与 vllm 三重门指纹（isReasoningItemRejectedError）天然互斥：vllm 形态必含 input_text
 *  （其互斥首门要求 input_text+reasoning_text 双关键词齐备），本指纹形态不含 input_text
 *  且 vllm 形态不含 must be passed back——两指纹无交集，识别互不误伤。 */
function isReasoningMustBePassedBackError(error: unknown): boolean {
  const lower = errorMessage(error).toLowerCase();
  return lower.includes('reasoning_text') && lower.includes('must be passed back');
}

function normalizeTransportError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(`[responses] 传输层错误：${String(error)}`);
}
