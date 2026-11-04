/**
 * 消息过滤辅助函数
 * 空泡过滤
 *
 * 目标行为：assistant 消息若 content.trim() === '' 且无 thinking / toolCalls，
 * 不应渲染为 bubble（避免空泡）。同时实现 filter 函数用于 messages 列表过滤。
 *
 * 
 *   filter((item) =>
 *     !(
 *       item.role === 'assistant' &&
 *       (item.payload as { finishReason?: string }).finishReason === 'tool_calls' &&
 *       contentPartsToText('content' in item.payload ? item.payload.content : []) === '\\n\\n' &&
 *       !(item.payload as { reasoning?: string }).reasoning?.trim()
 *     )
 *   )
 *
 * 本项目侧映射：
 * - finishReason='tool_calls' → message.toolCalls 存在且非空
 * - content='\\n\\n' → message.content.trim() === ''
 * - reasoning 空 → message.thinking 不存在或 trim() === ''
 *
 * 转换为：role === 'assistant' && content.trim() === '' &&
 *         (toolCalls 缺失或 toolCalls 为空) && (thinking 缺失或 thinking.trim() === '')
 * 注：tool_calls 缺失时是空泡的典型场景（流式结束但还没产生 toolCalls）
 */

import type { ChatMessage } from '../hooks/useChat';

/**
 * 判断 assistant 消息是否为"空泡"
 * 
 * @param message 待判断的消息
 * @returns 是否为空泡
 */
export function isEmptyAssistantBubble(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false;
  // 内容为空（含 '\n\n' 等纯空白）
  const hasContent = !!(message.content && message.content.trim().length > 0);
  if (hasContent) return false;
  // 工具调用非空时不视作空泡
  if (message.toolCalls && message.toolCalls.length > 0) return false;
  // 思考内容非空时不视作空泡
  if (message.thinking && message.thinking.trim().length > 0) return false;
  // 加载中的 assistant 消息不视作空泡（保留 spinner 占位）
  if (message.status === 'loading') return false;
  return true;
}



/**
 * AssistantMessageSegment 二元结构
 * 
 * - type='reasoning'：思考内容段，含 text 字段
 * - type='tool_call'：工具调用段，含 toolCallId 字段（索引 toolCalls 数组的 ToolCallInfo.callId）
 */
export type AssistantMessageSegment =
  | {
      id: string;
      type: 'reasoning';
      text: string;
    }
  | {
      id: string;
      type: 'tool_call';
      toolCallId: string;
    };
