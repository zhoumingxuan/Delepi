/**
 * 通用工具函数
 */

/** 确保错误消息可读 */
export function ensureErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object') {
    const msg = (error as Record<string, unknown>).message;
    if (typeof msg === 'string') {
      return msg;
    }
  }
  return String(error);
}

/** 检查值是否为非空记录 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 安全字符串规范化（null/undefined 视为空串） */
export function normalizeString(value: unknown): string {
  return String(value ?? '').trim();
}

/** 占位输出函数（用于屏蔽工具内部 stdout 噪音） */
export function ioPrint(..._args: unknown[]): void {
  // 故意为空，调用点不产生任何输出
}
