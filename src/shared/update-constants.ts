/**
 * 客户端自动更新：跨进程共享的源码常量（解析链 L4 兜底层）
 *
 * 安全约束：
 * - 授权码字面量全工程只允许出现在本文件一处，其余位置只能 import / re-export；
 * - 任何日志、界面文案、报告都不得出现完整授权码，只允许 **** + 末 4 位指纹。
 */

/** 默认更新地址（与 UI / 服务端契约一致的无尾斜杠形态；如需变更只改本行——全工程唯一允许出现该 URL 字面量的位置） */
export const UPDATE_BASE_URL_SOURCE_DEFAULT = 'https://update.ai-cnlab.com';

/** 历史默认地址（均按无尾斜杠归一）：与当前默认一起，运行时判「未自定义」时等同处理 */
export const UPDATE_BASE_URL_LEGACY_DEFAULTS: readonly string[] = [
  'https://update.ai-cnlab.com',   // 0.8.4 之前常量带尾斜杠形态的归一化等价值
];

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
