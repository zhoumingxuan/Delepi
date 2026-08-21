/**
 * 依赖管理管理器
 * 负责 pip 引导安装、三级依赖包安装、离线包导入导出等功能
 * 单例模式，与 PythonManager 协作，状态机驱动
 */

import type {
  DepsLevel,
  DepsPackage,
  DepsInstallProgress,
  DepsInstallParams,
  DepsBundleManifest,
  DepsExportResult,
  DepsImportResult,
} from '@shared/types/deps';
import type { ParsedImportResult, ImportPackageItem } from '@shared/types/deps-import';
import { DepsStatus } from '@shared/types/deps';
import { BrowserWindow } from 'electron';
import { IPC_DEPS } from '@shared/ipc-channels';
import { PythonManager } from './python-manager';
import { pythonManager } from './index';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { get } from 'node:https';
import { IncomingMessage } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { mkdir, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { depsStorage } from './deps-storage';

// ================================================================
// 常量
// ================================================================

/** 三级依赖包清单：核心6包 / 推荐20包（核心+14） / 全部30包（推荐+10） */
const DEPS_PACKAGES: DepsPackage[] = [
  // ---- 核心6包 ----
  { name: 'numpy',          level: 'core',        status: 'pending' },
  { name: 'requests',       level: 'core',        status: 'pending' },
  { name: 'python-dotenv',  level: 'core',        status: 'pending' },
  { name: 'pyyaml',         level: 'core',        status: 'pending' },
  { name: 'openpyxl',       level: 'core',        status: 'pending' },
  { name: 'python-docx',    level: 'core',        status: 'pending' },

  // ---- 推荐+8包 ----
  { name: 'openai',         level: 'recommended', status: 'pending' },
  { name: 'httpx',          level: 'recommended', status: 'pending' },
  { name: 'tiktoken',       level: 'recommended', status: 'pending' },
  { name: 'tqdm',           level: 'recommended', status: 'pending' },
  { name: 'rich',           level: 'recommended', status: 'pending' },
  { name: 'Pillow',         level: 'recommended', status: 'pending' },
  { name: 'pdfplumber',     level: 'recommended', status: 'pending' },
  { name: 'pandas',         level: 'recommended', status: 'pending' },
  // ---- HTML/XML/浏览器（2026-08-20 新增）----
  { name: 'beautifulsoup4', level: 'recommended', status: 'pending' },
  { name: 'html5lib',       level: 'recommended', status: 'pending' },
  { name: 'xmltodict',      level: 'recommended', status: 'pending' },
  { name: 'defusedxml',     level: 'recommended', status: 'pending' },
  { name: 'playwright',     level: 'recommended', status: 'pending' },
  { name: 'pygetwindow',    level: 'recommended', status: 'pending' },

  // ---- 全部+10包 ----
  { name: 'scipy',          level: 'full',        status: 'pending' },
  { name: 'matplotlib',     level: 'full',        status: 'pending' },
  { name: 'scikit-learn',   level: 'full',        status: 'pending' },
  { name: 'statsmodels',    level: 'full',        status: 'pending' },
  { name: 'aiohttp',        level: 'full',        status: 'pending' },
  { name: 'opencv-python',  level: 'full',        status: 'pending' },
  { name: 'python-pptx',    level: 'full',        status: 'pending' },
  { name: 'paramiko',       level: 'full',        status: 'pending' },
  { name: 'networkx',       level: 'full',        status: 'pending' },
  { name: 'xlsxwriter',     level: 'full',        status: 'pending' },
];

/** 预置包标记文件名（与 python-manager.ts 的 PRESET_MARKER_FILE 一致） */
const PRESET_MARKER_FILE = '.beez-preset';

/** SQLite 持久化 key：已安装依赖包列表 */

// ================================================================
// DepsManager
// ================================================================

export class DepsManager {
  private static instance: DepsManager | null = null;

  /** 当前依赖管理状态 */
  private depsStatus: DepsStatus = DepsStatus.IDLE;
  /** 已安装包列表 */
  private installedPackages: DepsPackage[] = [];
  /** 是否已从 SQLite 恢复数据 */
  private _dbRestored = false;

  /** 取消安装标志 */
  private _cancelRequested = false;
  /** 上次进度推送时间戳，用于 debounce 避免 IPC 风暴 */
  private _lastProgressEmitTime: number = 0;

  /** 当前活跃的子进程引用，用于取消安装时终止 */
  private _currentProcess: ChildProcess | null = null;

  static getInstance(): DepsManager {
    if (!DepsManager.instance) {
      DepsManager.instance = new DepsManager();
    }
    return DepsManager.instance;
  }

  private constructor() {
    // fire-and-forget: 从 SQLite 迁移历史数据到 JSON 文件
    depsStorage.migrateFromSqlite().catch((err: unknown) => {
      console.warn('[DepsManager] migrateFromSqlite 失败（非致命）:', err);
    });
    // ★ 新增：尝试从预置标记文件加载预装包清单（预置模式下标记为已安装，避免重复安装）
    this._loadPresetPackageList();
  }

  // ==============================================================
  // 预置包清单（预置 Python 环境支持）
  // ==============================================================

  /**
   * 获取预置包清单
   * 读取 resources/python/python-3.14.6/.beez-preset 获取预置包清单
   * @returns 预置包名称 → 版本号 映射；无预置包时返回空对象
   */
  getPresetPackageList(): Record<string, string> {
    try {
      const markerPath = path.join(pythonManager.getPythonDir(), PRESET_MARKER_FILE);
      if (!existsSync(markerPath)) {
        return {};
      }
      const raw = readFileSync(markerPath, 'utf-8');
      const preset = JSON.parse(raw) as { packages?: Record<string, string> };
      return preset?.packages ?? {};
    } catch {
      return {};
    }
  }

  /**
   * 从预置标记文件加载预装包清单（私有辅助）
   * 预置模式下，预装包已在构建阶段安装到 resources/python/python-3.14.6，
   * 读取 .beez-preset 中的 packages 清单并合并到已安装列表，避免重复安装
   */
  private _loadPresetPackageList(): void {
    try {
      const markerPath = path.join(pythonManager.getPythonDir(), PRESET_MARKER_FILE);
      if (!existsSync(markerPath)) {
        return;
      }
      const raw = readFileSync(markerPath, 'utf-8');
      const preset = JSON.parse(raw) as { packages?: Record<string, string> };
      if (!preset || typeof preset !== 'object' || !preset.packages) {
        return;
      }
      const existingNames = new Set(this.installedPackages.map((p) => p.name.toLowerCase()));
      for (const [name, version] of Object.entries(preset.packages)) {
        if (!existingNames.has(name.toLowerCase())) {
          this.installedPackages.push({
            name,
            version,
            level: 'custom' as DepsLevel,
            status: 'installed' as DepsPackage['status'],
          });
          existingNames.add(name.toLowerCase());
        }
      }
    } catch (err) {
      // 读取失败不影响正常使用
      console.warn('[DepsManager] _loadPresetPackageList 读取失败（非致命）:', err);
    }
  }

  // ==============================================================
  // 公共 API
  // ==============================================================

  /**
   * pip 引导安装
   * 检查并确保 pip 环境可用，必要时自动下载安装 pip
   */
  async bootstrapPip(): Promise<void> {
    this.depsStatus = DepsStatus.CHECKING;

    const pythonPath = pythonManager.getPythonPath();
    if (!pythonPath) {
      this.depsStatus = DepsStatus.INSTALL_FAILED;
      throw new Error('Python 环境未就绪，无法引导安装 pip');
    }

    // 检测 pip 是否已可用
    const pipExists = await this._checkPip(pythonPath);
    if (pipExists) {
      this.depsStatus = DepsStatus.PIP_READY;
      return;
    }

    // pip 不存在，进入引导安装流程
    this.depsStatus = DepsStatus.BOOTSTRAPPING;

    const pythonDir = pythonManager.getPythonDir();
    const getPipPath = path.join(pythonDir, 'get-pip.py');

    try {
      // 从 bootstrap.pypa.io 下载 get-pip.py
      await this._downloadFile('https://bootstrap.pypa.io/get-pip.py', getPipPath);

      // 执行 python get-pip.py 安装 pip
      await this._runScript(pythonPath, getPipPath, pythonDir);

      // 清理安装脚本
      try { unlinkSync(getPipPath); } catch { /* ignore */ }

      // 二次验证 pip 是否安装成功
      const pipReady = await this._checkPip(pythonPath);
      if (pipReady) {
        this.depsStatus = DepsStatus.PIP_READY;
      } else {
        this.depsStatus = DepsStatus.INSTALL_FAILED;
        throw new Error('pip 引导安装后验证失败：pip 仍不可用');
      }
    } catch (err) {
      // 清理残留文件
      try { unlinkSync(getPipPath); } catch { /* ignore */ }
      if (this.depsStatus !== DepsStatus.INSTALL_FAILED) {
        this.depsStatus = DepsStatus.INSTALL_FAILED;
      }
      throw err;
    }
  }

  /**
   * 安装依赖包
   * 根据指定的安装级别和镜像源安装 Python 依赖包
   * @param params 安装参数（级别、镜像源、是否自动引导）
   */
  async installPackages(params: DepsInstallParams): Promise<DepsPackage[]> {
    const { mirrorUrl, autoBootstrap = true, customPackages } = params;
    const level: DepsLevel = 'recommended';

    // ---- 1. 前置检查：Python 就绪 ----
    const pyStatus = pythonManager.getStatus();
    if (pyStatus.state !== 'READY') {
      this.depsStatus = DepsStatus.INSTALL_FAILED;
      throw new Error('Python 环境未就绪，无法安装依赖包');
    }

    const pythonPath = pythonManager.getPythonPath();
    if (!pythonPath) {
      this.depsStatus = DepsStatus.INSTALL_FAILED;
      throw new Error('无法获取 Python 解释器路径');
    }

    // ---- 2. 前置检查：pip 就绪 ----
    const pipReady = await this._checkPip(pythonPath);
    if (!pipReady) {
      if (autoBootstrap) {
        await this.bootstrapPip();
      } else {
        this.depsStatus = DepsStatus.INSTALL_FAILED;
        throw new Error('pip 不可用且未启用自动引导安装');
      }
    }

    // ---- 3. 根据 DepsLevel 筛选 DEPS_PACKAGES ----
    const levelOrder: Record<DepsLevel, number> = { core: 0, recommended: 1, full: 2 };
    const targetLevel = levelOrder[level];
    const packages = DEPS_PACKAGES.filter(pkg => levelOrder[pkg.level] <= targetLevel);

    // 重置包状态
    for (const pkg of packages) {
      pkg.status = 'pending';
    }

    // 合并自定义依赖包（预设包在前，自定义包在后）
    if (customPackages && customPackages.length > 0) {
      const customPkgs: DepsPackage[] = customPackages.map(cp => ({
        name: cp.name,
        version: cp.version,
        level: level,
        status: 'pending' as const,
      }));
      packages.push(...customPkgs);
    }

    // ---- 4. 逐包串行安装 ----
    this._cancelRequested = false;
    this.depsStatus = DepsStatus.INSTALLING;

    const totalCount = packages.length;
    let installedCount = 0;
    let failedCount = 0;
    const failedPackages: string[] = [];

    for (let i = 0; i < packages.length; i++) {
      // 取消检查点
      if (this._cancelRequested) {
        this.depsStatus = DepsStatus.PIP_READY;
        this._emitDepsProgress({
          status: DepsStatus.CANCELLING,
          currentIndex: i,
          totalCount,
          currentPackage: packages[i].name,
          progress: 0,
          installedCount,
          failedCount,
          cancellable: false,
        });
        return [];
      }

      const pkg = packages[i];

      // 推送进度：开始安装
      this._emitDepsProgress({
        status: DepsStatus.INSTALLING,
        currentIndex: i,
        totalCount,
        currentPackage: pkg.name,
        progress: 0,
        installedCount,
        failedCount,
        cancellable: true,
      });

      try {
        const pipPackageSpec = pkg.version ? `${pkg.name}==${pkg.version}` : pkg.name;
        const installOutput = await this._executeOnePackage(
          pythonPath,
          pipPackageSpec,
          mirrorUrl,
          (progress: number) => {
            // debounce：至少间隔 200ms，但 100% 时总是推送
            const now = Date.now();
            if (progress < 100 && now - this._lastProgressEmitTime < 200) return;
            this._lastProgressEmitTime = now;
            this._emitDepsProgress({
              status: DepsStatus.INSTALLING,
              currentIndex: i,
              totalCount,
              currentPackage: pkg.name,
              progress,
              installedCount,
              failedCount,
              cancellable: true,
            });
          },
        );
        pkg.status = 'installed';
        installedCount++;

        // 提取版本号（从 stdout 中的 "Successfully installed xxx-x.y.z"）
        const versionMatch = installOutput.match(/Successfully installed\s+\S+?-([\d.]+)/);
        if (versionMatch) {
          pkg.version = versionMatch[1];
        } else {
          // fallback: 通过 pip show 获取版本号
          try {
            const pkgInfo = await this._getPackageInfo(pythonPath, pkg.name);
            if (pkgInfo?.version) {
              pkg.version = pkgInfo.version;
            }
          } catch {
            // 获取版本失败不阻塞主流程
          }
        }

        // 获取包安装目录大小
        try {
          pkg.size = await this._getPackageSize(pythonPath, pkg.name);
        } catch {
          // 获取大小失败不影响主流程
        }

        // 推送进度：当前包安装成功
        this._emitDepsProgress({
          status: DepsStatus.INSTALLING,
          currentIndex: i + 1,
          totalCount,
          currentPackage: pkg.name,
          progress: 100,
          installedCount,
          failedCount,
          cancellable: true,
        });
      } catch (err) {
        pkg.status = 'failed';
        pkg.error = err instanceof Error ? err.message : String(err);
        failedCount++;
        failedPackages.push(pkg.name);

        // 推送进度：当前包安装失败（不影响后续包）
        this._emitDepsProgress({
          status: DepsStatus.INSTALLING,
          currentIndex: i + 1,
          totalCount,
          currentPackage: pkg.name,
          progress: 0,
          installedCount,
          failedCount,
          error: pkg.error,
          cancellable: true,
        });
      }
    }

    // ---- 5. 汇总失败清单 ----
    if (failedCount > 0) {
      this.depsStatus = DepsStatus.INSTALL_FAILED;
      this._emitDepsProgress({
        status: DepsStatus.INSTALL_FAILED,
        currentIndex: totalCount,
        totalCount,
        currentPackage: '',
        progress: 100,
        installedCount,
        failedCount,
        error: `安装完成：成功 ${installedCount}，失败 ${failedCount}（${failedPackages.join(', ')}）`,
        cancellable: false,
      });
    } else {
      this.depsStatus = DepsStatus.COMPLETED;
      this.installedPackages = packages.filter(p => p.status === 'installed');
      this._saveToDb();
      this._emitDepsProgress({
        status: DepsStatus.COMPLETED,
        currentIndex: totalCount,
        totalCount,
        currentPackage: '',
        progress: 100,
        installedCount,
        failedCount,
        cancellable: false,
      });
    }

    return packages.filter(p => p.status === 'installed');
  }


  /**
   * 导出离线包
   * 将当前已安装的依赖包打包为离线 bundle
   * @returns 导出结果（包含 bundle 路径和清单）
   */
  async exportBundle(destPath?: string): Promise<DepsExportResult> {
    // 1. 检查已安装包列表非空
    if (this.installedPackages.length === 0) {
      return {
        success: false,
        error: '没有已安装的依赖包，无法导出离线包',
      };
    }

    const pythonPath = pythonManager.getPythonPath();
    if (!pythonPath) {
      return {
        success: false,
        error: 'Python 环境未就绪，无法获取版本信息',
      };
    }

    try {
      // 2. 获取 pip 版本和 Python 版本
      const [pipVersion, pythonVersion] = await Promise.all([
        this._getPipVersion(pythonPath),
        this._getPythonVersionNumber(pythonPath),
      ]);

      // 3. 计算 totalSize
      const totalSize = this.installedPackages.reduce(
        (sum, pkg) => sum + (pkg.size || 0),
        0,
      );

      // 4. 构建 manifest
      const manifest: DepsBundleManifest = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        packages: this.installedPackages,
        totalSize,
        pipVersion,
        platform: `${process.platform}-${process.arch}`,
        pythonVersion,
      };

      // 5. 创建临时目录，写入 manifest.json，打包为 ZIP
      const tmpDir = path.join(tmpdir(), `beez-deps-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });

      const manifestPath = path.join(tmpDir, 'manifest.json');
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

      const bundlePath = path.join(tmpDir, 'deps-bundle.zip');
      await this._createZipFromDir(tmpDir, bundlePath, 'manifest.json');

      // 清理临时 manifest.json（保留 ZIP）
      try { await rm(manifestPath); } catch { /* ignore */ }

      // 如果用户指定了目标路径，复制 ZIP 到目标位置
      let finalPath = bundlePath;
      if (destPath) {
        const { copyFile } = await import('node:fs/promises');
        await copyFile(bundlePath, destPath);
        finalPath = destPath;
        // 清理临时文件
        try { await rm(bundlePath); } catch { /* ignore */ }
      }

      return {
        success: true,
        bundlePath: finalPath,
        manifest,
      };
    } catch (err) {
      return {
        success: false,
        error: `导出离线包失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 导入离线包
   * 从指定的 bundle 文件导入依赖包清单并进行校验
   * @param bundlePath bundle 文件路径
   * @returns 导入校验结果
   */
  async importBundle(bundlePath: string): Promise<DepsImportResult> {
    // 1. 检查文件是否存在
    try {
      await stat(bundlePath);
    } catch {
      return {
        valid: false,
        error: `bundle 文件不存在: ${bundlePath}`,
      };
    }

    try {
      // 2. 解压 ZIP 读取 manifest.json
      const manifestJson = await this._readZipEntry(bundlePath, 'manifest.json');
      if (manifestJson === null) {
        return {
          valid: false,
          error: 'bundle 中未找到 manifest.json',
        };
      }

      // 3. 解析 manifest
      let manifest: DepsBundleManifest;
      try {
        manifest = JSON.parse(manifestJson);
      } catch {
        return {
          valid: false,
          error: 'manifest.json 格式无效，无法解析为 JSON',
        };
      }

      // 4. 校验 manifest 字段完整性（version / packages / platform）
      const requiredFields: (keyof DepsBundleManifest)[] = [
        'version', 'exportedAt', 'packages', 'totalSize',
        'pipVersion', 'platform', 'pythonVersion',
      ];
      for (const field of requiredFields) {
        if (manifest[field] === undefined || manifest[field] === null) {
          return {
            valid: false,
            error: `manifest.json 缺少必要字段: ${field}`,
          };
        }
      }

      // 5. 校验 packages 为数组
      if (!Array.isArray(manifest.packages)) {
        return {
          valid: false,
          error: 'manifest.json 中 packages 字段必须是数组',
        };
      }

      return {
        valid: true,
        manifest,
        preview: manifest.packages,
      };
    } catch (err) {
      return {
        valid: false,
        error: `导入离线包失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 取消安装
   * 取消当前正在进行的安装操作
   */
  async cancelInstall(): Promise<void> {
    this._cancelRequested = true;

    // 终止正在运行的子进程
    const child = this._currentProcess;
    if (child && child.exitCode === null && !child.killed) {
      const pid = child.pid;
      // Windows: taskkill /T /F 确保整个进程树终止
      if (process.platform === 'win32' && pid !== undefined) {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {
          // fire-and-forget，忽略回调结果
        });
      }
      try {
        child.kill('SIGTERM');
      } catch {
        // 忽略 kill 失败（进程可能已自然退出）
      }
      this._currentProcess = null;
    }

    this.depsStatus = DepsStatus.PIP_READY;
  }


  /**
   * 获取当前状态
   * @returns 当前依赖管理状态
   */
  getStatus(): DepsStatus {
    return this.depsStatus;
  }

  /**
   * 获取已安装包列表
   * @returns 已安装的依赖包列表
   */
  getInstalledPackages(): DepsPackage[] {
    this._restoreIfNeeded();
    return this.installedPackages;
  }

  /**
   * 自动安装 14 个 recommended 依赖包
   * 在 PythonManager pip 安装完成后通过回调调用
   * 利用 pip install 天然幂等性（已安装自动跳过）
   * ★ 预检查：安装循环前先通过 pip list --format=json 检查已安装包，跳过已安装的包
   *   预置包完整场景下，14 个 recommended 包均已预装 → 直接返回 COMPLETED
   * 单个包安装超时 180 秒，失败不中断继续安装剩余包
   * 全部完成后调用 refreshInstalledPackages() 更新 SQLite
   */
  async autoInstallRecommended(): Promise<void> {
    const pythonPath = pythonManager.getPythonPath();
    if (!pythonPath) {
      throw new Error('Python 环境未就绪，无法安装依赖包');
    }

    // pip 就绪检查
    const pipReady = await this._checkPip(pythonPath);
    if (!pipReady) {
      throw new Error('pip 不可用，无法安装依赖包');
    }

    // 筛选 recommended 级别包（core + recommended = 23 包）
    const levelOrder: Record<DepsLevel, number> = { core: 0, recommended: 1, full: 2 };
    const recommendedPackages = DEPS_PACKAGES.filter(
      pkg => levelOrder[pkg.level] <= levelOrder['recommended']
    );

    // ★ 预检查：通过 pip list --format=json 检查已安装包，跳过已安装的包
    const installedNames = await this._getInstalledPackageNames(pythonPath);
    const pendingPackages = recommendedPackages.filter(
      pkg => !installedNames.has(pkg.name.toLowerCase())
    );

    // 预置包完整场景：所有 recommended 包均已安装 → 跳过安装，直接返回 COMPLETED
    if (pendingPackages.length === 0) {
      for (const pkg of recommendedPackages) {
        pkg.status = 'installed';
      }
      this.installedPackages = recommendedPackages.filter(p => p.status === 'installed');
      this.depsStatus = DepsStatus.COMPLETED;
      this._saveToDb();
      try {
        await this.refreshInstalledPackages();
      } catch {
        // 刷新失败不影响主流程
      }
      console.warn('[DepsManager] autoInstallRecommended 预检查: 所有 recommended 包已安装，跳过安装');
      return;
    }

    const totalCount = pendingPackages.length;
    let installedCount = 0;
    let failedCount = 0;

    this._cancelRequested = false;
    this.depsStatus = DepsStatus.INSTALLING;

    for (let i = 0; i < pendingPackages.length; i++) {
      if (this._cancelRequested) break;

      const pkg = pendingPackages[i];

      this._emitDepsProgress({
        status: DepsStatus.INSTALLING,
        currentIndex: i,
        totalCount,
        currentPackage: pkg.name,
        progress: 0,
        installedCount,
        failedCount,
        cancellable: false,
      });

      try {
        await this._executeOnePackage(pythonPath, pkg.name);
        pkg.status = 'installed';
        installedCount++;

        this._emitDepsProgress({
          status: DepsStatus.INSTALLING,
          currentIndex: i + 1,
          totalCount,
          currentPackage: pkg.name,
          progress: 100,
          installedCount,
          failedCount,
          cancellable: false,
        });
      } catch (err) {
        pkg.status = 'failed';
        pkg.error = err instanceof Error ? err.message : String(err);
        failedCount++;

        this._emitDepsProgress({
          status: DepsStatus.INSTALLING,
          currentIndex: i + 1,
          totalCount,
          currentPackage: pkg.name,
          progress: 0,
          installedCount,
          failedCount,
          error: pkg.error,
          cancellable: false,
        });
      }
    }

    // 已预装的包标记为 installed（确保已安装清单完整）
    for (const pkg of recommendedPackages) {
      if (pkg.status === 'pending') {
        pkg.status = 'installed';
      }
    }

    // 完成后更新状态
    if (failedCount > 0) {
      this.depsStatus = DepsStatus.INSTALL_FAILED;
    } else {
      this.depsStatus = DepsStatus.COMPLETED;
      // 更新已安装包列表
      this.installedPackages = recommendedPackages.filter(p => p.status === 'installed');
      this._saveToDb();
    }

    // 刷新 SQLite 持久化
    try {
      await this.refreshInstalledPackages();
    } catch {
      // 刷新失败不影响主流程
    }

    console.warn(
      `[DepsManager] autoInstallRecommended 完成: 成功 ${installedCount}/${totalCount}, 失败 ${failedCount}`
    );
  }

  /**
   * 刷新已安装包列表
   * 对比 pip list 输出与 SQLite 中已存储数据的 SHA256 哈希值
   * 仅在哈希不一致时更新 SQLite，避免不必要的写入
   * @returns 是否有变更（true = 有变更/SQLite已更新）
   */
  async refreshInstalledPackages(): Promise<boolean> {
    // 1. 获取当前 pip list 原始输出
    const currentRaw = await this._getPipListJson();

    // 2. pip 命令失败 → 保持已有数据不变
    if (!currentRaw) {
      console.warn('[DepsManager] refreshInstalledPackages: pip list 执行失败，跳过本次刷新');
      return false;
    }

    // 3. 写入 depsStorage（内部做 SHA256 对比）
    const written = depsStorage.writeInstalledPackages(currentRaw);

    if (written) {
      // 内容有变化：解析并更新内存中的 installedPackages
      try {
        const pipPkgs: Array<{ name: string; version: string }> = JSON.parse(currentRaw);
        this.installedPackages = pipPkgs.map((pkg: { name: string; version: string }) => ({
          name: pkg.name,
          version: pkg.version,
          level: 'custom' as DepsLevel,
          status: 'installed' as DepsPackage['status'],
        }));
      } catch (jsonErr) {
        console.warn('[DepsManager] refreshInstalledPackages: currentRaw 不是合法 JSON', jsonErr);
        return false;
      }
    } else {
      // 内容无变化：仅在内存中尚未加载时从 depsStorage 读取
      if (this.installedPackages.length === 0) {
        const pipPkgs = depsStorage.readInstalledPackages();
        this.installedPackages = pipPkgs.map((pkg: { name: string; version: string }) => ({
          name: pkg.name,
          version: pkg.version,
          level: 'custom' as DepsLevel,
          status: 'installed' as DepsPackage['status'],
        }));
      }
    }

    return written;
  }

  // ==============================================================
  // SQLite 持久化辅助方法
  // ==============================================================

  /**
   * 从 SQLite 恢复已安装依赖包列表（懒初始化，首次 getInstalledPackages 时触发）
   */
  private _restoreIfNeeded(): void {
    if (this._dbRestored) return;
    this._dbRestored = true;
    try {
      const pipPkgs = depsStorage.readInstalledPackages();
      this.installedPackages = pipPkgs.map((pkg: { name: string; version: string }) => ({
        name: pkg.name,
        version: pkg.version,
        level: 'custom' as DepsLevel,
        status: 'installed' as DepsPackage['status'],
      }));
    } catch {
      // 恢复失败不影响正常使用，保持空列表
    }
  }

  /**
   * 持久化已安装依赖包列表到 SQLite
   */
  private _saveToDb(): void {
    try {
      depsStorage.writeInstalledPackages(JSON.stringify(this.installedPackages));
    } catch {
      // 持久化失败不影响正常使用
    }
  }

  // ==============================================================
  // 私有辅助方法
  // ==============================================================

  /**
   * 检测 pip 是否可用
   * 执行 python -m pip --version 并根据输出判断
   */

  /**
   * 计算字符串的 SHA256 哈希值（hex 格式）
   * 使用 Node.js 内置 crypto 模块，零 npm 依赖
   * @param content 待哈希的字符串内容
   * @returns 十六进制哈希字符串；若输入为 null/undefined 则返回空字符串
   */
  private _computeHash(content: string): string {
    if (content === null || content === undefined) return '';
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  /**
   * 获取当前已安装的包名集合（小写）
   * 通过 pip list --format=json 获取，用于 autoInstallRecommended 预检查跳过已安装包
   * @param pythonPath Python 解释器路径
   * @returns 已安装包名（小写）集合；pip list 失败时返回空集合
   */
  private async _getInstalledPackageNames(pythonPath: string): Promise<Set<string>> {
    const names = new Set<string>();
    const raw = await this._getPipListJson();
    if (!raw) {
      return names;
    }
    try {
      const pipPkgs: Array<{ name: string; version: string }> = JSON.parse(raw);
      for (const pkg of pipPkgs) {
        names.add(pkg.name.toLowerCase());
      }
    } catch {
      // 解析失败返回空集合（后续按全部待安装处理）
    }
    return names;
  }

  /**
   * 获取 pip list 原始 JSON 输出字符串
   * 执行 pip list --format=json 并返回原始 stdout（不经过 JSON.parse）
   * @returns pip list 输出的原始 JSON 字符串；失败时返回空字符串
   */
  private _getPipListJson(): Promise<string> {
    const pythonPath = pythonManager.getPythonPath();
    if (!pythonPath) {
      console.warn('[DepsManager] _getPipListJson: Python 环境未就绪');
      return Promise.resolve('');
    }

    return new Promise<string>((resolve) => {
      execFile(
        pythonPath,
        ['-m', 'pip', 'list', '--format=json'],
        { timeout: 30_000 },
        (err, stdout) => {
          if (err) {
            console.warn('[DepsManager] _getPipListJson: pip list 执行失败', err.message);
            resolve('');
            return;
          }
          resolve(stdout.trim());
        },
      );
    });
  }

  private _checkPip(pythonPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(pythonPath, ['-m', 'pip', '--version'], { timeout: 15000 }, (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        // pip 20+ 版本输出格式: pip X.Y.Z from ... (python X.Y)
        resolve(stdout.trim().startsWith('pip '));
      });
    });
  }

  /**
   * 通过 HTTPS 下载文件到指定路径
   * 复用 python-manager._downloadFile 的 https.get + pipeline 模式
   */
  private _downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const doRequest = (requestUrl: string, redirectCount: number): void => {
        if (redirectCount > 10) {
          reject(new Error('重定向次数过多'));
          return;
        }

        const req = get(requestUrl, { timeout: 60000 }, (res: IncomingMessage) => {
          // 处理 HTTP 重定向
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            doRequest(res.headers.location, redirectCount + 1);
            return;
          }

          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          const fileStream = createWriteStream(destPath);
          pipeline(res, fileStream)
            .then(() => resolve())
            .catch(reject);
        });

        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('下载超时'));
        });
        req.end();
      };

      doRequest(url, 0);
    });
  }

  /**
   * 执行 Python 脚本
   * 复用 python-manager._runCommand 的 execFile 模式
   */
  private _runScript(pythonPath: string, scriptPath: string, cwd: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      execFile(pythonPath, [scriptPath], { cwd, timeout: 120000 }, (err, _stdout, stderr) => {
        if (err) {
          const errMsg = stderr || err.message || String(err);
          reject(new Error(`执行 ${scriptPath} 失败: ${errMsg}`));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * 执行单包 pip install
   * 使用 spawn 模式，与 python-manager._runCommand 一致
   * @param pythonPath Python 解释器路径
   * @param packageName pip 包名称
   * @param mirrorUrl 可选镜像源 URL
   * @param onProgress 可选进度回调 (0-100)
   * @returns stdout 输出（包含 "Successfully installed" 等安装信息）
   */
  private _executeOnePackage(
    pythonPath: string,
    packageName: string,
    mirrorUrl?: string,
    onProgress?: (progress: number) => void,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const args = ['-m', 'pip', 'install', '--progress-bar', 'on', packageName];
      if (mirrorUrl) {
        args.push('-i', mirrorUrl);
      }

      const child = spawn(pythonPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this._currentProcess = child;

      let stderr = '';
      let stdoutText = '';
      let lastProgress = -1;

      // 解析 pip 输出中的下载进度行
      const parseAndReport = (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;

        if (onProgress) {
          for (const line of text.split('\n')) {
            const pct = this._parseProgressFromLine(line);
            if (pct !== null && pct !== lastProgress) {
              lastProgress = pct;
              onProgress(pct);
            }
          }
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutText += text;
        // stdout 偶尔也可能包含进度信息
        if (onProgress) {
          for (const line of text.split('\n')) {
            const pct = this._parseProgressFromLine(line);
            if (pct !== null && pct !== lastProgress) {
              lastProgress = pct;
              onProgress(pct);
            }
          }
        }
      });

      child.stderr.on('data', parseAndReport);

      child.once('error', (err) => {
        this._currentProcess = null;
        reject(err);
      });
      child.once('close', (code) => {
        this._currentProcess = null;
        if (code === 0) {
          resolve(stdoutText);
        } else {
          reject(new Error(
            `pip install ${packageName} 退出码 ${code}: ${stderr.trim()}`,
          ));
        }
      });
    });
  }

  /**
   * 推送依赖安装进度到渲染进程
   * 复用 python-manager.ts emitStatus() 的窗口获取+销毁检查模式
   */
  private _emitDepsProgress(progress: DepsInstallProgress): void {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_DEPS.PROGRESS, progress);
    }
  }

  /**
   * 从 pip 输出行中解析下载进度百分比
   * 匹配格式如 "   ━━━━━━ 5.2/15.6 MB ..." 或 " 1.2/15.6 MB"
   * @param line pip 输出的一行文本
   * @returns 0-100 的百分比，无法解析返回 null
   */
  private _parseProgressFromLine(line: string): number | null {
    // 匹配 "X.X/Y.Y MB" 或 "X/Y MB" 或 "X.X/Y.Y KB" 等格式
    const match = line.match(/(\d+\.?\d*)\s*\/\s*(\d+\.?\d*)\s*(MB|KB|GB|B)/i);
    if (!match) return null;

    const current = parseFloat(match[1]);
    const total = parseFloat(match[2]);
    if (total <= 0) return null;

    const pct = Math.round((current / total) * 100);
    return Math.min(100, Math.max(0, pct));
  }

  /**
   * 获取已安装包在 site-packages 中的目录总大小
   * 通过 pip show 获取 Location，然后递归计算目录大小
   * @param pythonPath Python 解释器路径
   * @param packageName pip 包名称
   * @returns 目录总大小（字节）
   */
  private async _getPackageSize(
    pythonPath: string,
    packageName: string,
  ): Promise<number> {
    const info = await this._getPackageInfo(pythonPath, packageName);
    if (!info || !info.location) return 0;

    // pip 包目录通常在 site-packages 下以包名命名
    // 例如 numpy -> .../site-packages/numpy
    const pkgDir = path.join(info.location, packageName);
    try {
      await stat(pkgDir);
      return await this._getDirSize(pkgDir);
    } catch {
      // 包目录可能带下划线或不同命名（如 python-dotenv -> dotenv）
      // 尝试常见变换
      const altName = packageName.replace(/-/g, '_');
      if (altName !== packageName) {
        const altDir = path.join(info.location, altName);
        try {
          await stat(altDir);
          return await this._getDirSize(altDir);
        } catch {
          return 0;
        }
      }
      return 0;
    }
  }

  /**
   * 通过 pip show 获取包的版本和安装位置
   * @param pythonPath Python 解释器路径
   * @param packageName pip 包名称
   * @returns { version, location } 或 null
   */
  private _getPackageInfo(
    pythonPath: string,
    packageName: string,
  ): Promise<{ version: string; location: string } | null> {
    return new Promise((resolve) => {
      execFile(
        pythonPath,
        ['-m', 'pip', 'show', packageName],
        { timeout: 15000 },
        (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          const versionMatch = stdout.match(/^Version:\s*(.+)$/m);
          const locationMatch = stdout.match(/^Location:\s*(.+)$/m);
          resolve({
            version: versionMatch ? versionMatch[1].trim() : '',
            location: locationMatch ? locationMatch[1].trim() : '',
          });
        },
      );
    });
  }

  /**
   * 递归计算目录下所有文件的总大小
   * @param dirPath 目录路径
   * @returns 总大小（字节）
   */
  private async _getDirSize(dirPath: string): Promise<number> {
    let totalSize = 0;
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += await this._getDirSize(fullPath);
      } else if (entry.isFile()) {
        const fileStat = await stat(fullPath);
        totalSize += fileStat.size;
      }
    }
    return totalSize;
  }

  // ==============================================================
  // 离线包导出/导入辅助方法
  // ==============================================================

  /** CRC32 查找表（惰性初始化） */
  private static _crc32Table: Uint32Array | null = null;

  private static _getCRC32Table(): Uint32Array {
    if (DepsManager._crc32Table) return DepsManager._crc32Table;
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
    DepsManager._crc32Table = table;
    return table;
  }

  private static _crc32(data: Buffer): number {
    const table = DepsManager._getCRC32Table();
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * 获取 pip 版本号
   * 执行 python -m pip --version 并解析 "pip X.Y.Z" 格式
   */
  private _getPipVersion(pythonPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        pythonPath,
        ['-m', 'pip', '--version'],
        { timeout: 15000 },
        (err, stdout) => {
          if (err) {
            reject(new Error(`获取 pip 版本失败: ${err.message}`));
            return;
          }
          const match = stdout.trim().match(/^pip\s+([\d.]+)/);
          resolve(match ? match[1] : 'unknown');
        },
      );
    });
  }

  /**
   * 获取 Python 版本号
   * 执行 python --version 并解析 "Python X.Y.Z" 格式
   */
  private _getPythonVersionNumber(pythonPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        pythonPath,
        ['--version'],
        { timeout: 15000 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`获取 Python 版本失败: ${err.message}`));
            return;
          }
          const output = (stdout || stderr || '').trim();
          const match = output.match(/Python\s+([\d.]+)/i);
          resolve(match ? match[1] : output || 'unknown');
        },
      );
    });
  }

  /**
   * 使用纯 Node.js 构建 ZIP 文件
   * 将指定目录下的文件打包为 ZIP（store 方法，无压缩）
   */
  private async _createZipFromDir(
    dirPath: string,
    zipPath: string,
    ...filenames: string[]
  ): Promise<void> {
    const fileBuffers: { name: string; data: Buffer }[] = [];

    for (const filename of filenames) {
      const filePath = path.join(dirPath, filename);
      const data = await readFile(filePath);
      fileBuffers.push({ name: filename, data });
    }

    const zipBuffer = DepsManager._buildZipBuffer(fileBuffers);
    await writeFile(zipPath, zipBuffer);
  }

  /**
   * 构建 ZIP 文件二进制内容
   * 手动构造 local file headers + data + central directory + EOCD
   */
  private static _buildZipBuffer(
    files: { name: string; data: Buffer }[],
  ): Buffer {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;

    // DOS 日期时间（1980-01-01 00:00:00 的等价表示）
    const dosTime = 0;
    const dosDate = 0x0021; // 1980-01-01

    for (const file of files) {
      const nameBuffer = Buffer.from(file.name, 'utf-8');
      const crc = DepsManager._crc32(file.data);
      // store 方法，无压缩
      const compressed = file.data;
      const compressedSize = compressed.length;
      const uncompressedSize = file.data.length;
      const nameLength = nameBuffer.length;

      // ---- Local file header (30 bytes + filename) ----
      const localHeader = Buffer.alloc(30 + nameLength);
      localHeader.writeUInt32LE(0x04034b50, 0);          // signature
      localHeader.writeUInt16LE(20, 4);                   // version needed (2.0)
      localHeader.writeUInt16LE(0x0800, 6);               // general purpose bit flag (UTF-8)
      localHeader.writeUInt16LE(0, 8);                    // compression method (store)
      localHeader.writeUInt16LE(dosTime, 10);             // last mod file time
      localHeader.writeUInt16LE(dosDate, 12);             // last mod file date
      localHeader.writeUInt32LE(crc, 14);                 // crc-32
      localHeader.writeUInt32LE(compressedSize, 18);      // compressed size
      localHeader.writeUInt32LE(uncompressedSize, 22);    // uncompressed size
      localHeader.writeUInt16LE(nameLength, 26);          // file name length
      localHeader.writeUInt16LE(0, 28);                   // extra field length
      nameBuffer.copy(localHeader, 30);

      localParts.push(localHeader);
      localParts.push(compressed);

      // ---- Central directory header (46 bytes + filename) ----
      const centralHeader = Buffer.alloc(46 + nameLength);
      centralHeader.writeUInt32LE(0x02014b50, 0);         // signature
      centralHeader.writeUInt16LE(20, 4);                  // version made by (2.0)
      centralHeader.writeUInt16LE(20, 6);                  // version needed (2.0)
      centralHeader.writeUInt16LE(0x0800, 8);              // general purpose bit flag
      centralHeader.writeUInt16LE(0, 10);                  // compression method
      centralHeader.writeUInt16LE(dosTime, 12);            // last mod file time
      centralHeader.writeUInt16LE(dosDate, 14);            // last mod file date
      centralHeader.writeUInt32LE(crc, 16);                // crc-32
      centralHeader.writeUInt32LE(compressedSize, 20);     // compressed size
      centralHeader.writeUInt32LE(uncompressedSize, 24);   // uncompressed size
      centralHeader.writeUInt16LE(nameLength, 28);         // file name length
      centralHeader.writeUInt16LE(0, 30);                  // extra field length
      centralHeader.writeUInt16LE(0, 32);                  // file comment length
      centralHeader.writeUInt16LE(0, 34);                  // disk number start
      centralHeader.writeUInt16LE(0, 36);                  // internal file attributes
      centralHeader.writeUInt32LE(0, 38);                  // external file attributes
      centralHeader.writeUInt32LE(offset, 42);             // relative offset of local header
      nameBuffer.copy(centralHeader, 46);

      centralParts.push(centralHeader);
      offset += localHeader.length + compressed.length;
    }

    // ---- End of central directory record (22 bytes) ----
    const centralOffset = offset;
    const centralSize = centralParts.reduce((s, b) => s + b.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);                    // signature
    eocd.writeUInt16LE(0, 4);                              // disk number
    eocd.writeUInt16LE(0, 6);                              // disk with central directory
    eocd.writeUInt16LE(files.length, 8);                   // entries on this disk
    eocd.writeUInt16LE(files.length, 10);                  // total entries
    eocd.writeUInt32LE(centralSize, 12);                   // central directory size
    eocd.writeUInt32LE(centralOffset, 16);                 // central directory offset
    eocd.writeUInt16LE(0, 20);                             // comment length

    return Buffer.concat([...localParts, ...centralParts, eocd]);
  }

  /**
   * 从 ZIP 文件中读取指定条目的内容
   * 纯 Node.js 实现，支持 store 方法
   * @returns 条目内容字符串，未找到返回 null
   */
  private async _readZipEntry(
    zipPath: string,
    entryName: string,
  ): Promise<string | null> {
    const zipData = await readFile(zipPath);

    // 从末尾向前搜索 EOCD 签名 0x06054b50
    let eocdOffset = -1;
    const searchStart = Math.max(0, zipData.length - 65557);
    for (let i = zipData.length - 22; i >= searchStart; i--) {
      if (zipData.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }

    if (eocdOffset < 0) return null;

    const totalEntries = zipData.readUInt16LE(eocdOffset + 10);
    const centralDirOffset = zipData.readUInt32LE(eocdOffset + 16);

    // 遍历 central directory entries
    let pos = centralDirOffset;
    for (let i = 0; i < totalEntries; i++) {
      if (zipData.readUInt32LE(pos) !== 0x02014b50) break;

      const nameLength = zipData.readUInt16LE(pos + 28);
      const extraLength = zipData.readUInt16LE(pos + 30);
      const commentLength = zipData.readUInt16LE(pos + 32);
      const localOffset = zipData.readUInt32LE(pos + 42);

      const name = zipData.toString('utf-8', pos + 46, pos + 46 + nameLength);

      if (name === entryName) {
        // 读取 local file header
        const localNameLength = zipData.readUInt16LE(localOffset + 26);
        const localExtraLength = zipData.readUInt16LE(localOffset + 28);
        const compressionMethod = zipData.readUInt16LE(localOffset + 8);
        const compressedSize = zipData.readUInt32LE(localOffset + 18);

        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const rawData = zipData.subarray(dataStart, dataStart + compressedSize);

        if (compressionMethod === 0) {
          // store 方法，直接返回
          return rawData.toString('utf-8');
        }

        // 其他压缩方法不支持
        return null;
      }

      pos += 46 + nameLength + extraLength + commentLength;
    }

    return null;
  }


  /**
   * 解析导入文件（.txt / .zip），对比已安装列表进行分类
   * @param filePath 导入文件路径（.txt 或 .zip）
   * @returns 解析结果，包含 already_installed / pending_install / parse_failed 分类
   */
  async parseImportFile(filePath: string): Promise<ParsedImportResult> {
    const ext = path.extname(filePath).toLowerCase();

    // 1. 从文件中提取候选包列表
    let candidates: Array<{ name: string; version?: string }> = [];

    try {
      if (ext === '.txt') {
        // .txt 文件：逐行解析（支持 name==version 格式）
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          // 支持 name==version 和 name 两种格式
          const eqIdx = trimmed.indexOf('==');
          if (eqIdx > 0) {
            candidates.push({
              name: trimmed.substring(0, eqIdx).trim(),
              version: trimmed.substring(eqIdx + 2).trim(),
            });
          } else {
            // 纯包名（无版本）
            candidates.push({ name: trimmed });
          }
        }
      } else if (ext === '.zip') {
        // .zip 文件：解压 manifest.json，解析 packages[]
        const manifestJson = await this._readZipEntry(filePath, 'manifest.json');
        if (!manifestJson) {
          return {
            success: false,
            packages: [],
            summary: { total: 0, alreadyInstalled: 0, pendingInstall: 0, parseFailed: 0 },
            error: 'ZIP 文件中未找到 manifest.json',
          };
        }
        const manifest = JSON.parse(manifestJson);
        const pkgs = manifest.packages;
        if (!Array.isArray(pkgs)) {
          return {
            success: false,
            packages: [],
            summary: { total: 0, alreadyInstalled: 0, pendingInstall: 0, parseFailed: 0 },
            error: 'manifest.json 中 packages 字段不是数组',
          };
        }
        for (const pkg of pkgs) {
          if (typeof pkg.name === 'string' && pkg.name.trim()) {
            candidates.push({
              name: pkg.name.trim(),
              version: typeof pkg.version === 'string' ? pkg.version : undefined,
            });
          }
        }
      } else {
        return {
          success: false,
          packages: [],
          summary: { total: 0, alreadyInstalled: 0, pendingInstall: 0, parseFailed: 0 },
          error: `不支持的文件格式: ${ext}（仅支持 .txt 和 .zip）`,
        };
      }
    } catch (err) {
      return {
        success: false,
        packages: [],
        summary: { total: 0, alreadyInstalled: 0, pendingInstall: 0, parseFailed: 0 },
        error: `读取/解析文件失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 2. 获取已安装包列表（pip list）
    let installedMap: Map<string, string> = new Map();
    try {
      const raw = await this._getPipListJson();
      if (raw) {
        const installedList: Array<{ name: string; version: string }> = JSON.parse(raw);
        for (const pkg of installedList) {
          installedMap.set(pkg.name.toLowerCase(), pkg.version);
        }
      }
    } catch {
      // pip list 失败 → 所有包标记为 pending_install
    }

    // 3. 分类：对比已安装列表
    const results: ImportPackageItem[] = [];
    let alreadyInstalled = 0;
    let pendingInstall = 0;
    let parseFailed = 0;

    for (const candidate of candidates) {
      const pkgName = candidate.name;
      if (!pkgName || !/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(pkgName)) {
        // 包名格式不合法
        results.push({
          name: pkgName || '(空)',
          requiredVersion: candidate.version,
          status: 'parse_failed',
          error: '包名格式不合法',
        });
        parseFailed++;
        continue;
      }

      const installedVersion = installedMap.get(pkgName.toLowerCase());

      if (installedVersion !== undefined) {
        // 已安装：检查版本是否匹配
        if (!candidate.version || candidate.version === installedVersion) {
          // 版本匹配或无版本要求 → already_installed
          results.push({
            name: pkgName,
            requiredVersion: candidate.version,
            installedVersion,
            status: 'already_installed',
          });
          alreadyInstalled++;
        } else {
          // 版本不匹配 → pending_install
          results.push({
            name: pkgName,
            requiredVersion: candidate.version,
            installedVersion,
            status: 'pending_install',
          });
          pendingInstall++;
        }
      } else {
        // 未安装 → pending_install
        results.push({
          name: pkgName,
          requiredVersion: candidate.version,
          status: 'pending_install',
        });
        pendingInstall++;
      }
    }

    return {
      success: true,
      packages: results,
      summary: {
        total: results.length,
        alreadyInstalled,
        pendingInstall,
        parseFailed,
      },
    };
  }

}
