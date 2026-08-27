/**
 * 错误码常量
 * 归集自 executor-agent.ts、main-agent.ts、ipc-handlers.ts、run-shell.ts、run-with-python.ts、inspect-image.ts、result.ts
 */

// ============================================================
// 委派任务错误码
// ============================================================

export const ERR_DELEGATED_TASK_INVALID_INPUT = 'DELEGATED_TASK_INVALID_INPUT';
export const ERR_DELEGATED_TASK_INVALID_OUTPUT = 'DELEGATED_TASK_INVALID_OUTPUT';
export const ERR_DELEGATED_TASK_FILE_DELIVERY_FAILED = 'DELEGATED_TASK_FILE_DELIVERY_FAILED';
export const ERR_DELEGATED_TASK_COMPLETED = 'DELEGATED_TASK_COMPLETED';
export const ERR_DELEGATED_TASK_FAILED = 'DELEGATED_TASK_FAILED';

// ============================================================
// 通用错误码
// ============================================================

export const ERR_ABORTED = 'ABORTED';
export const ERR_EXECUTOR_ERROR = 'EXECUTOR_ERROR';
export const ERR_CONVERSATION_RUNNING = 'CONVERSATION_RUNNING';
export const ERR_INVALID_ARGUMENT = 'INVALID_ARGUMENT';
export const ERR_OK = 'OK';

// ============================================================
// run_shell 错误码
// ============================================================

export const ERR_COMMAND_TOO_LONG = 'COMMAND_TOO_LONG';
export const ERR_INVALID_WORK_DIR = 'INVALID_WORK_DIR';
export const ERR_TIMEOUT = 'TIMEOUT';
export const ERR_EXECUTION_ERROR = 'EXECUTION_ERROR';
export const ERR_COMMAND_EXITED_NON_ZERO = 'COMMAND_EXITED_NON_ZERO';

// ============================================================
// run-with-python 错误码
// ============================================================

export const ERR_INVALID_RUN_DIR = 'INVALID_RUN_DIR';
export const ERR_WRITE_FILE_ERROR = 'WRITE_FILE_ERROR';
export const ERR_COMPILE_ERROR = 'COMPILE_ERROR';
export const ERR_PROCESS_EXITED_NON_ZERO = 'PROCESS_EXITED_NON_ZERO';
export const ERR_CONFIG_NOT_READY = 'CONFIG_NOT_READY';

// ============================================================
// inspect-image 错误码
// ============================================================

export const ERR_NOT_IMAGE_FILE = 'NOT_IMAGE_FILE';
export const ERR_UNSUPPORTED_IMAGE_FORMAT = 'UNSUPPORTED_IMAGE_FORMAT';
export const ERR_IMAGE_RESIZE_FAILED = 'IMAGE_RESIZE_FAILED';
export const ERR_PATH_NOT_FILE = 'PATH_NOT_FILE';
export const ERR_FILE_NOT_FOUND = 'FILE_NOT_FOUND';
export const ERR_FILE_READ_ERROR = 'FILE_READ_ERROR';

// ============================================================
// read-file 错误码
// ============================================================

export const ERR_NOT_TEXT_FILE = 'NOT_TEXT_FILE';
export const ERR_UNSUPPORTED_ENCODING = 'UNSUPPORTED_ENCODING';

// ============================================================
// 乱码警告
// ============================================================

export const SUSPECTED_MOJIBAKE_WARNING =
  '警告：检测到疑似中文乱码，请检查编码或解码设置。';
