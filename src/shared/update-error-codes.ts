/**
 * 客户端自动更新错误码（只增不改名；改名等同于破坏 IPC 契约）
 */

export const UPDATE_ERROR_CODES = {
  /** 当前已有检查或下载在途（inFlight 互斥） */
  BUSY: 'ERR_UPDATE_BUSY',
  /** 非 win10 / linux / mac 平台 */
  UNSUPPORTED_PLATFORM: 'ERR_UPDATE_UNSUPPORTED_PLATFORM',
  /** DNS / 连接 / TLS / 传输中断 */
  NETWORK: 'ERR_UPDATE_NETWORK',
  /** 连接或响应超时 */
  TIMEOUT: 'ERR_UPDATE_TIMEOUT',
  /** 非 JSON、字段缺失、字段非法、状态码意外 */
  BAD_RESPONSE: 'ERR_UPDATE_BAD_RESPONSE',
  /** 服务端 5xx */
  SERVER: 'ERR_UPDATE_SERVER',
  /** 服务端 404（授权码错误、路径不存在、方法不符三者不可区分） */
  UNAUTHORIZED: 'ERR_UPDATE_UNAUTHORIZED',
  /** 服务端 400：平台非法 */
  BAD_PLATFORM: 'ERR_UPDATE_BAD_PLATFORM',
  /** 服务端 400：版本号非法 */
  BAD_VERSION: 'ERR_UPDATE_BAD_VERSION',
  /** 有新版本但服务端未提供安装包 */
  NO_PACKAGE: 'ERR_UPDATE_NO_PACKAGE',
  /** 本地可用空间不足 */
  DISK: 'ERR_UPDATE_DISK',
  /** 落盘失败（权限 / 路径 / 写流异常） */
  WRITE: 'ERR_UPDATE_WRITE',
  /** 落盘字节数与清单 size 不一致 */
  SIZE_MISMATCH: 'ERR_UPDATE_SIZE_MISMATCH',
  /** 落盘 SHA-256 与清单 sha256 不一致 */
  HASH_MISMATCH: 'ERR_UPDATE_HASH_MISMATCH',
  /** 安装器启动失败 */
  INSTALL_FAILED: 'ERR_UPDATE_INSTALL_FAILED',
  /** 用户取消（内部流转，不写入 lastError） */
  CANCELLED: 'ERR_UPDATE_CANCELLED',
} as const;

export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[keyof typeof UPDATE_ERROR_CODES];
