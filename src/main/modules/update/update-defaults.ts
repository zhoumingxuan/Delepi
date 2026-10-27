/**
 * 客户端自动更新：主进程数值常量（调度 / 超时 / 进度 / 清理）
 *
 * 用户裁决（2026-10-27）：启动后 30 秒首检（±10 秒），此后每 1 小时（±10 分钟）一次；
 * 方案原推荐的 6 小时已作废。
 */

export {
  UPDATE_ACCESS_KEY_SOURCE_DEFAULT,
  UPDATE_BASE_URL_SOURCE_DEFAULT,
} from '@shared/update-constants';

/** 启动后首检延迟：30 秒 */
export const FIRST_CHECK_DELAY_MS = 30_000;
/** 首检抖动：±10 秒 */
export const FIRST_CHECK_JITTER_MS = 10_000;
/** 周期检查间隔：1 小时 */
export const CHECK_INTERVAL_MS = 60 * 60_000;
/** 周期检查抖动：±10 分钟 */
export const CHECK_INTERVAL_JITTER_MS = 10 * 60_000;
/** 手动检查冷却：60 秒（错误态「重试」不受此限制） */
export const MANUAL_CHECK_COOLDOWN_MS = 60_000;
/** 自动更新开关从关到开后的首检延迟：1.5 秒 */
export const SETTING_ENABLED_RECHECK_DELAY_MS = 1_500;
/** 网络失败指数退避上限：24 小时 */
export const BACKOFF_MAX_MS = 24 * 60 * 60_000;
/** 连接超时：8 秒 */
export const CONNECT_TIMEOUT_MS = 8_000;
/** 响应超时：10 秒 */
export const RESPONSE_TIMEOUT_MS = 10_000;
/** 下载无数据超时：30 秒 */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
/** 下载总时长上限：60 分钟 */
export const DOWNLOAD_TOTAL_TIMEOUT_MS = 60 * 60_000;
/** 下载进度推送间隔：200ms */
export const DOWNLOAD_PROGRESS_INTERVAL_MS = 200;
/** 下载进度推送字节步长：256KB */
export const DOWNLOAD_PROGRESS_BYTES_STEP = 256 * 1024;
/** 启动清理：超过 24 小时的 .part 残留 */
export const STALE_PART_MAX_AGE_MS = 24 * 60 * 60_000;
