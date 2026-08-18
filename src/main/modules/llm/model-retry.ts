/**
 * 模型API重试策略
 * - 5次重试上限
 * - 限流/网络错误：10秒延迟
 * - 400错误/算法错误：1秒快速重试
 * - 100%复用自参考项目 E:\ai_fr
 */

import { ensureErrorMessage } from '../../utils/index';

export const MODEL_API_RETRY_LIMIT = 5;
const MODEL_API_RETRY_DELAY_MS = 10_000;
const MODEL_API_BAD_REQUEST_RETRY_DELAY_MS = 1_000;
const MODEL_API_GENERATION_ERROR_RETRY_DELAY_MS = 1_000;
const FAST_RETRY_ERROR_CODES = new Set([
  'InternalError.Algo',
]);

type ErrorWithApiFields = {
  cause?: unknown;
  code?: unknown;
  name?: unknown;
  status?: unknown;
};

export class ModelApiAbortError extends Error {
  readonly cause: unknown;
  readonly retryCount: number;

  constructor(options: {
    cause: unknown;
    message: string;
    retryCount: number;
  }) {
    super(options.message);
    this.name = 'ModelApiAbortError';
    this.cause = options.cause;
    this.retryCount = options.retryCount;
  }
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const status = (error as ErrorWithApiFields).status;
  return typeof status === 'number' ? status : null;
}

function getErrorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }
  if (!error || typeof error !== 'object') {
    return '';
  }
  const name = (error as ErrorWithApiFields).name;
  return typeof name === 'string' ? name : '';
}

function getErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return '';
  }
  const code = (error as ErrorWithApiFields).code;
  return typeof code === 'string' ? code : '';
}

function isFastRetryModelApiError(error: unknown): boolean {
  if (getErrorStatus(error) === 400) {
    return true;
  }
  return FAST_RETRY_ERROR_CODES.has(getErrorCode(error));
}

function getErrorText(error: unknown): string {
  const parts = [
    ensureErrorMessage(error),
    getErrorCode(error),
  ];
  return parts.join(' ').toLowerCase();
}

function getErrorCause(error: unknown): unknown {
  if (!error || typeof error !== 'object') {
    return null;
  }
  return (error as ErrorWithApiFields).cause ?? null;
}

function isNetworkConnectionError(error: unknown): boolean {
  const name = getErrorName(error);
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') {
    return true;
  }
  const code = getErrorCode(error);
  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_SOCKET'
  ) {
    return true;
  }
  const cause = getErrorCause(error);
  return Boolean(cause) && cause !== error && isNetworkConnectionError(cause);
}

function isRateLimitModelApiError(error: unknown): boolean {
  if (getErrorStatus(error) === 429) {
    return true;
  }
  const errorText = getErrorText(error);
  return (
    errorText.includes('rate limit') ||
    errorText.includes('ratelimit') ||
    errorText.includes('ratequota') ||
    errorText.includes('too many requests') ||
    errorText.includes('throttl') ||
    errorText.includes('concurrent') ||
    errorText.includes('并发') ||
    errorText.includes('限流')
  );
}

function getRetryDelayMs(error: unknown): number | null {
  if (isRateLimitModelApiError(error)) {
    return MODEL_API_RETRY_DELAY_MS;
  }
  if (isFastRetryModelApiError(error)) {
    return getErrorStatus(error) === 400
      ? MODEL_API_BAD_REQUEST_RETRY_DELAY_MS
      : MODEL_API_GENERATION_ERROR_RETRY_DELAY_MS;
  }
  if (isNetworkConnectionError(error)) {
    return MODEL_API_RETRY_DELAY_MS;
  }
  return null;
}

function isFatalModelApiError(error: unknown): boolean {
  const status = getErrorStatus(error);

  return (
    typeof status === 'number' &&
    !isFastRetryModelApiError(error) &&
    !isRateLimitModelApiError(error)
  );
}

export function isModelApiAbortError(error: unknown): error is ModelApiAbortError {
  return error instanceof ModelApiAbortError;
}

export function sleepBeforeRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('ABORTED'));
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const handleAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('ABORTED'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

export async function runModelApiWithRetry<T>(
  operation: () => Promise<T>,
  options?: {
    signal?: AbortSignal;
  },
): Promise<T> {
  let retryCount = 0;

  while (true) {
    if (options?.signal?.aborted) {
      throw options.signal.reason ?? new Error('ABORTED');
    }

    try {
      return await operation();
    } catch (error) {
      if (options?.signal?.aborted) {
        throw options.signal.reason ?? new Error('ABORTED');
      }

      const retryDelayMs = getRetryDelayMs(error);

      if (retryDelayMs !== null) {
        if (retryCount >= MODEL_API_RETRY_LIMIT) {
          throw new ModelApiAbortError({
            cause: error,
            retryCount,
            message: `模型接口错误已重试 ${MODEL_API_RETRY_LIMIT} 次，按取消处理：${ensureErrorMessage(error)}`,
          });
        }

        retryCount += 1;
        await sleepBeforeRetry(retryDelayMs, options?.signal);
        continue;
      }

      if (isFatalModelApiError(error)) {
        throw new ModelApiAbortError({
          cause: error,
          retryCount,
          message: `模型接口返回不可重试错误，按取消处理：${ensureErrorMessage(error)}`,
        });
      }

      throw error;
    }
  }
}

