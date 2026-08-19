/**
 * Python 内置环境管理器
 * 自动检测系统 Python → 必要时下载 embeddable 包 → 配置 _pth 文件
 * 单例模式，状态机驱动，异步非阻塞
 */

import { app, BrowserWindow, dialog } from 'electron';
import { spawn, execFile } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { IncomingMessage } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { IPC_PYTHON } from '@shared/ipc-channels';
import type { SystemPythonInfo } from '../../types/python';
export type { SystemPythonInfo };

// ================================================================
// 常量
// ================================================================

const PYTHON_VERSION = '3.14.6';
// 新增：预置Python标识文件
const PRESET_MARKER_FILE = '.beez-preset';
const PYTHON_SHORT_VERSION = '3.14';
const PYTHON_EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-${process.arch === 'arm64' ? 'arm64' : 'amd64'}.zip`;
const PYTHON_DIR_NAME = `python-${PYTHON_VERSION}`;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const DOWNLOAD_TIMEOUT_MS = 120_000;

// ================================================================
// 类型
// ================================================================

export enum PythonState {
  DETECTING = 'DETECTING',
  DOWNLOADING = 'DOWNLOADING',
  EXTRACTING = 'EXTRACTING',
  INSTALLING_PIP = 'INSTALLING_PIP',
  INSTALLING_DEPS = 'INSTALLING_DEPS',
  READY = 'READY',
  FAILED = 'FAILED',
  CANCELLED_PHASE1 = 'CANCELLED_PHASE1',
  CANCELLED_PHASE2 = 'CANCELLED_PHASE2',
}

export interface PythonStatus {
  state: PythonState;
  progress?: number;   // 0-100，仅 DOWNLOADING 时有意义
  error?: string;       // FAILED 时的错误信息
  pythonPath?: string;  // READY 时的 Python 路径
}

type StatusCallback = (status: PythonStatus) => void;

// ================================================================
// PythonManager
// ================================================================

export class PythonManager {
  private static instance: PythonManager | null = null;
  private state: PythonState = PythonState.DETECTING;
  private progress = 0;
  private errorMessage = '';
  private pythonPath = '';
  private listeners: StatusCallback[] = [];
  private initPromise: Promise<void> | null = null;
  /** 下载取消控制器（M7：支持取消下载） */
  private _downloadAbortController: AbortController | null = null;
  /** 依赖安装回调（由 DepsManager 在模块初始化时通过 setDepsInstallCallback 注入） */
  private _depsInstallCallback: (() => Promise<void>) | null = null;

  /**
   * ★ 竞态修复：渲染进程就绪门控。
   * 启动期 pythonManager.init() 早于渲染进程 preload 隔离世界初始化（ipcNative 注入）完成，
   * 此时 webContents.send 会在 C++ 层触发
   * "ERROR: Attempted to get the 'ipcNative' object but it was missing" 且该次推送丢失。
   * 故未就绪期间仅缓存最新状态，待渲染进程 did-finish-load 后补推。
   */
  private _rendererReady = false;
  /** 就绪前缓存的最新状态（latest-wins）：每次未就绪 emitStatus 均覆盖，就绪后仅补推一次 */
  private _pendingStatusForRenderer: PythonStatus | null = null;

  static getInstance(): PythonManager {
    if (!PythonManager.instance) {
      PythonManager.instance = new PythonManager();
    }
    return PythonManager.instance;
  }

  private constructor() {}

  // ==============================================================
  // 公共 API
  // ==============================================================

  async init(): Promise<void> {
    // 幂等：已就绪则直接返回
    if (this.state === PythonState.READY) {
      return;
    }
    // FAILED 状态允许重试：清除错误信息后继续初始化流程
    if (this.state === PythonState.FAILED) {
      this.errorMessage = '';
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._doInit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  getPythonPath(): string {
    return this.pythonPath;
  }

  getStatus(): PythonStatus {
    // ★ 惰性快速检测：若 init() 从未被调用（initPromise 为 null）且状态仍为初始 DETECTING，
    //    则同步检查内置 Python 是否已安装，避免前端永久卡在"正在检测中..."
    //    场景 A: Python 已安装 → 直接切换为 READY
    //    场景 B: Python 未安装 → 切换为 FAILED（前端会正确显示下载按钮）
    if (this.state === PythonState.DETECTING && this.initPromise === null) {
      const builtinPath = this.getPythonExePath();
      if (existsSync(builtinPath)) {
        this.pythonPath = builtinPath;
        this.state = PythonState.READY;
      } else {
        this.errorMessage = '内置 Python 尚未安装，请点击下方按钮下载安装';
        this.state = PythonState.FAILED;
      }
      this.emitStatus();
    }

    return {
      state: this.state,
      progress: this.state === PythonState.DOWNLOADING ? this.progress : undefined,
      error: (
        this.state === PythonState.FAILED ||
        this.state === PythonState.CANCELLED_PHASE1 ||
        this.state === PythonState.CANCELLED_PHASE2
      ) ? this.errorMessage : undefined,
      pythonPath: (
        this.state === PythonState.READY ||
        this.state === PythonState.INSTALLING_PIP ||
        this.state === PythonState.INSTALLING_DEPS ||
        this.state === PythonState.CANCELLED_PHASE2
      ) ? this.pythonPath : undefined,
    };
  }
  async detectSystemPython(): Promise<SystemPythonInfo> {
    const pythonPath = await this._detectSystemPython();
    if (!pythonPath) {
      return { found: false };
    }
    const version = await this._getPythonVersion(pythonPath);
    if (!version) {
      return {
        found: true,
        pythonPath,
        error: '无法获取 Python 版本信息',
      };
    }
    return {
      found: true,
      pythonPath,
      version,
    };
  }

  async selectCustomPythonPath(): Promise<SystemPythonInfo> {
    const result = await dialog.showOpenDialog({
      title: '选择 Python 解释器',
      filters: process.platform === 'win32'
        ? [{ name: 'Python', extensions: ['exe'] }]
        : [],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { found: false };
    }

    const selectedPath = result.filePaths[0];
    const version = await this._getPythonVersion(selectedPath);
    if (!version) {
      return {
        found: true,
        pythonPath: selectedPath,
        error: '无法获取 Python 版本信息',
      };
    }
    return {
      found: true,
      pythonPath: selectedPath,
      version,
    };
  }

  async downloadBuiltinPython(): Promise<void> {
    if (this.state === PythonState.READY) {
      return;
    }
    this.errorMessage = '';
    this.progress = 0;
    this.initPromise = null;
    // M7: 创建新的 AbortController 以支持取消下载
    this._downloadAbortController = new AbortController();
    try {
      await this._downloadAndExtract();
    } finally {
      this._downloadAbortController = null;
    }
  }


  /**
   * v2.0: 两阶段取消安装
   * - 阶段一（Python运行时+pip）：DOWNLOADING/EXTRACTING/INSTALLING_PIP → CANCELLED_PHASE1（Python不可用）
   * - 阶段二（推荐依赖包）：INSTALLING_DEPS → CANCELLED_PHASE2（Python可用，依赖不完整）
   * 使用 AbortController 实现取消逻辑
   */
  cancel(): void {
    // 取消活跃的下载/操作
    if (this._downloadAbortController) {
      this._downloadAbortController.abort();
      this._downloadAbortController = null;
    }

    const currentState = this.state;
    if (
      currentState === PythonState.DOWNLOADING ||
      currentState === PythonState.EXTRACTING ||
      currentState === PythonState.INSTALLING_PIP
    ) {
      this.errorMessage = '安装已取消';
      this.setState(PythonState.CANCELLED_PHASE1);
    } else if (currentState === PythonState.INSTALLING_DEPS) {
      this.errorMessage = '依赖包安装已取消，Python 基础环境就绪';
      this.setState(PythonState.CANCELLED_PHASE2);
    }
  }

  /**
   * @deprecated 使用 cancel() 代替
   */
  cancelDownload(): void {
    this.cancel();
  }

  onStatusChange(callback: StatusCallback): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  /**
   * 注册依赖安装回调
   * 由 DepsManager 在模块初始化时注入，避免 PythonManager 直接 import DepsManager 造成循环依赖
   * @param cb 异步回调函数，执行 14 个 recommended 依赖包的安装
   */
  setDepsInstallCallback(cb: () => Promise<void>): void {
    this._depsInstallCallback = cb;
  }

  /**
   * ★ 竞态修复：绑定主窗口并注册"渲染进程加载完成"门控。
   * 由 main/index.ts 的 createWindow() 在 BrowserWindow 创建后、loadURL/loadFile 之前调用
   * （含 app 'activate' 重建窗口路径）。门控行为：
   * - did-finish-load（页面 load 完成，必然晚于 preload 隔离世界 ipcNative 注入）→ 放行推送并补推缓存
   * - did-start-loading（重载/新导航，ipcNative 将随新页面重新注入）→ 重新关门，防重载窗口竞态
   * 监听器挂在对应窗口的 webContents 上，随窗口销毁一并释放，无泄漏。
   */
  attachMainWindow(win: BrowserWindow): void {
    this._rendererReady = false;
    win.webContents.on('did-start-loading', () => {
      this._rendererReady = false;
    });
    win.webContents.on('did-finish-load', () => {
      this._rendererReady = true;
      this._flushPendingStatusForRenderer();
    });
  }

  // ==============================================================
  // 内部实现
  // ==============================================================

  private emitStatus(): void {
    const status = this.getStatus();
    for (const cb of this.listeners) {
      try {
        cb(status);
      } catch {
        // 忽略回调异常
      }
    }
    // IPC 推送：通知渲染进程状态变更。
    // ★ 竞态修复：仅当渲染进程已完成加载（did-finish-load，preload 隔离世界 ipcNative 已注入）
    //   才允许 send；否则只缓存最新状态（latest-wins），由 attachMainWindow 注册的
    //   did-finish-load 门控放行后补推，确定性消除启动期 ipcNative 竞态。
    const win = BrowserWindow.getAllWindows()[0];
    if (this._rendererReady && win && !win.isDestroyed()) {
      win.webContents.send(IPC_PYTHON.STATUS_CHANGED, status);
    } else {
      this._pendingStatusForRenderer = status;
    }
  }

  /**
   * ★ 竞态修复：渲染进程就绪后补推缓存的最新状态（仅一次）。
   * 仅在 did-finish-load 事件回调内被调用，此时 ipcNative 注入必然已完成，send 安全。
   */
  private _flushPendingStatusForRenderer(): void {
    const pending = this._pendingStatusForRenderer;
    this._pendingStatusForRenderer = null;
    if (!pending) {
      return;
    }
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_PYTHON.STATUS_CHANGED, pending);
    }
  }

  private setState(state: PythonState): void {
    this.state = state;
    this.emitStatus();
  }

  private getPythonBaseDir(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'python');
    }
    const appPath = app.getAppPath();
    if (path.extname(appPath).toLowerCase() === '.asar') {
      // 调试模式：appPath 指向 asar 文件本身（如 electron.exe 直接加载 app.asar），
      // 预置 Python 位于 asar 同级的 resources 目录（extraResources 输出位置）
      return path.join(path.dirname(appPath), 'python');
    }
    return path.join(appPath, 'resources', 'python');
  }

  public getPythonDir(): string {
    return path.join(this.getPythonBaseDir(), PYTHON_DIR_NAME);
  }

  private getPythonExePath(): string {
    const pythonDir = this.getPythonDir();
    if (process.platform === 'win32') {
      return path.join(pythonDir, 'python.exe');
    }
    return path.join(pythonDir, 'bin', 'python3');
  }

  private getPthFilePath(): string {
    const pythonDir = this.getPythonDir();
    return path.join(pythonDir, `python${PYTHON_SHORT_VERSION.replace('.', '')}._pth`);
  }

  private async _doInit(): Promise<void> {
    this.setState(PythonState.DETECTING);

    // ★ 新增：优先检查预置 Python 环境
    const presetPath = this.getPythonExePath();
    if (existsSync(presetPath)) {
      // 快速验证：检查 python.exe 可执行 + _pth 已配置
      const pthOk = await this._verifyPresetPython(presetPath);
      if (pthOk) {
        this.pythonPath = presetPath;
        this.setState(PythonState.READY);
        return;
      }
      // 预置包存在但损坏 → 降级到下载模式（若网络可用）
      console.warn('[PythonManager] 预置 Python 环境验证失败，尝试降级下载');
    }

    // ★ 原有逻辑：Windows 下载 embeddable 包（保留作为降级方案）
    if (process.platform === 'win32') {
      await this._downloadAndExtract();
      return;
    }

    // macOS / Linux：检测系统 Python（不变）
    const systemPath = await this._detectSystemPython();
    if (systemPath) {
      this.pythonPath = systemPath;
      this.setState(PythonState.READY);
      return;
    }

    this.errorMessage = '未检测到系统 Python 环境。请安装 Python 3。';
    this.setState(PythonState.FAILED);
  }


  /**
   * 验证预置 Python 环境是否完整可用
   * 检查项：
   *   1. python.exe 存在且可执行
   *   2. _pth 文件已正确配置（import site 未注释、Lib/site-packages 已添加）
   *   3. pip 可用
   *   4. 关键预装包可导入（快速抽查）
   * @returns true = 预置环境完整可用
   */
  private async _verifyPresetPython(pythonPath: string): Promise<boolean> {
    // 1. 检查 python --version
    try {
      const version = await this._getPythonVersion(pythonPath);
      if (version !== PYTHON_VERSION) {
        console.warn(`[PythonManager] 预置 Python 版本不匹配: 期望 ${PYTHON_VERSION}, 实际 ${version}`);
        return false;
      }
    } catch {
      return false;
    }

    // 2. 检查 _pth 文件配置
    const pthPath = this.getPthFilePath();
    if (existsSync(pthPath)) {
      const pthContent = readFileSync(pthPath, 'utf-8');
      if (!pthContent.includes('import site') || !pthContent.includes('Lib/site-packages')) {
        console.warn('[PythonManager] _pth 文件配置不完整，尝试修复');
        try {
          await this._configurePth();
        } catch {
          return false;
        }
      }
    }

    // 3. 检查 pip 可用
    const pipOk = await this._checkPipAvailable(pythonPath);
    if (!pipOk) {
      console.warn('[PythonManager] 预置 Python 中 pip 不可用');
      return false;
    }

    // 4. 快速抽查关键包（仅检查最核心的3个，避免启动耗时）
    const criticalPkgs = ['numpy', 'requests', 'pdfplumber'];
    for (const pkg of criticalPkgs) {
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(pythonPath, ['-c', `import ${pkg}`], { timeout: 10000 }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } catch {
        console.warn(`[PythonManager] 预置包 ${pkg} 导入失败`);
        return false;
      }
    }

    return true;
  }

  private _detectSystemPython(): Promise<string | null> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const arg = process.platform === 'win32' ? 'python' : 'python3';
      execFile(cmd, [arg], { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout) {
          // fallback: try 'python' on unix
          if (process.platform !== 'win32') {
            execFile('which', ['python'], { timeout: 5000 }, (err2, stdout2) => {
              if (err2 || !stdout2) {
                resolve(null);
              } else {
                resolve(stdout2.trim().split('\n')[0]);
              }
            });
          } else {
            resolve(null);
          }
          return;
        }
        resolve(stdout.trim().split('\n')[0]);
      });
    });
  }

  private _getPythonVersion(pythonPath: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(pythonPath, ['--version'], { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) {
          resolve(null);
          return;
        }
        const output = (stdout || stderr || '').trim();
        const match = output.match(/Python\s+([\d.]+)/i);
        resolve(match ? match[1] : output || null);
      });
    });
  }


  private async _downloadAndExtract(): Promise<void> {
    const pythonBaseDir = this.getPythonBaseDir();
    const pythonDir = this.getPythonDir();
    const zipPath = path.join(pythonBaseDir, `python-${PYTHON_VERSION}-embed-amd64.zip`);

    // 确保目录存在
    mkdirSync(pythonBaseDir, { recursive: true });

    // 下载（带重试）
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        this.setState(PythonState.DOWNLOADING);
        this.progress = 0;
        await this._downloadFile(PYTHON_EMBED_URL, zipPath);
        break;
      } catch (err) {
        // 清理失败的下载文件
        try { unlinkSync(zipPath); } catch { /* ignore */ }

        // M7: 用户主动取消下载时，不重试，直接标记失败
        if (err instanceof Error && err.message === '下载已取消') {
          this.errorMessage = '下载已取消';
          this.setState(PythonState.FAILED);
          return;
        }

        if (attempt === MAX_RETRIES - 1) {
          this.errorMessage = `Python 下载失败（已重试 ${MAX_RETRIES} 次）: ${err instanceof Error ? err.message : String(err)}`;
          this.setState(PythonState.FAILED);
          return;
        }
        // 指数退避
        await this._sleep(RETRY_DELAYS_MS[attempt] || 4000);
      }
    }

    // 解压
    try {
      this.setState(PythonState.EXTRACTING);
      await this._extractZip(zipPath, pythonDir);
    } catch (err) {
      this.errorMessage = `Python 解压失败: ${err instanceof Error ? err.message : String(err)}`;
      this.setState(PythonState.FAILED);
      // 清理残留
      try { await rm(pythonDir, { recursive: true, force: true }); } catch { /* ignore */ }
      return;
    } finally {
      // 删除 zip 文件
      try { unlinkSync(zipPath); } catch { /* ignore */ }
    }

    // 配置 _pth 文件
    try {
      await this._configurePth();
    } catch (err) {
      this.errorMessage = `Python _pth 配置失败: ${err instanceof Error ? err.message : String(err)}`;
      this.setState(PythonState.FAILED);
      return;
    }

    // 验证
    const pythonExe = this.getPythonExePath();
    if (!existsSync(pythonExe)) {
      this.errorMessage = 'Python 可执行文件未找到，解压可能不完整。';
      this.setState(PythonState.FAILED);
      return;
    }

    this.pythonPath = pythonExe;
    await this._installPipAndDeps();
  }

  private _downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let totalSize = 0;
      let downloadedSize = 0;

      const doRequest = (requestUrl: string, redirectCount: number): void => {
        if (redirectCount > 10) {
          reject(new Error('重定向次数过多'));
          return;
        }

        const req = get(requestUrl, { timeout: DOWNLOAD_TIMEOUT_MS }, (res: IncomingMessage) => {
          // 处理重定向
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume(); // 消耗响应体
            doRequest(res.headers.location, redirectCount + 1);
            return;
          }

          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          const contentLength = res.headers['content-length'];
          if (contentLength) {
            totalSize = parseInt(contentLength, 10);
          }

          const fileStream = createWriteStream(destPath);

          res.on('data', (chunk: Buffer) => {
            downloadedSize += chunk.length;
            if (totalSize > 0) {
              this.progress = Math.round((downloadedSize / totalSize) * 100);
              this.emitStatus();
            }
          });

          pipeline(res, fileStream)
            .then(() => {
              // 验证文件是否完整
              try {
                const fileStat = statSync(destPath);
                if (fileStat.size === 0) {
                  reject(new Error('下载文件为空'));
                  return;
                }
              } catch {
                reject(new Error('下载文件写入失败'));
                return;
              }
              resolve();
            })
            .catch(reject);
        });

        // M7: 监听 AbortController 取消信号
        if (this._downloadAbortController) {
          const onAbort = () => {
            req.destroy();
            reject(new Error('下载已取消'));
          };
          this._downloadAbortController.signal.addEventListener('abort', onAbort, { once: true });
        }

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

  private async _extractZip(zipPath: string, destDir: string): Promise<void> {
    if (process.platform === 'win32') {
      // 使用 PowerShell Expand-Archive（Windows 10+ 内置）
      await this._runPowerShell(
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`,
      );
    } else {
      // macOS/Linux 使用 unzip
      await this._runCommand('unzip', ['-o', zipPath, '-d', destDir]);
    }
  }

  private _runPowerShell(script: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`PowerShell 退出码 ${code}: ${stderr.trim()}`));
        }
      });
    });
  }

  private _runCommand(cmd: string, args: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${cmd} 退出码 ${code}: ${stderr.trim()}`));
        }
      });
    });
  }

  private async _configurePth(): Promise<void> {
    const pthPath = this.getPthFilePath();

    if (!existsSync(pthPath)) {
      throw new Error(`_pth 文件未找到: ${pthPath}`);
    }

    let content = await readFile(pthPath, 'utf-8');
    const lines = content.split(/\r?\n/);

    const modified: string[] = [];
    let siteImported = false;
    let sitePackagesAdded = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // 取消注释 import site
      if (trimmed === '#import site' || trimmed === '# import site') {
        modified.push('import site');
        siteImported = true;
        continue;
      }

      // 已是 import site
      if (trimmed === 'import site') {
        siteImported = true;
      }

      // 检查是否已有 Lib/site-packages
      if (trimmed === 'Lib/site-packages' || trimmed === 'Lib\\site-packages') {
        sitePackagesAdded = true;
      }

      modified.push(line);
    }

    // 确保 import site 存在
    if (!siteImported) {
      // 在 python312.zip 之后插入
      const zipIndex = modified.findIndex((l) => l.trim().startsWith('python') && l.trim().endsWith('.zip'));
      if (zipIndex >= 0) {
        modified.splice(zipIndex + 1, 0, 'import site');
      } else {
        modified.push('import site');
      }
    }

    // 确保 Lib/site-packages 存在
    if (!sitePackagesAdded) {
      modified.push('Lib/site-packages');
    }

    await writeFile(pthPath, modified.join('\r\n'), 'utf-8');
  }

  /**
   * 自动安装 pip
   * 策略：优先尝试 ensurepip（embeddable Python 可能内置），失败则下载 get-pip.py
   * 超时保护 120 秒
   */
  private async _autoInstallPip(): Promise<void> {
    const pythonPath = this.pythonPath;
    this.setState(PythonState.INSTALLING_PIP);

    // 策略 1：尝试 python -m ensurepip --upgrade
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(pythonPath, ['-m', 'ensurepip', '--upgrade'], { timeout: 120_000 }, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
      // ensurepip 成功后验证 pip 是否可用
      const pipOk = await this._checkPipAvailable(pythonPath);
      if (pipOk) {
        return; // pip 安装成功
      }
    } catch {
      // ensurepip 失败，继续尝试 get-pip.py
    }

    // 策略 2：下载 get-pip.py 并执行
    const pythonDir = this.getPythonDir();
    const getPipPath = path.join(pythonDir, 'get-pip.py');

    try {
      await this._downloadFile('https://bootstrap.pypa.io/get-pip.py', getPipPath);
      await new Promise<void>((resolve, reject) => {
        execFile(pythonPath, [getPipPath], { cwd: pythonDir, timeout: 120_000 }, (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(stderr || err.message || String(err)));
          } else {
            resolve();
          }
        });
      });
    } catch (err) {
      // get-pip.py 下载或执行失败
      this.errorMessage = `pip 安装失败: ${err instanceof Error ? err.message : String(err)}`;
      this.setState(PythonState.FAILED);
      throw err;
    } finally {
      try { unlinkSync(getPipPath); } catch { /* ignore */ }
    }

    // 验证 pip 是否可用
    const pipOk = await this._checkPipAvailable(pythonPath);
    if (!pipOk) {
      this.errorMessage = 'pip 安装后验证失败：pip 仍不可用';
      this.setState(PythonState.FAILED);
      throw new Error(this.errorMessage);
    }
  }

  /**
   * 检查 pip 是否可用
   * 执行 python -m pip --version 验证
   */
  private _checkPipAvailable(pythonPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(pythonPath, ['-m', 'pip', '--version'], { timeout: 15_000 }, (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        resolve(stdout.trim().startsWith('pip '));
      });
    });
  }

  /**
   * 安装 pip 和依赖包（解压完成后调用）
   * 1. 调用 _autoInstallPip() 安装 pip
   * 2. pip 成功后，若 _depsInstallCallback 已注册，调用回调安装 14 个依赖包
   * 3. 回调完成后（无论成功失败），设置状态为 READY
   * 4. 若 pip 失败，状态已在 _autoInstallPip 中设为 FAILED
   */
  private async _installPipAndDeps(): Promise<void> {
    try {
      await this._autoInstallPip();
    } catch {
      // _autoInstallPip 内部已设置 FAILED 状态，直接返回
      return;
    }

    // pip 安装成功，设置状态为 INSTALLING_DEPS
    this.setState(PythonState.INSTALLING_DEPS);

    // 通过回调安装 14 个依赖包
    if (this._depsInstallCallback) {
      try {
        await this._depsInstallCallback();
      } catch (err) {
        // 依赖安装失败不阻塞 Python 就绪状态
        console.warn('[PythonManager] 依赖包自动安装失败:', err instanceof Error ? err.message : String(err));
      }
    }

    // 无论依赖安装成功与否，Python 已就绪
    this.setState(PythonState.READY);
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
