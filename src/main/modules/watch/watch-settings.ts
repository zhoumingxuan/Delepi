/**
 * 值守模式配置读取侧归一化（阶段1）
 *
 * 背景：config-manager.reload() 的合并规则为——键不在 DEFAULT_APP_SETTINGS 白名单则静默丢弃；
 * 空字符串被过滤但 false 与 0 不被过滤。因此 watchPollIntervalMinutes=0/非整数等非法值会
 * 原样进入运行时，必须在【读取侧】统一夹紧；字符串键在此统一 trim。所有值守消费点
 * （watch-service 自检/轮询/回执）一律先经本函数归一化再使用。
 */

import type { AppSettings } from '@shared/types/config';

/** 归一化后的值守配置键集合（全部为安全值，可直接进入值守运行时） */
export interface NormalizedWatchSettings {
  watchEnabled: boolean;
  watchMailboxAddress: string;
  watchMailboxAuthCode: string;
  watchPollIntervalMinutes: number;
  watchReceiptRecipient: string;
}

/** 归一化入参约束：AppSettings 的值守五键子集（传入完整 AppSettings 同样兼容） */
type WatchSettingsInput = Pick<
  AppSettings,
  | 'watchEnabled'
  | 'watchMailboxAddress'
  | 'watchMailboxAuthCode'
  | 'watchPollIntervalMinutes'
  | 'watchReceiptRecipient'
>

/** 字符串清洗：仅接受 string，trim 后返回；其余类型一律回落空串 */
function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 轮询分钟数夹紧（正整数、≥1、无上限）：
 * - 非有限数 / NaN / 非数值 → 默认 2
 * - 非整数 → 向下取整后再夹紧
 * - 取整后 < 1 → 夹紧为 1
 */
function clampIntervalMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 2;
  }
  const floored = Math.floor(value);
  return floored < 1 ? 1 : floored;
}

/**
 * 值守配置读取侧归一化（唯一入口）。
 * 布尔键严格校验（仅 true 视为开启）；字符串键 trim；分钟数夹紧。
 */
export function normalizeWatchSettings(settings: WatchSettingsInput): NormalizedWatchSettings {
  return {
    watchEnabled: settings.watchEnabled === true,
    watchMailboxAddress: cleanString(settings.watchMailboxAddress),
    watchMailboxAuthCode: cleanString(settings.watchMailboxAuthCode),
    watchPollIntervalMinutes: clampIntervalMinutes(settings.watchPollIntervalMinutes),
    watchReceiptRecipient: cleanString(settings.watchReceiptRecipient),
  };
}
