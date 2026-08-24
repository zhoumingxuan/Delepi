/**
 * LLMProvider - OpenAI 兼容客户端
 *
 * 服务于 MainAgent（流式 streamChat）和所有非流式调用方（nonStreamChat）
 * 包括 ExecutorAgent、title-generation、context-compression、inspect-image
 * 封装 OpenAI 兼容 SDK，集成重试策略和 SSE 解析。
 *
 * 设计原则（v1.2）：
 * - LLMProvider 对两个 Agent 对称，不区分主从
 * - 不感知调用方身份（无 Agent 概念）
 * - 不持久化业务状态，只返回结果
 * - 消息构建由调用方（MainAgent/ExecutorAgent）负责
 */

import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { runModelApiWithRetry } from './model-retry';

// ============================================================
// 类型定义
// ============================================================

export interface ModelConfig {
  /** API Base URL */
  baseUrl: string;
  /** API Key */
  apiKey: string;
  /** 模型名称 */
  model: string;
}

export interface StreamChatOptions {
  /** 模型配置 */
  modelConfig: ModelConfig;
  /** 消息列表 */
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  /** 工具定义 */
  tools?: OpenAI.Chat.ChatCompletionTool[];
  /** 中止信号 */
  signal?: AbortSignal;
  /** 流式快照回调（每个 chunk 触发） */
  onChunk?: (chunk: StreamChunk) => void;
  /** 思考内容回调 */
  onThinking?: (thinking: string) => void;
  /**
   * 思考意图（S1-1 方向1流式化新增，可选）：
   * - 不传（undefined）：零思考参数（主智能体——请求体不组装任何思考键，行为与改造前逐字节一致）
   * - { reasoningEffort: 'low' | 'high' | 'max' }：执行子智能体（档位读 AppSettings.executorThinkingLevel）
   * 翻译收口与 nonStreamChatOnce 一致：buildThinkingParams（intent 未传时返回空对象，展开后请求体零思考键）
   */
  thinking?: ThinkingIntent;
  /**
   * ★ M12 重试回调重置协议（可选）：底层 runModelApiWithRetry 即将重放 streamChatOnce 前触发
   *   （retryCount += 1 之后、sleepBeforeRetry 之前），消费者据此复位已累积的增量态
   */
  onStreamRetry?: () => void;
}

/**
 * 调用点思考意图（唯一思考意图通道；子智能体档位已配置化，其余调用点按机制基准硬编码）：
 * - 不传（undefined）：零思考参数（主智能体——请求不携带任何思考键）
 * - { reasoningEffort: 'low' | 'high' | 'max' }：子智能体（档位读 AppSettings.executorThinkingLevel，默认 'max'）；{ reasoningEffort: 'low' }：标题生成
 * - { enableThinking: true, reasoningEffort: 'low' }：上下文压缩·glm*（glm 判定在调用点）
 * - { enableThinking: false }：上下文压缩·非 glm*、图片识别
 * 翻译收口：本文件 buildThinkingParams（enableThinking→enable_thinking，reasoningEffort→reasoning_effort）
 */
export type ThinkingIntent =
  | { reasoningEffort: 'low' | 'high' | 'max' }
  | { enableThinking: true; reasoningEffort: 'low' }
  | { enableThinking: false; reasoningEffort?: never };

export interface NonStreamChatOptions {
  /** 模型配置 */
  modelConfig: ModelConfig;
  /** 消息列表 */
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  /** 工具定义 */
  tools?: OpenAI.Chat.ChatCompletionTool[];
  /** 中止信号 */
  signal?: AbortSignal;
  /** 思考意图（不传=零思考参数；子智能体档位读配置，其余调用点按机制基准硬编码） */
  thinking?: ThinkingIntent;
}

export interface StreamChunk {
  /** 累积文本内容 */
  content: string;
  /** 本次增量 */
  delta: string;
  /** 累积推理内容 */
  reasoning: string;
  /** 推理增量 */
  reasoningDelta: string;
  /** 工具调用列表（流式累积） */
  toolCalls: StreamToolCall[];
  /** 结束原因 */
  finishReason: string | null;
  /** 模型名称 */
  model: string;
}

export interface StreamToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface StreamChatResult {
  /** 完整文本内容 */
  content: string;
  /** 推理内容 */
  reasoning: string;
  /** 工具调用列表 */
  toolCalls: StreamToolCall[];
  /** 结束原因 */
  finishReason: string | null;
  /** 模型名称 */
  model: string;
  /** 原始 assistant 消息（用于消息历史） */
  assistantMessage: OpenAI.Chat.ChatCompletionMessage;
}

export interface NonStreamChatResult {
  /** 文本内容 */
  content: string;
  /** 推理内容 */
  reasoning: string;
  /** 工具调用列表 */
  toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[];
  /** 结束原因 */
  finishReason: string | null;
  /** 模型名称 */
  model: string;
  /** 原始 assistant 消息 */
  assistantMessage: OpenAI.Chat.ChatCompletionMessage;
}

// ============================================================
// 内部工具函数
// ============================================================

function getOpenAIClient(modelConfig: ModelConfig): OpenAI {
  return new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseUrl,
    timeout: 600_000,
  });
}

/**
 * 思考意图 → 请求思考参数的统一翻译器（唯一收口，不感知模型名）。
 * 输出仅可能包含 enable_thinking / reasoning_effort；intent 未传时输出空对象（请求零思考键）。
 */
function buildThinkingParams(intent?: ThinkingIntent): {
  enable_thinking?: boolean;
  reasoning_effort?: 'low' | 'high' | 'max';
} {
  const params: {
    enable_thinking?: boolean;
    reasoning_effort?: 'low' | 'high' | 'max';
  } = {};

  if (!intent) {
    return params;
  }

  if ('enableThinking' in intent) {
    params.enable_thinking = intent.enableThinking;
  }

  if ('reasoningEffort' in intent) {
    params.reasoning_effort = intent.reasoningEffort;
  }

  return params;
}

function extractTextDelta(input: unknown): string {
  if (!input) {
    return '';
  }
  if (typeof input === 'string') {
    return input;
  }
  if (Array.isArray(input)) {
    return input
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          if ('text' in item && typeof item.text === 'string') return item.text;
          if ('delta' in item && typeof item.delta === 'string') return item.delta;
        }
        return '';
      })
      .join('');
  }
  if (typeof input === 'object' && input !== null) {
    if ('text' in input && typeof input.text === 'string') return input.text;
    if ('content' in input && typeof input.content === 'string') return input.content;
  }
  return '';
}

function extractReasoningDelta(delta: Record<string, unknown>): string {
  if ('reasoning_content' in delta) {
    return extractTextDelta(delta.reasoning_content);
  }
  if ('reasoning' in delta) {
    return extractTextDelta(delta.reasoning);
  }
  return '';
}

// ============================================================
// 流式调用（MainAgent 使用）
// ============================================================

async function streamChatOnce(options: StreamChatOptions): Promise<StreamChatResult> {
  const openai = getOpenAIClient(options.modelConfig);

  const requestBody = {
    model: options.modelConfig.model,
    stream: true as const,
    messages: options.messages,
    tools: options.tools?.length ? options.tools : undefined,
    // 思考参数由调用点意图决定（S1-1）：未传 thinking 时不组装任何思考键（buildThinkingParams
    // 对 undefined 返回空对象，展开后请求体与改造前逐字节一致——主智能体既有调用零回归）；
    // 传 thinking 时经统一翻译收口展开 enable_thinking / reasoning_effort（与 nonStreamChatOnce 同构）
    ...buildThinkingParams(options.thinking),
    parallel_tool_calls: true,
    reasoning_split: true,
  };

  const stream = await openai.chat.completions.create(requestBody, {
    signal: options.signal,
  });

  let content = '';
  let reasoning = '';
  const toolCalls: StreamToolCall[] = [];
  let finishReason: string | null = null;
  let lastEmittedFinishReason: string | null = null;  // ★ Phase 3 P3-7 跟踪上次推送的 finishReason,仅在新值时触发 onChunk
  let lastPacketModel = options.modelConfig.model;

  for await (const packet of stream) {
    const packetModel =
      typeof packet.model === 'string'
        ? packet.model
        : lastPacketModel;
    lastPacketModel = packetModel;

    const choices = Array.isArray(packet.choices) ? packet.choices : [];

    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') {
        continue;
      }

      const delta =
        'delta' in choice && choice.delta && typeof choice.delta === 'object'
          ? (choice.delta as Record<string, unknown>)
          : {};

      let changed = false;

      // 文本增量
      const contentDelta = 'content' in delta
        ? extractTextDelta(delta.content)
        : '';
      if (contentDelta) {
        content += contentDelta;
        changed = true;
      }

      // 推理增量
      const reasoningDelta = extractReasoningDelta(delta);
      if (reasoningDelta) {
        reasoning += reasoningDelta;
        changed = true;
      }

      // 工具调用增量
      const toolCallDelta = 'tool_calls' in delta
        ? (delta.tool_calls as Array<Record<string, unknown>>)
        : [];

      if (Array.isArray(toolCallDelta)) {
        for (const chunk of toolCallDelta) {
          if (!chunk || typeof chunk !== 'object') {
            continue;
          }

          // ★ M20 tool_calls 碎片合并加固·三级索引解析：
          //   显式 index > 按 chunk.id 匹配既有条目 > 追加新条目
          //   （修复无 index 的同 id 续片以 toolCalls.length 为下标被拆成多条独立 tool_call）
          let index =
            'index' in chunk && typeof chunk.index === 'number'
              ? chunk.index
              : -1;
          if (index < 0 && typeof chunk.id === 'string' && chunk.id) {
            index = toolCalls.findIndex((toolCallEntry) => toolCallEntry.id === chunk.id);
          }
          if (index < 0) {
            index = toolCalls.length;
          }

          const current: StreamToolCall = toolCalls[index] ?? {
            id: randomUUID(),
            type: 'function',
            function: {
              name: '',
              arguments: '',
            },
          };

          if ('id' in chunk && typeof chunk.id === 'string' && chunk.id) {
            current.id = chunk.id;
          }
          if ('type' in chunk && chunk.type === 'function') {
            current.type = 'function';
          }
          if ('function' in chunk && chunk.function && typeof chunk.function === 'object') {
            const fn = chunk.function as Record<string, unknown>;
            if ('name' in fn && typeof fn.name === 'string') {
              current.function.name = fn.name;
            }
            if ('arguments' in fn && typeof fn.arguments === 'string') {
              current.function.arguments += fn.arguments;
            }
          }

          toolCalls[index] = current;
          changed = true;
        }
      }

      if ('finish_reason' in choice && typeof choice.finish_reason === 'string') {
        finishReason = choice.finish_reason;
      }

      // ★ Phase 3 P3-7 修复：finishReason 变化时也要触发 onChunk 回调
      //   原实现：仅当 changed=true(文本/推理/工具增量)时触发,finishReason 单独变化时丢失推送
      //   影响：main-agent 无法通过 onChunk 收到 finishReason,需依赖 streamResult.finishReason 间接获取
      //   修复：finishReason 从 lastEmittedFinishReason 变化时也触发回调,确保 finishReason 状态对前端可达
      const finishReasonChanged = finishReason !== lastEmittedFinishReason;

      // 触发回调
      if (changed || finishReasonChanged) {
        const lastContentDelta = contentDelta;
        const lastReasoningDelta = reasoningDelta;

        options.onChunk?.({
          content,
          delta: lastContentDelta,
          reasoning,
          reasoningDelta: lastReasoningDelta,
          toolCalls: toolCalls.map(tc => ({ ...tc })),
          finishReason,
          model: packetModel,
        });

        // 推理回调
        if (lastReasoningDelta) {
          options.onThinking?.(lastReasoningDelta);
        }

        // ★ Phase 3 P3-7 更新上次推送的 finishReason
        lastEmittedFinishReason = finishReason;
      }
    }
  }

  // 构建 assistant message
  const hasToolCalls = toolCalls.length > 0 && toolCalls.some(tc => tc.id);

  const assistantMessage = {
    role: 'assistant' as const,
    content: hasToolCalls ? null : content,
    tool_calls: hasToolCalls
      ? toolCalls
          .filter(tc => tc.id)
          .map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          }))
      : undefined,
    refusal: null,
  } satisfies OpenAI.Chat.ChatCompletionMessage;

  const sanitizedToolCalls = toolCalls.filter((tc) => tc.id && tc.id.length > 0);
  return {
    content,
    reasoning,
    toolCalls: sanitizedToolCalls,
    finishReason,
    model: lastPacketModel,
    assistantMessage,
  };
}

/**
 * 流式对话（MainAgent 使用）
 * 带重试策略的流式 API 调用
 */
export async function streamChat(
  options: StreamChatOptions,
): Promise<StreamChatResult> {
  return runModelApiWithRetry(() => streamChatOnce(options), {
    signal: options.signal,
    // ★ M12：重试边界回调接线（onRetry → onStreamRetry 透传给调用方）
    onRetry: () => options.onStreamRetry?.(),
  });
}

// ============================================================
// 非流式调用（ExecutorAgent、title-generation、context-compression、inspect-image 使用）
// ============================================================

async function nonStreamChatOnce(
  options: NonStreamChatOptions,
): Promise<NonStreamChatResult> {
  const openai = getOpenAIClient(options.modelConfig);

  const thinkingParams = buildThinkingParams(options.thinking);

  const requestBody = {
    model: options.modelConfig.model,
    stream: false,
    messages: options.messages,
    tools: options.tools?.length ? options.tools : undefined,
    ...thinkingParams,
    reasoning_split: true,
    parallel_tool_calls: true,
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
    enable_thinking?: boolean;
    reasoning_effort?: 'low' | 'high' | 'max';
    reasoning_split?: boolean;
  };

  const completion = await openai.chat.completions.create(requestBody, {
    signal: options.signal,
  });

  const choice = completion.choices[0];
  if (!choice) {
    throw new Error('模型未返回有效选择');
  }

  const message = choice.message;
  const content = typeof message.content === 'string' ? message.content : '';

  // 提取推理内容
  const messagePayload = message as unknown as Record<string, unknown>;
  const reasoning =
    typeof messagePayload.reasoning_content === 'string'
      ? messagePayload.reasoning_content
      : typeof messagePayload.reasoning === 'string'
        ? messagePayload.reasoning
        : '';

  const toolCalls = (message.tool_calls ?? []) as OpenAI.Chat.ChatCompletionMessageToolCall[];

  return {
    content,
    reasoning,
    toolCalls,
    finishReason: choice.finish_reason ?? null,
    model: completion.model,
    assistantMessage: message,
  };
}

/**
 * 非流式对话（ExecutorAgent、title-generation、context-compression、inspect-image 使用）
 * 带重试策略的非流式 API 调用
 */
export async function nonStreamChat(
  options: NonStreamChatOptions,
): Promise<NonStreamChatResult> {
  return runModelApiWithRetry(() => nonStreamChatOnce(options), {
    signal: options.signal,
  });
}
