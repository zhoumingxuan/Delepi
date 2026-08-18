/**
 * 运行时 assistant 消息构建器
 * 用于 ExecutorAgent 工具调用循环中构建 assistant 消息
 * 100%复用自参考项目 E:\ai_fr
 */

import type OpenAI from 'openai';

export interface RuntimeAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[];
  reasoning_content?: string;
}

type RuntimeToolCallInput = {
  id: string;
  type?: string;
  function: {
    name: string;
    arguments: string;
  };
};

export function buildRuntimeAssistantMessage(options: {
  content?: string | null;
  reasoning?: string;
  toolCalls?: RuntimeToolCallInput[];
}): RuntimeAssistantMessage {
  const runtimeToolCalls = (options.toolCalls ?? []).map((toolCall) => ({
    id: toolCall.id,
    type: 'function' as const,
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  } satisfies OpenAI.Chat.ChatCompletionMessageToolCall));

  return {
    role: 'assistant',
    content: options.content
      ? options.content
      : runtimeToolCalls.length
        ? null
        : '',
    tool_calls: runtimeToolCalls.length ? runtimeToolCalls : undefined,
    reasoning_content: options.reasoning ? options.reasoning : undefined,
  };
}
