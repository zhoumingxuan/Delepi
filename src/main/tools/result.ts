/**
 * 工具执行结果类型和构建函数
 * 100%复用自参考项目 E:\ai_fr
 */

import { MAX_OUTPUT_LENGTH, SUSPECTED_MOJIBAKE_WARNING } from '../constants';

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
  /** 工具自有小字段（如 start_line/file_name/pid 等），插入在 responseId 与 stdout 之间 */
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    returncode: options.returncode,
    execId: options.execId,
    responseId: options.responseId,
    ...(options.extra ?? {}),
    stdout: options.stdout,
    stderr: options.stderr,
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

/** 工具输出截断固定后缀（逐字规范，勿手写其它形态） */
export function buildOutputTruncationSuffix(): string {
  return `...输出超过${MAX_OUTPUT_LENGTH} 字符，已截断`;
}

/** 工具输出单字段统一截断：超 MAX_OUTPUT_LENGTH(16384) 字符保留前 16384 字符并追加固定后缀 */
export function truncateToolOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_OUTPUT_LENGTH)}${buildOutputTruncationSuffix()}`;
}

/** 按行截断：逐行累计字符（行间换行符计 1 字符），加入当前行会超限则停在上一行边界并追加固定后缀；首行即超限则 slice 保底保留前 16384 字符 */
export function truncateLinesToLimit(lines: string[]): string {
  let total = 0;
  const kept: string[] = [];

  for (const line of lines) {
    const addLen = line.length + (kept.length > 0 ? 1 : 0);

    if (total + addLen > MAX_OUTPUT_LENGTH) {
      if (kept.length === 0) {
        kept.push(line.slice(0, MAX_OUTPUT_LENGTH));
      }
      return `${kept.join('\n')}${buildOutputTruncationSuffix()}`;
    }

    kept.push(line);
    total += addLen;
  }

  return lines.join('\n');
}

export function stringifyToolResult(result: ToolResult): string {
  return JSON.stringify(result, null, 2);
}
