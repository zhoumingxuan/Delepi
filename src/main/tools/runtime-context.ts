/**
 * 工具运行时上下文
 * 仅包含工具执行所需的会话标识。其他字段（signal/emit/rootDir/finalOutputDir/visionModelConfig）
 * 已从 ToolRuntimeContext 中移除：signal 由 main-agent/executor-agent 层通过独立 signal 链路透传，
 * 事件统一走 eventBus.emit，视觉模型配置由 inspect-image 直接从 configManager 读取。
 */

export interface ToolRuntimeContext {
  /** 对话 ID */
  conversationId?: string;
  /** 工具默认运行目录；run_dir 未传时使用 */
  runDir?: string;
  /** 中止信号；由上层通过独立 signal 链路传入 */
  signal?: AbortSignal;
}

export function normalizeOptionalString(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text ? text : undefined;
}
