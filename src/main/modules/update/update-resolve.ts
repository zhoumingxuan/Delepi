/**
 * 客户端自动更新：地址与授权码解析链的纯函数部分（无 Electron / Node 依赖，可独立实测）
 *
 * 解析优先级（地址）：L1 运行时设置 > L2 构建期环境变量 > L3 yml extraMetadata > L4 源码常量。
 * 解析优先级（授权码）：L2 构建期环境变量 > L3 yml extraMetadata > L4 源码常量（v1 不提供运行时输入）。
 */

import {
  UPDATE_ACCESS_KEY_SOURCE_DEFAULT,
  UPDATE_BASE_URL_SOURCE_DEFAULT,
  UPDATE_BASE_URL_LEGACY_DEFAULTS,
} from '@shared/update-constants';

export type UpdateValueSource = 'env' | 'yml' | 'source';

export interface ResolvedBaseUrl {
  baseUrl: string;
  source: UpdateValueSource;
}

export interface ResolvedAccessKey {
  accessKey: string;
  source: UpdateValueSource;
}

/** 规范化地址：trim + 去掉末尾斜杠（不去掉协议与路径） */
export function normalizeUpdateBaseUrl(raw: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * 地址合法性（客户端硬约束）：
 * - 只接受 https://；
 * - 仅 localhost / 127.0.0.1 / ::1 允许 http://（本地假服务端联调用）；
 * - 长度 ≤ 512，且不含空白字符。
 */
export function isAllowedUpdateBaseUrl(raw: string): boolean {
  const value = normalizeUpdateBaseUrl(raw);
  if (!value || value.length > 512 || /\s/.test(value)) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') {
    return Boolean(url.hostname);
  }
  if (url.protocol === 'http:') {
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  }
  return false;
}

/**
 * 构建期默认地址（L2 → L3 → L4）。
 * L2/L3 的值非法时静默跳过（不把错误地址烧进运行期）。
 */
export function resolveDefaultUpdateBaseUrl(envBaseUrl: string, ymlBaseUrl: string): ResolvedBaseUrl {
  const env = normalizeUpdateBaseUrl(envBaseUrl);
  if (env && isAllowedUpdateBaseUrl(env)) {
    return { baseUrl: env, source: 'env' };
  }
  const yml = normalizeUpdateBaseUrl(ymlBaseUrl);
  if (yml && isAllowedUpdateBaseUrl(yml)) {
    return { baseUrl: yml, source: 'yml' };
  }
  return { baseUrl: normalizeUpdateBaseUrl(UPDATE_BASE_URL_SOURCE_DEFAULT), source: 'source' };
}

/**
 * 当前生效地址（L1 → 默认地址）。
 * 空串 与 恰好等于源码默认值 / 任一历史默认地址 都视为「用户未自定义」，跟随构建期注入值。
 */
export function resolveEffectiveUpdateBaseUrl(
  settingsBaseUrl: string | null | undefined,
  defaultBaseUrl: string,
): string {
  const settings = normalizeUpdateBaseUrl(settingsBaseUrl ?? '');
  if (!settings) {
    return defaultBaseUrl;
  }
  const normalizedDefault = normalizeUpdateBaseUrl(UPDATE_BASE_URL_SOURCE_DEFAULT);
  if (
    settings === normalizedDefault ||
    UPDATE_BASE_URL_LEGACY_DEFAULTS.some((legacy) => settings === legacy)
  ) {
    return defaultBaseUrl;
  }
  if (!isAllowedUpdateBaseUrl(settings)) {
    return defaultBaseUrl;
  }
  return settings;
}

/**
 * 授权码解析（L2 → L3 → L4）。
 * 只接受 32 字符 base64url 无填充；非法覆盖值静默跳过。
 */
export function resolveUpdateAccessKey(envAccessKey: string, ymlAccessKey: string): ResolvedAccessKey {
  const keyPattern = /^[A-Za-z0-9_-]{32}$/;
  const env = typeof envAccessKey === 'string' ? envAccessKey.trim() : '';
  if (keyPattern.test(env)) {
    return { accessKey: env, source: 'env' };
  }
  const yml = typeof ymlAccessKey === 'string' ? ymlAccessKey.trim() : '';
  if (keyPattern.test(yml)) {
    return { accessKey: yml, source: 'yml' };
  }
  return { accessKey: UPDATE_ACCESS_KEY_SOURCE_DEFAULT, source: 'source' };
}
