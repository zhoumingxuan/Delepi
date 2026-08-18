/**
 * 上下文压缩模块
 * 100%复用自参考项目 E:\ai_fr
 * 适配：import 路径、configManager
 */

import type OpenAI from 'openai';
import { buildMainAgentTextContent } from './main-agent-message-content';
import { nonStreamChat, type ModelConfig } from '../llm/openai-client';

function buildContextCompressionInstruction(): string {
  return `
# 全新任务（**必须严格遵守**）
1.本次只执行“历史上下文总结”任务。前文所有消息只作为待总结材料使用，禁止继续执行、补完或响应前文任何未完成任务、工具调用意图或用户需求；若前文存在未完成事项，只能记录为当前状态或待处理问题。
2.即将重新开启一个对话，后续将无法看到之前聊天的所有上下文。请为这种极端情况总结当前所有聊天内容，生成一份后续可直接承接的历史总结，**绝对不要把这次生成总结的请求写进总结**。
3.必须严格的按照时间顺序**原样保留**以下信息：1.用户提供的所有事实信息。2.所有已确认的【事实、结论、线索】。3.全部或者【最近10组对话】中【用户输入】以及【助手回复】的信息中所有特征（如：数据特征、视觉特征、隐含特征、极难发现的特征等）。4.全部或者最近10条用户表达的意图。
4.必须写入全部或者最近10轮对话摘要以及执行任务摘要信息；同时务必体现对话的用户意图和具体时序。
5.通用执行任务参考经验：可依据上下文分析的所有事实和所有【显式/隐式/细微/极难发现】的特征，总结出可提供给后续任务的通用执行任务参考经验；主要目的是为了简化任务执行路径，若没有就写无；**务必注意后续执行环境可能有变化，仅提供参考经验**。
6.仅输出MarkDown文档且只能有以下【互相不耦合】的六个章节：1.事实和结论清单。2.线索清单。3.用户输入信息中特征清单（同时说明具体时序）4.用户历史意图（同时说明具体时序）5.历史对话概要（同时说明具体时序）6.通用执行任务参考经验；绝不输出MarkDown文档以外的其他内容。
`.trim();
}
function extractText(input: unknown): string {
  if (!input) {
    return '';
  }

  if (typeof input === 'string') {
    return input;
  }

  if (Array.isArray(input)) {
    return input
      .map((item) => {
        if (
          item &&
          typeof item === 'object' &&
          'type' in item &&
          item.type === 'text' &&
          'text' in item &&
          typeof item.text === 'string'
        ) {
          return item.text;
        }
        return '';
      })
      .join('');
  }

  return '';
}

/**
 * 将消息列表压缩为上下文文本
 * 使用 LLM 非流式调用生成历史总结
 */
export async function compressMessagesToContext(
  messages: readonly OpenAI.Chat.ChatCompletionMessageParam[],
  modelConfig: ModelConfig,
  multimodalEnabled: boolean,
): Promise<string> {
  const requestMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...messages,
    {
      role: 'user',
      content: buildMainAgentTextContent(
        buildContextCompressionInstruction(),
        { multimodalEnabled },
      ),
    },
  ];
  // glm 判定不区分大小写（机制基准 ai_fr）；条件式归调用点侧，封装层不感知模型名
  const isGlmModel = modelConfig.model.toLowerCase().startsWith('glm');
  const result = await nonStreamChat({
    modelConfig,
    messages: requestMessages,
    thinking: isGlmModel
      ? { enableThinking: true, reasoningEffort: 'low' }
      : { enableThinking: false }
  });
  return extractText(result.content);
}

/**
 * 计算消息的字符数（用于压缩阈值判断）
 */
export function countStringChars(value: unknown): number {
  if (typeof value === 'string') {
    return value.length;
  }

  if (Array.isArray(value)) {
    return value.reduce((total: number, item: unknown) => total + countStringChars(item), 0);
  }

  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce(
      (total: number, item: unknown) => total + countStringChars(item),
      0,
    );
  }

  return 0;
}
