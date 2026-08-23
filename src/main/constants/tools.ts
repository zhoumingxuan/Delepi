/**
 * 工具执行相关常量
 * 归集自 run-exe.ts、run-with-python.ts、inspect-image.ts
 */

// ============================================================
// 命令行执行
// ============================================================

/** 默认命令行执行超时（秒）。
 * 挂起模式豁免（方向6 S6-3/D6C8 落档）：run_exe 与 run_with_python 的 suspend=true 挂起模式均不设超时定时器，
 * timeout_seconds 语义=忽略，挂起进程生命周期由调用方管理（启动期 200ms 内秒退/abort 除外，A6-2）。 */
export const DEFAULT_TIMEOUT_SECONDS = 180;

/** 最大命令长度 */
export const MAX_COMMAND_LENGTH = 8000;

/** 最大输出长度 */
export const MAX_OUTPUT_LENGTH = 16 * 1024;

/** 模型返回无效工具调用时用于闭合 tool_call 消息链的占位工具名 */
export const EXECUTOR_INVALID_TOOL_CALL_NAME = '__invalid_tool_call__';

// ============================================================
// 图片处理
// ============================================================

/** 模型图片最大宽度 */
export const MAX_MODEL_IMAGE_WIDTH = 1920;

/** 模型图片最大高度 */
export const MAX_MODEL_IMAGE_HEIGHT = 1080;

/** 模型图片 JPEG 编码质量 */

/** 图片识别 LLM 调用温度 */
