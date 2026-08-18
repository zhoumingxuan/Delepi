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
