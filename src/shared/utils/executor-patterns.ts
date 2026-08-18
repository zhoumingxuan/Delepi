/**
 * 跨进程共享的执行子智能体工具进度模式
 * 主进程和渲染进程均从此文件导入
 *
 * 包含：
 * - EXECUTOR_TOOL_PROGRESS_PATTERNS: 工具进度正则模式
 * - isExecutorToolProgressText: 判断文本是否为工具进度文本
 */

/**
 * 执行子智能体工具进度模式正则
 * 识别 LLM 在工具调用前/后输出的进度提示
 * 顺序：调用中 / 完成 / 错误
 */
export const EXECUTOR_TOOL_PROGRESS_PATTERNS: RegExp[] = [
  /^正在调用.+工具\.\.\.$/,
  /^.+工具完成，继续处理\.\.\.$/,
  /^.+工具返回错误，正在调整处理方式\.\.\.$/,
];

/**
 * 判断文本是否匹配工具进度模式
 * @param value 待判断的文本片段
 * @returns 是否为工具进度文本
 */
export function isExecutorToolProgressText(value: string): boolean {
  if (!value) {
    return false;
  }
  return EXECUTOR_TOOL_PROGRESS_PATTERNS.some((pattern) => pattern.test(value));
}
