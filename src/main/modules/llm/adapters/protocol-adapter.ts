/**
 * ProtocolAdapter - 多协议适配器抽象基类（七成员契约 + 排队基座）
 *
 * 宿主统一格式 = 现状 OpenAI Chat 格式（上下文所有权归宿主，适配器对宿主数组只读，
 * Responses 侧翻译进自有缓冲）；七成员 = init / close / sendMessage / insertMessage /
 * onChunk / onToolCall / onFinished（四操作成员 + 三回调注册成员，成员数量不可增减）。
 *
 * 排队基座：insert_message 入队 FIFO 与守卫语义内建于抽象类（CC/Responses 共用）；
 * 守卫对齐 executor-task-record-store.ts L546-554 既有三拒收（terminal / stop-requested /
 * queue-full，上限对齐 L68 EXECUTOR_TASK_MESSAGE_MAX_PENDING）+ 前置 invalid。
 *
 * 设计原则：P3 非常驻实例（实例即配置快照 + 排队边界 + 会话边界；禁止二次 init；close 幂等）；
 * P7 live-binding 禁快照（tools 双形态 Array | getter，每次 sendMessage resolve）。
 */

// ============================================================
// 配套类型（宿主统一格式 = 现状 OpenAI Chat 格式，红线保全）
// ============================================================

/** 大模型 API 配置（对齐现状 ModelConfig，openai-client.ts L23-30） */
export interface AdapterApiConfig {
  baseUrl: string;
  apiKey: string; // 仅运行期内存传递；禁止写入任何日志/持久化/文档
  model: string;
}

/** 思考程度设置（对齐现状档位通道：main-agent.ts L702 / executor-agent.ts L1069；
 *  每轮实时读取 AppSettings.mainThinkingLevel / executorThinkingLevel；空串=不设置，
 *  现状语义：buildThinkingParams 对空串彻底不写 reasoning_effort 键（openai-client.ts L174-181）。
 *  含 'xhigh'：覆盖 shared ModelProfile 档位全集（CC 侧原样透传；Responses 侧 2026-10-07 起
 *  同为原样透传零收敛——vllm 原生含 xhigh/minimal 枚举，收敛分支已删除；空串不发 reasoning 参数，
 *  服务端默认开 thinking）。 */
export type AdapterThinkingLevel = '' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 单个流式 chunk（融合签名：A3 {type,delta,cumulative} + A4 end 枚举语义无损融合）：
 *  - delta = 本次增量文本，"有值传没值空"（纯终结信号回调时 delta=''）
 *  - cumulative = 截至本次的本轮累计文本（M13 重试复位全量覆盖通道的载体，
 *    对齐现状 StreamChunk L85-100 双粒度）
 *  - end = 可选瞬时流控制标志（S1/S2=end:'segment'；S3=end:'message'；缺省即纯增量）
 *  - finishReason = 可选终结原因视图（仅 finish 时刻的 chunk 携带；CC 侧为现状
 *    finish_reason 的等价透传通道——G5 实测 finish chunk 独立且 delta.content 空串，
 *    P3-7 修复的 finishReason 变化触发回调依赖该字段等价保持（§三.2.2 逐字段等价）；
 *    Responses 侧由终结事件推导（stop→completed 等）；普通增量 chunk 不携带） */
export interface AdapterChunk {
  type: 'content' | 'reasoning'; // 增量归类仅两类（契约承诺 R1；summary 归入 reasoning）
  delta: string;
  cumulative: string;
  end?: 'segment' | 'message'; // S1/S2（segment）与 S3（message）承载
  finishReason?: string | null;
}

/** 完整工具调用（宿主统一格式，字段对齐现状 StreamToolCall，openai-client.ts L102-109；
 *  Responses 侧 call_id 由适配器恒等映射为本字段 id） */
export interface AdapterToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** tool message（宿主统一格式 = 现状 role:'tool' 消息形态；Responses 侧由适配器在
 *  下一次 sendMessage 翻译时转换为 function_call_output item） */
export interface AdapterToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

/** 终结三情形（对齐 Responses 终结事件全集与 CC finish_reason 语义并集） */
export interface AdapterFinished {
  status: 'completed' | 'failed' | 'incomplete';
  incompleteReason?: 'max_output_tokens' | 'max_messages' | 'content_filter' | 'steered';
  error?: { code?: string; message: string };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cachedTokens?: number;
  };
  assistantMessage?: Record<string, unknown>; // 本轮宿主统一格式 assistant 消息（原封回传载体，§三.2.3）
  finishReason?: string | null; // CC 侧原始 finish_reason（兼容视图；G5 实测独立 chunk 携带）
  model?: string;
}

/** insert_message 受理结果（守卫语义对齐 executor-task-record-store.ts L546-554 既有三拒收） */
export type AdapterInsertResult =
  | { accepted: true; queuedCount: number }
  | { accepted: false; reason: 'terminal' | 'stop-requested' | 'queue-full' | 'invalid' };

/** 单轮生成结果（sendMessage 的 resolve 值；形态对齐现状 StreamChatResult，
 *  openai-client.ts L111-124——保证宿主 await 后的既有后处理代码零改动可用；
 *  finishReason/model 为顶层冗余视图（等价承载现状消费字段） */
export interface AdapterTurnResult {
  content: string; // 本轮完整文本
  reasoning: string; // 本轮完整推理文本（无推理恒为 ''，不兜底）
  toolCalls: AdapterToolCall[]; // 本轮完整工具调用集合
  finished: AdapterFinished; // 终结三情形
  assistantMessage?: Record<string, unknown>; // 宿主统一格式 assistant 消息
  finishReason?: string | null; // 顶层冗余视图（finished.finishReason 同值）
  model?: string; // 顶层冗余视图（finished.model 同值）
}

/** init 注入配置 */
export interface AdapterInitConfig {
  api: AdapterApiConfig;
  /** 档位双形态（对齐 tools 双形态，P7 live-binding 同源纪律）：
   *  - string：静态档位（缺省兜底语义）
   *  - () => string：惰性 getter（宿主传 () => configManager.getSettings().xxxThinkingLevel，
   *    每次 sendMessage 组装思考参数时实时 resolve——与现状每轮读取档位语义完全一致，
   *    禁 init 快照缓存，禁止清单⑨） */
  thinkingLevel: AdapterThinkingLevel | (() => AdapterThinkingLevel);
  systemMessage: string;
  /** 实例级工具定义，双形态（live-binding 修正，P7 禁快照）：
   *  - Array：静态数组（executor 每任务局部构建的 delegatedExecutorTools，executor-agent.ts L1285-1287）
   *  - () => Array：惰性 getter（主智能体 MAIN_TOOLS live-binding；每次 sendMessage 时 resolve，
   *    与现状 main-agent.ts L700 每请求读取 live-binding 语义一致，禁快照） */
  tools?: Array<Record<string, unknown>> | (() => Array<Record<string, unknown>>);
  /** 可选横切回调（非第八成员）：重试复位协议（红线 R7）的承载通道 */
  hooks?: { onStreamRetry?: () => void };
}

/** init 成败结果（成败化契约，目标一）：参数校验失败与协议探查失败统一以
 *  {success:false, message:原因} 表达——不再依赖 throw 表达常规初始化失败 */
export interface AdapterInitResult {
  success: boolean;
  message?: string;
}

/** 排队消息条目（insert 队列 FIFO 元素） */
export interface AdapterPendingMessage {
  role: 'user';
  content: string;
}

/** 排队上限（对齐 executor-task-record-store.ts L68 EXECUTOR_TASK_MESSAGE_MAX_PENDING） */
export const ADAPTER_INSERT_QUEUE_MAX_PENDING = 10;

/** 协议探查超时（目标二：短超时秒级、单次探查、无重试——仅以 URL 为依据判定协议存在性） */
const ADAPTER_PROTOCOL_PROBE_TIMEOUT_MS = 5_000;

// ============================================================
// 抽象适配器类：七成员契约 + 排队基座
// ============================================================

export abstract class ProtocolAdapter {
  // ---------------- 实例状态（配置快照 + 排队边界） ----------------
  protected adapterId: string | null = null;
  protected apiConfig: AdapterApiConfig | null = null;
  protected thinkingLevel: AdapterThinkingLevel | (() => AdapterThinkingLevel) = '';
  /** 档位兜底值：init 注入的静态 string（getter 形态时为 ''，仅作缺省兜底语义） */
  protected thinkingLevelFallback: AdapterThinkingLevel = '';
  protected systemMessage = '';
  protected toolsInput: AdapterInitConfig['tools'] = undefined;
  protected hooksRef: AdapterInitConfig['hooks'] = undefined;
  protected initialized = false;
  protected closed = false;
  /** 终结标志（close 或任一轮 sendMessage 终结后置位；insert 拒收 terminal 判据） */
  protected terminal = false;
  /** 停止请求标志（宿主可提前置位冻结入队；对齐 record freezeForStop L538-543 语义） */
  protected stopRequested = false;

  // ---------------- insert 排队基座（FIFO + 四拒收） ----------------
  protected pendingMessages: AdapterPendingMessage[] = [];

  /** ① 初始化：注入大模型 API 配置 + 思考程度 + system message（参数级扩展：
   *  hooks.onStreamRetry（重试复位承载）与 tools（实例工具集））。
   *  成败化契约（目标一，含网络 I/O 故异步化）：返回 Promise<AdapterInitResult>——
   *  常规初始化失败（二次 init / 参数校验失败）不再 throw，统一以 {success:false,
   *  message} 表达；基类默认实现保留参数校验与配置快照职责，不含协议探查
   *  （协议探查由子类 init 在基类成功后追加，目标二）。 */
  async init(config: AdapterInitConfig): Promise<AdapterInitResult> {
    if (this.initialized) {
      return { success: false, message: 'adapter already initialized（实例即配置快照，禁止二次 init）' };
    }
    if (!config || !config.api || typeof config.api.baseUrl !== 'string'
      || typeof config.api.apiKey !== 'string' || typeof config.api.model !== 'string') {
      return { success: false, message: 'adapter init 参数缺失或类型非法（api 三键必需）' };
    }
    if (typeof config.thinkingLevel !== 'string' && typeof config.thinkingLevel !== 'function') {
      return { success: false, message: 'adapter init thinkingLevel 类型非法（string | () => string）' };
    }
    if (typeof config.systemMessage !== 'string') {
      return { success: false, message: 'adapter init systemMessage 类型非法（string 必需）' };
    }
    if (config.tools !== undefined
      && !Array.isArray(config.tools) && typeof config.tools !== 'function') {
      return { success: false, message: 'adapter init tools 类型非法（Array | () => Array）' };
    }
    this.adapterId = `adapter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.apiConfig = { ...config.api };
    this.thinkingLevel = config.thinkingLevel;
    this.thinkingLevelFallback = typeof config.thinkingLevel === 'string' ? config.thinkingLevel : '';
    this.systemMessage = config.systemMessage;
    this.toolsInput = config.tools;
    this.hooksRef = config.hooks;
    this.initialized = true;
    return { success: true };
  }

  /** ② 关闭并释放资源（幂等；切换模型配置 = 旧实例随轮次/任务结束自然 close + 新实例下轮 init） */
  close(): void {
    if (this.closed) {
      return; // 幂等不抛错
    }
    this.closed = true;
    this.terminal = true;
    // 排队残留：上报宿主（未送达清单）后清空（对齐 L493-502 终态清扫既有语义，不静默丢弃）
    // eslint-disable-next-line no-console
    if (this.pendingMessages.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[adapter:${this.constructor.name}] close 时仍有 ${this.pendingMessages.length} 条未送达排队消息（已随实例清算丢弃）`,
      );
    }
    this.pendingMessages.length = 0;
    this.releaseResources();
  }

  /** 子类资源释放钩子（close 时调用一次；协议层幂等空操作默认） */
  protected releaseResources(): void {
    // 默认无协议级资源（per-call 创建客户端，openai-client.ts L145-151）
  }

  /** ③ 发送消息：传 messages（宿主统一格式全量数组）+ 多模态协议标志位，发起一轮生成 */
  abstract sendMessage(
    messages: Array<Record<string, unknown>>,
    opts: { multimodal: boolean; signal?: AbortSignal },
  ): Promise<AdapterTurnResult>;

  /** ④ 生成进行中插入消息：入队排队（与 sendMessage 职责区分；同步方法非 Promise） */
  insertMessage(message: { role: 'user'; content: string }): AdapterInsertResult {
    if (typeof message?.content !== 'string' || !message.content.trim()) {
      return { accepted: false, reason: 'invalid' };
    }
    if (this.terminal || this.closed) {
      return { accepted: false, reason: 'terminal' };
    }
    if (this.stopRequested) {
      return { accepted: false, reason: 'stop-requested' };
    }
    if (this.pendingMessages.length >= ADAPTER_INSERT_QUEUE_MAX_PENDING) {
      return { accepted: false, reason: 'queue-full' };
    }
    this.pendingMessages.push({ role: 'user', content: message.content });
    return { accepted: true, queuedCount: this.pendingMessages.length };
  }

  /** 停止请求冻结（对齐 record freezeForStop：置位后 insert 全拒收） */
  requestStop(): void {
    this.stopRequested = true;
  }

  /**
   * 排水：同步（无 await）排空 insert 队列，FIFO 追加到宿主数组尾部。
   * 由 sendMessage 在构建协议请求体之前调用（§5.4 硬约束：纯同步代码，
   * shift 队列 + 数组 push，不含任何 I/O / Promise 等待 / 事件循环让出）。
   */
  protected drainPendingMessages(messages: Array<Record<string, unknown>>): number {
    let drained = 0;
    while (this.pendingMessages.length > 0) {
      const item = this.pendingMessages.shift()!;
      messages.push({ role: 'user', content: item.content });
      drained += 1;
    }
    return drained;
  }

  /** ⑤ chunk 回调注册：content 类型或 reasoning 类型（不兜底：有值传没值空；end 可选终结枚举） */
  abstract onChunk(handler: (chunk: AdapterChunk) => void): void;

  /** ⑥ tool_call 事件回调注册：接收工具调用，同时返回 tool message（双模式，默认通知模式） */
  abstract onToolCall(
    handler: (toolCall: AdapterToolCall) => AdapterToolMessage | undefined,
  ): void;

  /** ⑦ 生成彻底结束回调注册（轮级权威终结，三情形；恒发生，含失败/截断轮） */
  abstract onFinished(handler: (finished: AdapterFinished) => void): void;

  // ---------------- 基座共享工具 ----------------

  /** 档位双形态 resolve（每次 sendMessage 组装思考参数时求值；禁缓存——禁止清单⑨） */
  protected resolveThinkingLevel(): AdapterThinkingLevel {
    return typeof this.thinkingLevel === 'function' ? this.thinkingLevel() : this.thinkingLevel;
  }

  /** tools 双形态 resolve（每次调用求值；禁跨 sendMessage 缓存——P7 live-binding） */
  protected resolveTools(): Array<Record<string, unknown>> | undefined {
    if (this.toolsInput === undefined) {
      return undefined;
    }
    if (Array.isArray(this.toolsInput)) {
      return this.toolsInput.length ? this.toolsInput : undefined;
    }
    const resolved = this.toolsInput();
    return Array.isArray(resolved) && resolved.length ? resolved : undefined;
  }

  /** 操作成员守卫：未 init / 已 close 抛错 */
  protected assertUsable(operation: string): void {
    if (this.closed) {
      throw new Error(`adapter closed（close 后任何操作成员 → terminal 错误；操作=${operation}）`);
    }
    if (!this.initialized) {
      throw new Error(`adapter not initialized（操作=${operation}）`);
    }
  }

  /** 协议探查（目标二，由子类 init 在基类校验/快照成功后追加调用）：仅以 URL 为依据
   *  POST 探查端点，单次、无重试、短超时秒级（参照 responses-adapter.ts 既有 fetch
   *  形态，不触碰 openai-client.ts）。判定映射：HTTP 404 = 协议不存在 = 初始化失败
   *  （success:false，message 携带端点与 404 事实）；收到任何其他 HTTP 状态响应（含
   *  400/401/403/405）= 协议存在 = 探查通过；网络层失败/超时 = 探查未通过
   *  （success:false 记录原因）。探查请求体仅携带标记键（无凭据、无对话数据）。 */
  protected async probeProtocolEndpoint(endpointPath: string): Promise<AdapterInitResult> {
    const baseUrl = typeof this.apiConfig?.baseUrl === 'string' ? this.apiConfig.baseUrl : '';
    const trimmedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const probeUrl = `${trimmedBaseUrl}${endpointPath}`;
    const controller = new AbortController();
    const timeoutTimer = setTimeout(
      () => controller.abort(new DOMException('timeout', 'TimeoutError')),
      ADAPTER_PROTOCOL_PROBE_TIMEOUT_MS,
    );
    try {
      const res = await fetch(probeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.apiConfig?.apiKey ?? ''}`,
        },
        body: JSON.stringify({ delepi_protocol_probe: true }),
        signal: controller.signal,
      });
      if (res.body) {
        await res.body.cancel().catch(() => undefined); // 探查只看状态码，响应体即弃
      }
      if (res.status === 404) {
        return { success: false, message: `协议探查失败：POST ${probeUrl} 返回 HTTP 404（端点不存在，协议不支持）` };
      }
      return { success: true };
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return { success: false, message: `协议探查失败：POST ${probeUrl} 网络层失败/超时（${reason}）` };
    } finally {
      clearTimeout(timeoutTimer);
    }
  }
}
