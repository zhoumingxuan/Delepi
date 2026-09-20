import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ToolResult } from '../../tools/result';
import { isRecord } from '../../utils/index';

const EXECUTOR_MESSAGES_LOG_FILENAME = 'executor_messages.json';

export type ExecutorExecutionLogToolCall = {
  callId: string;
  name: string;
  arguments: string;
  status: 'calling' | 'completed' | 'failed';
  result?: ToolResult;
};

export type ExecutorExecutionLog = {
  version: 1;
  conversationId: string;
  taskId?: string;
  rawArguments: string;
  taskInput: unknown;
  inputIssues?: string[];
  toolCalls: ExecutorExecutionLogToolCall[];
  finalStructuredOutput?: unknown;
  finalResult?: ToolResult;
  errors: string[];
};

export function createExecutorExecutionLog(options: {
  conversationId: string;
  taskId?: string;
  rawArguments: string;
  taskInput: unknown;
  inputIssues?: string[];
}): ExecutorExecutionLog {
  return {
    version: 1,
    conversationId: options.conversationId,
    taskId: options.taskId,
    rawArguments: options.rawArguments,
    taskInput: options.taskInput,
    inputIssues: options.inputIssues?.length ? options.inputIssues : undefined,
    toolCalls: [],
    errors: [],
  };
}

export function appendExecutionLogToolCall(
  log: ExecutorExecutionLog,
  toolCall: {
    callId: string;
    name: string;
    arguments: string;
  },
): ExecutorExecutionLogToolCall {
  const logToolCall: ExecutorExecutionLogToolCall = {
    callId: toolCall.callId,
    name: toolCall.name,
    arguments: toolCall.arguments,
    status: 'calling',
  };
  log.toolCalls.push(logToolCall);
  return logToolCall;
}

export function completeExecutionLogToolCall(
  logToolCall: ExecutorExecutionLogToolCall | undefined,
  result: ToolResult,
): void {
  if (!logToolCall) {
    return;
  }

  logToolCall.status = result.success ? 'completed' : 'failed';
  logToolCall.result = result;
}

export function setExecutionLogStructuredOutput(
  log: ExecutorExecutionLog,
  payload: unknown,
): void {
  log.finalStructuredOutput = payload;
}

/**
 * S1 附加（方向1流式化日志粒度声明）：
 * 执行日志按「任务级最终态」记录——toolCalls 状态机（calling→completed/failed）、
 * finalStructuredOutput、finalResult、errors 均为任务收口时一次性写入
 * （attachExecutionLogPathToResult 唯一出口）；thinking 流式增量推送（S1-3）
 * 不进入本日志、不逐 delta 刷写——思考增量的持久化由 main-agent 侧
 * snapshot.json（thinking 字段随 sendToolSnapshot 覆盖式全量写入）承担。
 */
async function writeExecutorExecutionLog(
  log: ExecutorExecutionLog,
  finalOutputDir: string | undefined,
): Promise<string | undefined> {
  if (!finalOutputDir) {
    return undefined;
  }

  try {
    await mkdir(finalOutputDir, { recursive: true });
    const logPath = path.join(finalOutputDir, EXECUTOR_MESSAGES_LOG_FILENAME);
    await writeFile(logPath, JSON.stringify(log, null, 2), 'utf8');
    return path.resolve(logPath);
  } catch {
    return undefined;
  }
}

/**
 * ★ API 报错保留现场（方案⑤5.3/⑥#17）：throw 路径复用唯一写盘点生成 executor_messages.json。
 * errors 追加错误信息后经 writeExecutorExecutionLog 写盘（与成功路径同目录同文件名），
 * 返回绝对路径；写盘失败（内部 catch 返回 undefined）时返回 undefined——调用方据此不挂载
 * 路径，错误原样上抛，失败结果 data 保持空对象（降级安全）。
 */
export async function saveExecutionLogOnError(options: {
  log: ExecutorExecutionLog;
  finalOutputDir?: string;
  errorMessage: string;
}): Promise<string | undefined> {
  options.log.errors.push(options.errorMessage);
  return writeExecutorExecutionLog(options.log, options.finalOutputDir);
}

function addExecutionLogPathToData(
  data: unknown,
  executionLogPath: string | undefined,
): Record<string, unknown> | undefined {
  if (!executionLogPath) {
    return isRecord(data) ? data : undefined;
  }

  return {
    ...(isRecord(data) ? data : {}),
    execution_log_path: executionLogPath,
  };
}

export async function attachExecutionLogPathToResult(options: {
  result: ToolResult;
  log: ExecutorExecutionLog;
  finalOutputDir?: string;
}): Promise<ToolResult> {
  options.log.finalResult = options.result;
  const executionLogPath = await writeExecutorExecutionLog(
    options.log,
    options.finalOutputDir,
  );

  return {
    ...options.result,
    data: addExecutionLogPathToData(options.result.data, executionLogPath),
  };
}

export function extractExecutionLogPathFromToolResultText(output: string): string {
  const parsed = (() => {
    try {
      return JSON.parse(output) as unknown;
    } catch {
      return null;
    }
  })();

  if (!isRecord(parsed)) return '';
  const currentTaskExecutionResult = parsed.current_task_execution_result;
  if (!isRecord(currentTaskExecutionResult)) return '';
  const data = currentTaskExecutionResult.data;
  if (!isRecord(data)) return '';

  return typeof data.execution_log_path === 'string'
    ? data.execution_log_path
    : '';
}
