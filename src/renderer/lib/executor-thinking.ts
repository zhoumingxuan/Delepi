/**
 * 子智能体（ExecutorAgent）工具进度模式识别
 * Phase 3 P0-2 适配层：从 ChatMessageContent 提取为公共模块
 * 对齐 E:\ai_fr\components\chat-message-content.tsx L41-45 + L200-228
 *
 * 切分策略：value.split(/\n+/)（按单换行或多换行切分），最后用 \n 连接
 * 任务验收用例：
 *   输入 "思考内容1\n正在调用read_file工具...\n思考内容2\nread_file工具完成，继续处理..."
 *   → thinking = "思考内容1\n思考内容2"
 *   → progress = "正在调用read_file工具...\nread_file工具完成，继续处理..."
 *
 * 用法：
 * - ToolCallCard 加载中：拆分 result 字段为 thinking / progress 两段
 * - ChatMessageContent：拆分 message.thinking 字段为 thinking / progress 两段
 */

import { EXECUTOR_TOOL_PROGRESS_PATTERNS, isExecutorToolProgressText } from '@shared/utils/executor-patterns';

/**
 * 拆分加载中工具内容为思考 / 进度两段
 * @param value 累积的 thinking 文本（多行以 \n 或 \n\n 分隔）
 * @returns { thinking, progress } 两段文本
 */
export function splitLoadingToolContent(value: string): {
  thinking: string;
  progress: string;
} {
  if (!value) {
    return { thinking: '', progress: '' };
  }
  const chunks = value
    .split(/\n+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const thinkingChunks: string[] = [];
  const progressChunks: string[] = [];
  for (const chunk of chunks) {
    if (isExecutorToolProgressText(chunk)) {
      progressChunks.push(chunk);
    } else {
      thinkingChunks.push(chunk);
    }
  }
  return {
    thinking: thinkingChunks.join('\n'),
    progress: progressChunks.join('\n'),
  };
}
/**
 * 取工具进度段最后一条非空进度行（显示用：仅最新一条，不累积）
 * @param value 累积的 thinking 文本（多行以 \n 或 \n\n 分隔）
 * @returns 最后一条非空进度行；无进度行时返回 ''
 */
export function latestToolProgressText(value: string): string {
  const { progress } = splitLoadingToolContent(value);
  const lines = progress.split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}
