/**
 * 工具执行结果类型和构建函数
 * 
 */

import { MAX_OUTPUT_LENGTH, SUSPECTED_MOJIBAKE_WARNING } from '../constants';

export interface ToolResult {
  success: boolean;
  code: string;
  message: string;
  data?: Record<string, unknown> | string;
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
  data: Record<string, unknown> | string,
): string {
  const stdout = typeof data === 'string' ? '' : (typeof data.stdout === 'string' ? data.stdout : '');
  const stderr = typeof data === 'string' ? '' : (typeof data.stderr === 'string' ? data.stderr : '');

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
  code?: string;
  message: string;
  data?: Record<string, unknown> | string;
}): ToolResult {
  const data = options.data ?? {};
  return {
    success: options.success,
    code: options.code ?? '',
    message: appendOutputWarningMessage(options.message, data),
    data,
  };
}

export function buildSimpleToolResult(options: {
  success: boolean;
  code?: string;
  message: string;
  data?: Record<string, unknown> | string;
},id:string): {id:string,result:ToolResult} {
  const data = options.data ?? {};
  return {
    id:id,
    result:{
      success: options.success,
      code: options.code ?? '',
      message: appendOutputWarningMessage(options.message, data),
      data,
    }
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


/**
 * fs 工具结果按 JSON 序列化长度截断（fs_search / fs_list 共用）：
 * 完整 JSON 超过 MAX_OUTPUT_LENGTH(16384) 字符时，仅保留前 16384 字符作为 output，
 * 并在 message 中给出已输出字符数与实际总字符数；未超限时原样返回（结构与行为不变）。
 */
export function truncateFsResultJson(result: ToolResult): ToolResult {
  const json = JSON.stringify(result);

  if (json.length <= MAX_OUTPUT_LENGTH) {
    return result;
  }

  const output = json.slice(0, MAX_OUTPUT_LENGTH);

  return {
    success: result.success,
    code: result.code,
    message: `输出过大已被截断：目前已输出 ${output.length} 字符，实际总共有 ${json.length} 字符。`,
    data: {
      truncated: true,
      output_chars: output.length,
      total_chars: json.length,
      output,
    },
  };
}

/** 返回给模型的结构化输出：仅 success/message/data 三字段（code 等内部字段不外泄） */
export function stringifyToolResult(result: ToolResult): string {
  return JSON.stringify(
    {
      success: result.success,
      message: result.message,
      ...(result.data !== undefined ? { data: result.data } : {}),
    },
    null,
    2,
  );
}
