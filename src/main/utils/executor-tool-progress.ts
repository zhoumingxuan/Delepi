/**
 * 执行子智能体（ExecutorAgent）工具进度识别 + 切分 + 合并
 * 主进程端版本（对齐网站版 stream/route.ts L105-281）
 *
 * 用途：
 * - main-agent.ts 在持久化 intermediate_json 前先识别 type
 * - executor-agent.ts 工具调用前/后用 isExecutorToolProgressText 判断
 *
 * 注意：
 * - 渲染端已有 src/renderer/lib/executor-thinking.ts 实现同等切分逻辑
 * - 本文件与渲染端实现等价但独立维护（主进程不依赖 renderer）
 */

import { EXECUTOR_TOOL_PROGRESS_PATTERNS, isExecutorToolProgressText } from '@shared/utils/executor-patterns';
export { EXECUTOR_TOOL_PROGRESS_PATTERNS, isExecutorToolProgressText };

/**
 * 拆分累积的 executor intermediate 为 thinking / progress 段
 * 与网站版 route.ts L223-245 一致：按 \n{2,} 切分后逐段分类
 * @param value 累积的 executor intermediate 文本
 * @returns thinking 段数组 + progress 段数组
 */
export function splitExecutorIntermediate(value: string): {
  thinking: string[];
  progress: string[];
} {
  if (!value) {
    return { thinking: [], progress: [] };
  }
  const chunks = value
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const thinking: string[] = [];
  const progress: string[] = [];
  for (const chunk of chunks) {
    if (isExecutorToolProgressText(chunk)) {
      progress.push(chunk);
    } else {
      thinking.push(chunk);
    }
  }
  return { thinking, progress };
}

/**
 * 合并两段 executor intermediate（与网站版 route.ts L247-281 一致）
 * 取最新的 thinking 片段 + 最新的 progress 片段，\n\n 拼接
 * @param current 当前的 intermediate 文本
 * @param incoming 新到达的 intermediate 文本（可选）
 * @returns 合并后的 intermediate 文本
 */
export function mergeExecutorIntermediate(
  current: string,
  incoming?: string,
): string {
  const currentText = current.trim();
  const incomingText = incoming?.trim() ?? '';

  if (!currentText) {
    return incomingText;
  }

  if (!incomingText || currentText === incomingText) {
    return currentText;
  }

  const currentParts = splitExecutorIntermediate(currentText);
  const incomingParts = splitExecutorIntermediate(incomingText);
  const latestThinking =
    incomingParts.thinking[incomingParts.thinking.length - 1] ??
    currentParts.thinking[currentParts.thinking.length - 1] ??
    '';
  const latestProgress =
    incomingParts.progress[incomingParts.progress.length - 1] ??
    currentParts.progress[currentParts.progress.length - 1] ??
    '';

  return [latestThinking, latestProgress].join('\n\n');
}
