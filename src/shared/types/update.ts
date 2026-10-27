/**
 * 客户端自动更新：跨进程共享类型（主进程 / preload / 渲染进程）
 */

/** 更新状态机全集：恰好 9 态，不多不少（新增 phase 属于契约变更） */
export type UpdatePhase =
  | 'idle'              // 空闲
  | 'checking'          // 检查中
  | 'update-available'  // 有新版本
  | 'up-to-date'        // 无新版本
  | 'downloading'       // 下载中
  | 'downloaded'        // 下载完成
  | 'verify-failed'     // 校验失败
  | 'network-failed'    // 网络失败
  | 'unauthorized';     // 授权码被拒（HTTP 404）

export type UpdatePlatform = 'win10' | 'linux' | 'mac';

/** 清单中的安装包描述 */
export interface UpdatePackageInfo {
  fileName: string;
  size: number;
  sha256: string;
}

/** 下载进度（receivedBytes / totalBytes） */
export interface UpdateProgress {
  receivedBytes: number;
  totalBytes: number;
}

/** 最近一次错误（message 面向日志与排障，禁止包含授权码） */
export interface UpdateErrorInfo {
  code: string;
  message: string;
  at: string;
}

/** 主进程推送给渲染层的完整快照 */
export interface UpdateStateSnapshot {
  phase: UpdatePhase;
  platform: UpdatePlatform | null;
  /** 当前应用版本：唯一来源 app.getVersion() */
  currentVersion: string;
  latestVersion: string | null;
  hasPackage: boolean;
  updateNotes: string | null;
  packageInfo: UpdatePackageInfo | null;
  progress: UpdateProgress | null;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  lastError: UpdateErrorInfo | null;
  autoCheckEnabled: boolean;
  /** 构建期解析出的默认地址（L2 → L3 → L4） */
  defaultBaseUrl: string;
  defaultBaseUrlSource: 'env' | 'yml' | 'source';
  /** 当前实际请求目标（L1 用户自定义 → 默认地址） */
  effectiveBaseUrl: string;
  downloadDir: string;
  /** 弹框提示类型：available=发现新版本；downloaded=可安装 */
  promptKind: 'available' | 'downloaded' | null;
  promptVersion: string | null;
  /** 启动扫描命中的本地缓存版本（无缓存时为 null） */
  cachedVersion: string | null;
}

export interface UpdateCheckParams {
  reason?: 'manual' | 'auto' | 'resume';
}

export interface UpdateCheckResult {
  accepted: boolean;
  snapshot: UpdateStateSnapshot;
}

export interface UpdateDownloadParams {
  version?: string;
}

export interface UpdateDownloadResult {
  started: boolean;
  code?: string;
  snapshot: UpdateStateSnapshot;
}

export interface UpdateInstallParams {
  version?: string;
}

export interface UpdateInstallResult {
  launched: boolean;
  code?: string;
  message?: string;
}

export interface UpdateCancelResult {
  cancelled: boolean;
  snapshot: UpdateStateSnapshot;
}
