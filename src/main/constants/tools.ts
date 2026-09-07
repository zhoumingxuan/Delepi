/**
 * 工具执行相关常量
 * 归集自 run-shell.ts、run-with-python.ts、inspect-media.ts
 */

// ============================================================
// 命令行执行
// ============================================================

/** 默认命令行执行超时（秒）。
 * 挂起模式豁免（方向6 S6-3/D6C8 落档）：run_shell 与 run_with_python 的 suspend=true 挂起模式均 spawn 后立即返回真实子进程 PID，
 * timeout 语义=忽略，挂起进程生命周期由调用方管理（立即返回、不等待不采集、无执行超时）。 */
export const DEFAULT_TIMEOUT_SECONDS = 180;

/** timeout 上限（秒）：对齐 dyn-tool-loader DYN_TOOL_TIMEOUT_MAX_SECONDS / script-tool-protocol SCRIPT_TOOL_TIMEOUT_MAX_SECONDS 的 3600 语义 */
export const TOOL_TIMEOUT_MAX_SECONDS = 3600;

/** 最大命令长度 */
export const MAX_COMMAND_LENGTH = 8000;

/** 工具输出单字段统一截断阈值（字符） */
export const MAX_OUTPUT_LENGTH = 16 * 1024;

// ============================================================
// 文件读取
// ============================================================

/** 模型返回无效工具调用时用于闭合 tool_call 消息链的占位工具名 */
export const EXECUTOR_INVALID_TOOL_CALL_NAME = '__invalid_tool_call__';

// ============================================================
// 图片处理
// ============================================================

/** 模型图片最大宽度 */
export const MAX_MODEL_IMAGE_WIDTH = 1920;

/** 模型图片最大高度 */
export const MAX_MODEL_IMAGE_HEIGHT = 1080;
