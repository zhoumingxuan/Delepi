/**
 * 工具运行时上下文
 * 工具运行时上下文：会话标识 + run 级快照载荷。不包含 signal/emit/rootDir/finalOutputDir——
 * signal 由 main-agent/executor-agent 层通过独立 signal 链路透传，事件统一走 eventBus.emit。
 * run 级快照载荷：visionModelConfig/visionEnabled 由 main-agent → runDelegatedTask 经 toolContext
 * 从本次 run 快照透传（inspect_media 与执行层拦截消费）——工具体运行期一律优先读
 * 快照，缺省回落全局仅限诊断直调等无 run 上下文场景；watchCommandContext 为值守注入链路
 * （conversation-send-service → runMainAgent → send_email 分支）随 run 传递的 run 私有指令上下文，
 * 本地 chat:send 恒缺省。
 */
import type { TaskJobList } from './task-job-list';
import type { ModelConfig } from '../modules/llm/openai-client';
import type { WatchCommandContext } from '../modules/watch/watch-runtime-flag';

export interface ToolRuntimeContext {
  /** 对话 ID */
  conversationId?: string;
  /** 工具默认运行目录；run_dir 未传时使用 */
  runDir?: string;
  /** 任务级进程台账（可选）；由 runDelegatedTask 注入，工具侧经 context?.jobList 读取 */
  jobList?: TaskJobList;
  /** 中止信号；由上层通过独立 signal 链路传入 */
  signal?: AbortSignal;
  /** 视觉模型三键 run 快照；由 runDelegatedTask 经 toolContext 从 runMainAgent options 透传 */
  visionModelConfig?: ModelConfig;
  /** 视觉识别总开关 run 快照（=RuntimeSettingsSnapshot.visionEnabled）；inspect_media 执行层拦截消费 */
  visionEnabled?: boolean;
  /** 值守指令上下文（run 实例私有对象）；值守注入链路随 run 传入 send_email 执行体，
   * 本地 chat:send 路径恒为 undefined（无指令上下文，In-Reply-To 不补全，行为不变） */
  watchCommandContext?: WatchCommandContext;
}

export function normalizeOptionalString(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text ? text : undefined;
}
