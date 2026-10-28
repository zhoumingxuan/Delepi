/**
 * 客户端自动更新：跨进程共享的源码常量（解析链 L4 兜底层）
 *
 * 安全约束：
 * - 授权码字面量全工程只允许出现在本文件一处，其余位置只能 import / re-export；
 * - 任何日志、界面文案、报告都不得出现完整授权码，只允许 **** + 末 4 位指纹。
 */

/** 默认更新地址（23 字符，无尾斜杠；与服务端契约的 baseUrl 逐字一致） */
export const UPDATE_BASE_URL_SOURCE_DEFAULT = 'http://10.1.52.167:8033';

/**
 * 历史默认地址（0.8.0 及更早版本的构建期默认值，43 字符，无尾斜杠）。
 * 用户设置层可能已持久化过旧默认地址；解析时必须与「空串」同等视为「用户未自定义」，
 * 否则旧值会被误判为用户自定义地址而继续请求旧域名。
 */
export const UPDATE_BASE_URL_SOURCE_LEGACY_DEFAULT = 'https://download.ai-cnlab.com/delepi/update';

/**
 * 历史默认地址（0.8.1-0.8.3 构建期默认值，27 字符，无尾斜杠）。
 * 默认地址已于 2026-10-29 改为 http://10.1.52.167:8033；用户设置层若已持久化过本旧默认地址，
 * 解析时必须与「空串」同等视为「用户未自定义」，否则旧值会被误判为用户自定义地址而钉死旧域名。
 */
export const UPDATE_BASE_URL_SOURCE_LEGACY_DEFAULT_V2 = 'https://update.ai-cnlab.com';

/** 开发占位默认授权码（32 字符 base64url 无填充；可被 L2 环境变量 / L3 yml 覆盖） */
export const UPDATE_ACCESS_KEY_SOURCE_DEFAULT = 'delepi_update_K7mQ3vTz9LpW4aB2cD';

/** 更新接口鉴权请求头名（不进 URL，避免落入访问日志与浏览器历史） */
export const UPDATE_ACCESS_KEY_HEADER = 'X-Delepi-Update-Key';

/** 平台枚举（与 shared/types/update.ts 的 UpdatePlatform 逐字一致） */
export const UPDATE_PLATFORMS = ['win10', 'linux', 'mac'] as const;

/** 下载缓存目录名（位于 storage-paths 的客户端 bin 根目录下） */
export const UPDATE_DIR_NAME = 'updates';

/** 单版本目录旁注元数据文件名 */
export const UPDATE_PACKAGE_META_FILE_NAME = '.meta.json';

/** 下载临时文件后缀 */
export const UPDATE_PART_FILE_SUFFIX = '.part';

/** 授权码指纹：仅末 4 位可见（日志唯一允许的密钥表示） */
export function fingerprintUpdateAccessKey(key: string): string {
  const normalized = typeof key === 'string' ? key : '';
  return `****${normalized.slice(-4)}`;
}
