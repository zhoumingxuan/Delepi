/**
 * 依赖管理类型定义
 * 主进程和渲染进程均从此文件导入依赖管理相关类型
 *
 * 覆盖场景：
 * - A: pip 引导安装（bootstrapPip）
 * - B: 三级选包 + 镜像源（DepsLevel + mirrorUrl）
 * - C: 实时进度推送 + 取消（DepsInstallProgress + cancelInstall）
 * - D: 已安装清单 + 导出 bundle（exportBundle）
 * - E: 内网导入 bundle → 一键安装（importBundle）
 */

/** 依赖包安装级别：核心6包 / 推荐14包 / 全部24包 */
export type DepsLevel = 'core' | 'recommended' | 'full';

/** 单个依赖包安装状态 */
export type DepsPackageStatus = 'pending' | 'installing' | 'installed' | 'failed' | 'skipped';

/** 单个依赖包信息 */
export interface DepsPackage {
  /** pip 包名称（如 numpy、requests） */
  name: string;
  /** 所属安装级别 */
  level: DepsLevel;
  /** 当前安装状态 */
  status: DepsPackageStatus;
  /** 已安装版本号 */
  version?: string;
  /** 包大小估算（字节） */
  size?: number;
  /** 安装失败时的错误信息 */
  error?: string;
}

/**
 * 依赖管理状态枚举
 * 独立定义，与 PythonState 零耦合（不可相互引用）
 *
 * PythonState 枚举值：DETECTING | DOWNLOADING | EXTRACTING | READY | FAILED
 * 本枚举所有成员名与 PythonState 无重叠，两者完全独立
 */
export enum DepsStatus {
  /** 空闲，等待操作指令 */
  IDLE = 'IDLE',
  /** 正在检查 pip 环境 */
  CHECKING = 'CHECKING',
  /** 正在引导安装 pip */
  BOOTSTRAPPING = 'BOOTSTRAPPING',
  /** pip 环境已就绪 */
  PIP_READY = 'PIP_READY',
  /** 正在安装依赖包 */
  INSTALLING = 'INSTALLING',
  /** 正在取消安装操作 */
  CANCELLING = 'CANCELLING',
  /** 操作已成功完成 */
  COMPLETED = 'COMPLETED',
  /** 安装操作失败 */
  INSTALL_FAILED = 'INSTALL_FAILED',
}

/** 依赖安装进度（实时推送到渲染进程） */
export interface DepsInstallProgress {
  /** 当前状态 */
  status: DepsStatus;
  /** 当前正在处理的包索引（从 0 开始） */
  currentIndex: number;
  /** 待处理总包数 */
  totalCount: number;
  /** 当前正在处理的包名称 */
  currentPackage: string;
  /** 当前包安装进度（0-100） */
  progress: number;
  /** 已安装成功数 */
  installedCount: number;
  /** 安装失败数 */
  failedCount: number;
  /** 错误信息（仅在 INSTALL_FAILED 状态有效） */
  error?: string;
  /** 当前是否允许取消 */
  cancellable: boolean;
}

/** 依赖安装参数 */
/**
 * 自定义依赖包
 * 允许用户指定非预设清单中的第三方依赖包进行安装
 */
export interface CustomDepsPackage {
  /** pip 包名称 */
  name: string;
  /** 目标版本号（如 1.0.0，为空则安装最新版） */
  version?: string;
  /** 所属安装级别 */
  level: DepsLevel;
}

export interface DepsInstallParams {
  /** 目标安装级别 */
  level: DepsLevel;
  /** pip 镜像源 URL（为空则使用默认 PyPI 源） */
  mirrorUrl?: string;
  /** 是否自动引导安装 pip（默认 true） */
  autoBootstrap?: boolean;
  /** 自定义依赖包列表（可选，用户通过文件上传提供的第三方依赖） */
  customPackages?: CustomDepsPackage[];
}

/** 离线包清单（bundle 导出/导入使用） */
export interface DepsBundleManifest {
  /** 清单格式版本号 */
  version: string;
  /** 导出时间（ISO 8601 格式） */
  exportedAt: string;
  /** 包含的依赖包列表 */
  packages: DepsPackage[];
  /** 所有包总大小（字节） */
  totalSize: number;
  /** pip 版本号 */
  pipVersion: string;
  /** 导出平台标识（如 win32-x64） */
  platform: string;
  /** Python 版本号 */
  pythonVersion: string;
}

/** 离线包导出结果 */
export interface DepsExportResult {
  /** 是否导出成功 */
  success: boolean;
  /** 导出的 bundle 文件路径 */
  bundlePath?: string;
  /** 清单详情 */
  manifest?: DepsBundleManifest;
  /** 导出失败时的错误信息 */
  error?: string;
}

/** 离线包导入校验结果 */
export interface DepsImportResult {
  /** 清单是否有效 */
  valid: boolean;
  /** 解析后的清单信息 */
  manifest?: DepsBundleManifest;
  /** 预览待安装包列表 */
  preview?: DepsPackage[];
  /** 校验失败时的错误信息 */
  error?: string;
}
