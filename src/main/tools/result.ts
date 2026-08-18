/**
 * 工具执行结果类型和构建函数
 * 100%复用自参考项目 E:\ai_fr
 */

import { SUSPECTED_MOJIBAKE_WARNING } from '../constants';

export interface ToolResult {
  success: boolean;
  code: string;
  message: string;
  data?: Record<string, unknown>;
  next_suggestion?: string;
}

// ToolResult 类型本地定义



const UTF8_LATIN1_MOJIBAKE_PATTERN =
  /(?:ä[\u00a0-\u00bf]|å[\u0080-\u00bf]|æ[\u0080-\u00bf]|ç[\u0080-\u00bf]|è[\u0080-\u00bf]|é[\u0080-\u00bf]){2,}/u;

const CP1252_UTF8_MOJIBAKE_PATTERN =
  /(?:Ã[\u0080-\u00bf]|Â[\u0080-\u00bf]){2,}/u;

function hasSuspectedChineseMojibake(text: string): boolean {
  if (!text) {
    return false;
  }

  if (text.includes('�')) {
    return true;
  }

  return (
    UTF8_LATIN1_MOJIBAKE_PATTERN.test(text) ||
    CP1252_UTF8_MOJIBAKE_PATTERN.test(text)
  );
}

function appendOutputWarningMessage(
  message: string,
  data: Record<string, unknown>,
): string {
  const stdout = typeof data.stdout === 'string' ? data.stdout : '';
  const stderr = typeof data.stderr === 'string' ? data.stderr : '';

  if (
    !hasSuspectedChineseMojibake(stdout) &&
    !hasSuspectedChineseMojibake(stderr)
  ) {
    return message;
  }

  return `${message}\n${SUSPECTED_MOJIBAKE_WARNING}`;
}

export function buildExecutedToolResultData(options: {
  returncode: number;
  stdout: string;
  stderr: string;
  execId: string;
  responseId: string;
}): Record<string, unknown> {
  return {
    returncode: options.returncode,
    stdout: options.stdout,
    stderr: options.stderr,
    execId: options.execId,
    responseId: options.responseId,
  };
}

export function buildToolResult(options: {
  success: boolean;
  code: string;
  message: string;
  data?: Record<string, unknown>;
  nextSuggestion?: string;
}): ToolResult {
  const data = options.data ?? {};
  const result: ToolResult = {
    success: options.success,
    code: options.code,
    message: appendOutputWarningMessage(options.message, data),
    data,
  };
  const nextSuggestion = options.nextSuggestion?.trim();

  if (nextSuggestion) {
    result.next_suggestion = nextSuggestion;
  }

  return result;
}

export function buildSimpleToolResult(options: {
  success: boolean;
  code: string;
  message: string;
  data?: Record<string, unknown>;
  nextSuggestion?: string;
},id:string): {id:string,result:ToolResult} {
  const data = options.data ?? {};
  const result: ToolResult = {
    success: options.success,
    code: options.code,
    message: appendOutputWarningMessage(options.message, data),
    data,
  };
  const nextSuggestion = options.nextSuggestion?.trim();

  if (nextSuggestion) {
    result.next_suggestion = nextSuggestion;
  }

  return {
    id:id,
    result:result
  };
}

export function stringifyToolResult(result: ToolResult): string {
  return JSON.stringify(result, null, 2);
}
