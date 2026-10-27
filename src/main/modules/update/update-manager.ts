/**
 * 客户端自动更新：9 态状态机 + 调度器 + 检查/下载/安装编排（主进程单例）
 *
 * 调度：递归 setTimeout + inFlight 互斥，绝不使用周期定时器 API。
 * 版本：唯一来源 app.getVersion()。
 * 流程：启动后 30s±10s 首检 → 有新版本弹框 → 用户点「确定」→ 后台下载 →
 *       下载完成提示安装 → 用户点「立即安装」→ 调起系统安装器。
 */

import { app } from 'electron';
import { mkdir, rename, statfs } from 'node:fs/promises';
import { UPDATE_ERROR_CODES } from '@shared/update-error-codes';
import type {
  UpdateCancelResult,
  UpdateCheckParams,
  UpdateCheckResult,
  UpdateDownloadParams,
  UpdateDownloadResult,
  UpdateErrorInfo,
  UpdateInstallParams,
  UpdateInstallResult,
  UpdatePackageInfo,
  UpdatePhase,
  UpdateProgress,
  UpdateStateSnapshot,
} from '@shared/types/update';
import { fingerprintUpdateAccessKey } from '@shared/update-constants';
import { configManager } from '../config/config-manager';
import { resolveUpdateDir } from '../../utils/storage-paths';
import { resolveEffectiveUpdateDefaults } from './update-build-overrides';
import {
  resolveEffectiveUpdateBaseUrl,
} from './update-resolve';
import { resolveUpdatePlatform } from './update-platform';
import { compareUpdateVersion, isPrereleaseVersion } from './update-version';
import {
  downloadUpdatePackage,
  extractEndpointHost,
  requestUpdateCheck,
  UpdateRequestError,
  type UpdateCheckPayload,
} from './update-http';
import {
  ensureUpdateDir,
  isSafeUpdateVersion,
  purgeCachedPackages,
  removePackageArtifacts,
  resolvePackagePartPath,
  resolvePackagePath,
  resolveVersionDir,
  scanCachedPackages,
  writePackageMeta,
  type CachedUpdatePackage,
} from './update-cache';
import { launchUpdateInstaller } from './update-installer';
import { writeUpdateLog } from './update-log';
import {
  BACKOFF_MAX_MS,
  CHECK_INTERVAL_JITTER_MS,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  FIRST_CHECK_JITTER_MS,
  MANUAL_CHECK_COOLDOWN_MS,
  SETTING_ENABLED_RECHECK_DELAY_MS,
} from './update-defaults';

type UpdateListener = (snapshot: UpdateStateSnapshot) => void;

interface ManagerState {
  phase: UpdatePhase;
  latestVersion: string | null;
  hasPackage: boolean;
  updateNotes: string | null;
  packageInfo: UpdatePackageInfo | null;
  progress: UpdateProgress | null;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  lastError: UpdateErrorInfo | null;
  promptKind: 'available' | 'downloaded' | null;
  promptVersion: string | null;
  cachedVersion: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function jitter(base: number, amplitude: number): number {
  return base + (Math.random() * 2 - 1) * amplitude;
}

class UpdateManager {
  private state: ManagerState = {
    phase: 'idle',
    latestVersion: null,
    hasPackage: false,
    updateNotes: null,
    packageInfo: null,
    progress: null,
    lastCheckedAt: null,
    nextCheckAt: null,
    lastError: null,
    promptKind: null,
    promptVersion: null,
    cachedVersion: null,
  };

  private listeners = new Set<UpdateListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private downloadAbort: AbortController | null = null;
  /** 生效地址代际：updateBaseUrl 变更时自增，旧地址的下载流程据此放弃状态回写 */
  private downloadGeneration = 0;
  private cachedPackage: CachedUpdatePackage | null = null;
  private consecutiveFailures = 0;
  private lastManualCheckAt = 0;
  private lastHttpStatus: number | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private disposed = false;

  /** 应用启动：扫描本地缓存 + 记录配置指纹 + 安排 30 秒首检 */
  async init(): Promise<void> {
    if (this.initialized || this.disposed) {
      return;
    }
    this.initialized = true;
    this.initPromise = this.initializeInternal();
    await this.initPromise;
  }

  /** 启动缓存扫描与首检调度（check/download/install 会等待该 Promise，避免与扫描竞态） */
  private async initializeInternal(): Promise<void> {
    this.logConfig();

    try {
      const cachedPackages = await scanCachedPackages();
      this.cachedPackage = cachedPackages[0] ?? null;
      this.state.cachedVersion = this.cachedPackage?.version ?? null;
    } catch (error) {
      writeUpdateLog('WARN', 'update.cache.scan', { reason: 'startup' }, error);
    }

    const platform = resolveUpdatePlatform();
    if (!platform) {
      this.setState({
        phase: 'idle',
        promptKind: null,
        promptVersion: null,
        lastError: {
          code: UPDATE_ERROR_CODES.UNSUPPORTED_PLATFORM,
          message: '当前系统不支持自动更新',
          at: nowIso(),
        },
      });
      return;
    }

    this.emit();
    if (this.buildSnapshot().autoCheckEnabled) {
      this.scheduleNext(jitter(FIRST_CHECK_DELAY_MS, FIRST_CHECK_JITTER_MS));
    }
  }

  /** 应用退出：清定时器 + 中止在途下载 */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.downloadAbort?.abort();
    this.downloadAbort = null;
    this.listeners.clear();
  }

  private async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise.catch(() => undefined);
    }
  }

  getSnapshot(): UpdateStateSnapshot {
    const settings = configManager.getSettings();
    const defaults = resolveEffectiveUpdateDefaults();
    const effectiveBaseUrl = resolveEffectiveUpdateBaseUrl(settings.updateBaseUrl, defaults.baseUrl);
    return {
      phase: this.state.phase,
      platform: resolveUpdatePlatform(),
      currentVersion: this.currentVersion(),
      latestVersion: this.state.latestVersion,
      hasPackage: this.state.hasPackage,
      updateNotes: this.state.updateNotes,
      packageInfo: this.state.packageInfo ? { ...this.state.packageInfo } : null,
      progress: this.state.progress ? { ...this.state.progress } : null,
      lastCheckedAt: this.state.lastCheckedAt,
      nextCheckAt: this.state.nextCheckAt,
      lastError: this.state.lastError ? { ...this.state.lastError } : null,
      autoCheckEnabled: settings.updateAutoCheckEnabled !== false,
      defaultBaseUrl: defaults.baseUrl,
      defaultBaseUrlSource: defaults.baseUrlSource,
      effectiveBaseUrl,
      downloadDir: resolveUpdateDir(),
      promptKind: this.state.promptKind,
      promptVersion: this.state.promptVersion,
      cachedVersion: this.state.cachedVersion,
    };
  }

  subscribe(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 手动 / 自动 / 恢复检查入口（渲染层只调用 check，不允许自行拼状态） */
  async check(params?: UpdateCheckParams): Promise<UpdateCheckResult> {
    await this.waitForInit();
    const reason: 'manual' | 'auto' | 'resume' =
      params?.reason === 'auto' || params?.reason === 'resume' ? params.reason : 'manual';
    const snapshot = this.buildSnapshot();
    if (snapshot.platform === null || this.inFlight || this.disposed) {
      return { accepted: false, snapshot };
    }
    if (reason === 'manual') {
      const isRetryableError = this.state.phase === 'network-failed'
        || this.state.phase === 'unauthorized'
        || this.state.phase === 'verify-failed';
      if (!isRetryableError && Date.now() - this.lastManualCheckAt < MANUAL_CHECK_COOLDOWN_MS) {
        return { accepted: false, snapshot };
      }
      this.lastManualCheckAt = Date.now();
    }
    void this.runCheckCycle(reason);
    return { accepted: true, snapshot: this.buildSnapshot() };
  }

  /** 用户点「确定」后开始后台下载（不阻塞其它操作） */
  async download(params?: UpdateDownloadParams): Promise<UpdateDownloadResult> {
    await this.waitForInit();
    const snapshot = this.buildSnapshot();
    if (snapshot.platform === null) {
      return { started: false, code: UPDATE_ERROR_CODES.UNSUPPORTED_PLATFORM, snapshot };
    }
    if (this.inFlight || this.disposed) {
      return { started: false, code: UPDATE_ERROR_CODES.BUSY, snapshot };
    }
    const version = (params?.version ?? this.state.latestVersion ?? '').trim();
    if (!isSafeUpdateVersion(version) || version !== this.state.latestVersion) {
      return { started: false, code: UPDATE_ERROR_CODES.BAD_VERSION, snapshot };
    }
    if (this.state.phase !== 'update-available' && this.state.phase !== 'verify-failed') {
      return { started: false, code: UPDATE_ERROR_CODES.BUSY, snapshot };
    }
    const packageInfo = this.state.packageInfo;
    if (!packageInfo || !this.state.hasPackage) {
      return { started: false, code: UPDATE_ERROR_CODES.NO_PACKAGE, snapshot };
    }
    void this.runDownload(version, packageInfo);
    return { started: true, snapshot: this.buildSnapshot() };
  }

  async cancel(): Promise<UpdateCancelResult> {
    if (this.state.phase !== 'downloading' || !this.downloadAbort) {
      return { cancelled: false, snapshot: this.buildSnapshot() };
    }
    this.downloadAbort.abort();
    return { cancelled: true, snapshot: this.buildSnapshot() };
  }

  async install(params?: UpdateInstallParams): Promise<UpdateInstallResult> {
    await this.waitForInit();
    const snapshot = this.buildSnapshot();
    if (snapshot.platform === null) {
      return { launched: false, code: UPDATE_ERROR_CODES.UNSUPPORTED_PLATFORM };
    }
    const packageInfo = this.state.packageInfo;
    if (this.state.phase !== 'downloaded' || !packageInfo) {
      return {
        launched: false,
        code: UPDATE_ERROR_CODES.INSTALL_FAILED,
        message: '当前没有可安装的更新包。',
      };
    }
    const version = (params?.version ?? this.state.latestVersion ?? this.state.cachedVersion ?? '').trim();
    if (!this.cachedPackage || this.cachedPackage.version !== version) {
      const cachedPackages = await scanCachedPackages();
      this.cachedPackage = cachedPackages.find((item) => item.version === version) ?? null;
    }
    if (!this.cachedPackage) {
      this.setError(UPDATE_ERROR_CODES.INSTALL_FAILED, '安装包不存在，请重新下载。');
      return {
        launched: false,
        code: UPDATE_ERROR_CODES.INSTALL_FAILED,
        message: '安装包不存在，请重新下载。',
      };
    }
    const result = await launchUpdateInstaller(snapshot.platform, this.cachedPackage.filePath, version);
    if (!result.launched) {
      this.setError(result.code ?? UPDATE_ERROR_CODES.INSTALL_FAILED, result.message ?? '安装程序未能启动');
    }
    return result;
  }

  /** config:save 命中两个更新配置键时由 ipc-handlers 调用（开关即时生效 / 地址变更重置状态） */
  notifyConfigChanged(key: 'updateAutoCheckEnabled' | 'updateBaseUrl'): void {
    if (this.disposed) {
      return;
    }
    if (key === 'updateAutoCheckEnabled') {
      const enabled = this.buildSnapshot().autoCheckEnabled;
      if (enabled) {
        if (!this.timer && !this.inFlight) {
          this.setState({});
          this.scheduleNext(SETTING_ENABLED_RECHECK_DELAY_MS);
        }
      } else {
        this.clearTimer();
        this.state.nextCheckAt = null;
        this.emit();
        writeUpdateLog('INFO', 'update.schedule.disabled', { reason: 'setting' });
      }
      return;
    }

    this.clearTimer();
    // 生效地址变更：代际自增让旧地址的在途下载流程失效，并立即中止其网络请求
    this.downloadGeneration += 1;
    const hadInFlightDownload = this.downloadAbort !== null;
    this.downloadAbort?.abort();
    this.downloadAbort = null;
    // 内存缓存包引用与缓存版本号一并清空：下一次检查不可能命中「缓存版本 == 最新」
    this.cachedPackage = null;
    this.setState({
      phase: 'idle',
      latestVersion: null,
      hasPackage: false,
      updateNotes: null,
      packageInfo: null,
      progress: null,
      lastError: null,
      promptKind: null,
      promptVersion: null,
      nextCheckAt: null,
      cachedVersion: null,
    });
    if (hadInFlightDownload) {
      writeUpdateLog('INFO', 'update.download.abort', {
        reason: 'base_url_changed',
        code: UPDATE_ERROR_CODES.CANCELLED,
      });
    }
    // 磁盘缓存清理：只删 updates/ 目录内由 update-cache 管理的版本目录 / .part / .meta.json
    void purgeCachedPackages()
      .then((removed) => {
        if (removed > 0) {
          writeUpdateLog('INFO', 'update.cache.purge', { removed, reason: 'base_url_changed' });
        }
      })
      .catch((error: unknown) => {
        writeUpdateLog('WARN', 'update.cache.purge', { reason: 'base_url_changed' }, error);
      });
    this.logConfig();
    if (this.buildSnapshot().autoCheckEnabled) {
      this.scheduleNext();
    }
  }

  // -------------------------------------------------------------------------
  // 检查
  // -------------------------------------------------------------------------

  private async runCheckCycle(reason: 'manual' | 'auto' | 'resume'): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.inFlight) {
      writeUpdateLog('WARN', 'update.schedule.skip', { reason });
      this.scheduleNext();
      return;
    }
    if (reason === 'auto' && !this.buildSnapshot().autoCheckEnabled) {
      this.clearTimer();
      return;
    }

    this.inFlight = true;
    this.lastHttpStatus = null;
    const startedAt = Date.now();
    this.setState({
      phase: 'checking',
      lastError: null,
      progress: null,
      promptKind: null,
      promptVersion: null,
    });
    writeUpdateLog('INFO', 'update.check.start', {
      reason,
      currentVersion: this.currentVersion(),
      platform: resolveUpdatePlatform() ?? 'unsupported',
    });

    try {
      await this.performCheck();
    } catch (error) {
      this.applyCheckFailure(error);
    } finally {
      this.inFlight = false;
      this.state.lastCheckedAt = nowIso();
      this.scheduleNext();
      this.emit();
      writeUpdateLog('INFO', 'update.check.result', {
        phase: this.state.phase,
        code: this.state.lastError?.code ?? '',
        httpStatus: this.lastHttpStatus ?? '-',
        durationMs: Date.now() - startedAt,
      });
    }
  }

  private async performCheck(): Promise<void> {
    const platform = resolveUpdatePlatform();
    if (!platform) {
      this.setState({
        phase: 'idle',
        lastError: {
          code: UPDATE_ERROR_CODES.UNSUPPORTED_PLATFORM,
          message: '当前系统不支持自动更新',
          at: nowIso(),
        },
        promptKind: null,
        promptVersion: null,
      });
      return;
    }

    const snapshot = this.buildSnapshot();
    const defaults = resolveEffectiveUpdateDefaults();
    let payload: UpdateCheckPayload;
    try {
      payload = await requestUpdateCheck({
        baseUrl: snapshot.effectiveBaseUrl,
        accessKey: defaults.accessKey,
        currentVersion: this.currentVersion(),
        platform,
      });
    } catch (error) {
      if (error instanceof UpdateRequestError) {
        this.lastHttpStatus = error.httpStatus;
      }
      throw error;
    }

    this.consecutiveFailures = 0;
    const latestVersion = payload.latestVersion;
    const currentVersion = this.currentVersion();
    const comparison = compareUpdateVersion(latestVersion, currentVersion);
    const remoteIsPrerelease = isPrereleaseVersion(latestVersion);
    const localIsPrerelease = isPrereleaseVersion(currentVersion);
    const shouldUpdate = comparison > 0 && !(remoteIsPrerelease && !localIsPrerelease);

    if (!shouldUpdate) {
      await this.clearCachedPackages('no_update');
      this.setState({
        phase: 'up-to-date',
        latestVersion,
        hasPackage: false,
        updateNotes: null,
        packageInfo: null,
        progress: null,
        promptKind: null,
        promptVersion: null,
      });
      return;
    }

    // 启动缓存判定：已下载包版本 == 接口最新版本，且来源主机 == 当前生效地址主机 → 直接进入可安装提示
    const currentBaseUrlHost = extractEndpointHost(this.buildSnapshot().effectiveBaseUrl);
    if (
      this.cachedPackage
      && this.cachedPackage.version === latestVersion
      && this.cachedPackage.baseUrlHost === currentBaseUrlHost
    ) {
      this.setState({
        phase: 'downloaded',
        latestVersion,
        hasPackage: true,
        updateNotes: payload.updateNotes,
        packageInfo: {
          fileName: this.cachedPackage.fileName,
          size: this.cachedPackage.size,
          sha256: this.cachedPackage.sha256,
        },
        progress: null,
        promptKind: 'downloaded',
        promptVersion: latestVersion,
        lastError: null,
      });
      writeUpdateLog('INFO', 'update.cache.restore', {
        version: latestVersion,
        restored: true,
        size: this.cachedPackage.size,
      });
      return;
    }

    const cachedVersionMatched = this.cachedPackage?.version === latestVersion;
    if (cachedVersionMatched) {
      // 版本号相同但来源主机不同：跨源缓存不可复用，先清理再按「有可用更新」提示
      writeUpdateLog('WARN', 'update.cache.source_mismatch', {
        version: latestVersion,
        endpointHost: currentBaseUrlHost,
        reason: 'base_url_host_mismatch',
      });
    }
    // 版本不匹配（或元数据缺失已在启动扫描时删除）/ 来源主机不一致 → 直接清理旧源安装包
    await this.clearCachedPackages(cachedVersionMatched ? 'base_url_mismatch' : 'version_mismatch');
    this.setState({
      phase: 'update-available',
      latestVersion,
      hasPackage: payload.hasPackage,
      updateNotes: payload.updateNotes,
      packageInfo: payload.package,
      progress: null,
      promptKind: 'available',
      promptVersion: latestVersion,
      lastError: payload.hasPackage && payload.package
        ? null
        : {
          code: UPDATE_ERROR_CODES.NO_PACKAGE,
          message: '新版本安装包未就绪',
          at: nowIso(),
        },
    });
  }

  private applyCheckFailure(error: unknown): void {
    const requestError = error instanceof UpdateRequestError
      ? error
      : new UpdateRequestError(
        UPDATE_ERROR_CODES.NETWORK,
        error instanceof Error ? error.message : String(error),
      );
    this.lastHttpStatus = requestError.httpStatus;

    if (requestError.code === UPDATE_ERROR_CODES.UNAUTHORIZED) {
      this.consecutiveFailures = 0;
      this.setState({
        phase: 'unauthorized',
        progress: null,
        promptKind: null,
        promptVersion: null,
        lastError: {
          code: requestError.code,
          message: '更新服务未响应（404）',
          at: nowIso(),
        },
      });
      return;
    }

    this.consecutiveFailures += 1;
    this.setState({
      phase: 'network-failed',
      progress: null,
      promptKind: null,
      promptVersion: null,
      lastError: {
        code: requestError.code,
        message: requestError.message,
        at: nowIso(),
      },
    });
  }

  // -------------------------------------------------------------------------
  // 下载
  // -------------------------------------------------------------------------

  private async runDownload(version: string, packageInfo: UpdatePackageInfo): Promise<void> {
    if (this.inFlight || this.disposed) {
      return;
    }
    // 代际与源地址在下载开始时固定：地址变更后本流程不得再提交任何状态或元数据
    const generation = this.downloadGeneration;
    const sourceBaseUrl = this.buildSnapshot().effectiveBaseUrl;
    this.inFlight = true;
    const abortController = new AbortController();
    this.downloadAbort = abortController;
    this.setState({
      phase: 'downloading',
      progress: { receivedBytes: 0, totalBytes: packageInfo.size },
      lastError: null,
      packageInfo: { ...packageInfo },
      hasPackage: true,
    });
    writeUpdateLog('INFO', 'update.download.start', {
      version,
      size: packageInfo.size,
      endpointHost: extractEndpointHost(this.buildSnapshot().effectiveBaseUrl),
    });

    let verifyAttempt = 0;
    try {
      await ensureUpdateDir();
      await this.ensureDiskSpace(packageInfo.size);
      const platform = resolveUpdatePlatform();
      if (!platform) {
        throw new UpdateRequestError(
          UPDATE_ERROR_CODES.UNSUPPORTED_PLATFORM,
          '当前系统不支持自动更新',
        );
      }
      const partPath = resolvePackagePartPath(version, packageInfo.fileName);
      const finalPath = resolvePackagePath(version, packageInfo.fileName);
      const defaults = resolveEffectiveUpdateDefaults();

      while (true) {
        this.assertDownloadGeneration(generation);
        await mkdir(resolveVersionDir(version), { recursive: true });
        try {
          const result = await downloadUpdatePackage({
            baseUrl: sourceBaseUrl,
            accessKey: defaults.accessKey,
            platform,
            version,
            partPath,
            expectedSize: packageInfo.size,
            signal: abortController.signal,
            onProgress: (receivedBytes, totalBytes) => {
              if (generation !== this.downloadGeneration) {
                return;
              }
              this.state.progress = { receivedBytes, totalBytes };
              this.emit();
            },
          });
          this.assertDownloadGeneration(generation);
          if (result.receivedBytes !== packageInfo.size) {
            throw new UpdateRequestError(
              UPDATE_ERROR_CODES.SIZE_MISMATCH,
              '安装包字节数与清单不一致',
            );
          }
          if (result.sha256.toLowerCase() !== packageInfo.sha256.toLowerCase()) {
            throw new UpdateRequestError(
              UPDATE_ERROR_CODES.HASH_MISMATCH,
              '安装包 SHA-256 与清单不一致',
            );
          }
          await rename(partPath, finalPath);
          const baseUrlHost = extractEndpointHost(sourceBaseUrl);
          await writePackageMeta({
            version,
            fileName: packageInfo.fileName,
            size: packageInfo.size,
            sha256: packageInfo.sha256,
            baseUrlHost,
          });
          this.assertDownloadGeneration(generation);
          this.cachedPackage = {
            version,
            fileName: packageInfo.fileName,
            size: packageInfo.size,
            sha256: packageInfo.sha256.toLowerCase(),
            filePath: finalPath,
            dir: resolveVersionDir(version),
            baseUrlHost,
            downloadedAt: nowIso(),
          };
          this.setState({
            phase: 'downloaded',
            latestVersion: version,
            hasPackage: true,
            packageInfo: { ...packageInfo },
            progress: null,
            promptKind: 'downloaded',
            promptVersion: version,
            lastError: null,
            cachedVersion: version,
          });
          writeUpdateLog('INFO', 'update.verify.ok', {
            version,
            size: packageInfo.size,
            sha256Prefix: packageInfo.sha256.slice(0, 8),
          });
          break;
        } catch (error) {
          const requestError = error instanceof UpdateRequestError
            ? error
            : new UpdateRequestError(
              UPDATE_ERROR_CODES.WRITE,
              error instanceof Error ? error.message : String(error),
            );
          writeUpdateLog('WARN', 'update.download.result', {
            version,
            code: requestError.code,
            retryCount: verifyAttempt,
          });
          const isVerifyFailure = requestError.code === UPDATE_ERROR_CODES.SIZE_MISMATCH
            || requestError.code === UPDATE_ERROR_CODES.HASH_MISMATCH;
          if (isVerifyFailure && verifyAttempt < 1) {
            verifyAttempt += 1;
            await removePackageArtifacts(version);
            writeUpdateLog('WARN', 'update.verify.retry', {
              version,
              code: requestError.code,
              retryCount: verifyAttempt,
            });
            this.setState({
              phase: 'downloading',
              progress: { receivedBytes: 0, totalBytes: packageInfo.size },
            });
            continue;
          }
          throw requestError;
        }
      }
    } catch (error) {
      if (generation !== this.downloadGeneration) {
        // 地址已变更：旧源产物一律丢弃，且绝不回写 phase（旧流程不得把状态改回 downloaded）
        await removePackageArtifacts(version);
        writeUpdateLog('INFO', 'update.download.abort', {
          version,
          reason: 'base_url_changed',
          code: error instanceof UpdateRequestError ? error.code : UPDATE_ERROR_CODES.CANCELLED,
        });
        return;
      }
      await this.handleDownloadFailure(version, packageInfo, error);
    } finally {
      if (generation === this.downloadGeneration) {
        this.downloadAbort = null;
        this.inFlight = false;
        this.emit();
        if (!this.disposed) {
          this.scheduleNext();
        }
      } else {
        // 旧代际流程只复位互斥标记；调度与状态以地址变更分支写入的为准
        this.inFlight = false;
      }
    }
  }

  private async handleDownloadFailure(
    version: string,
    packageInfo: UpdatePackageInfo,
    error: unknown,
  ): Promise<void> {
    const requestError = error instanceof UpdateRequestError
      ? error
      : new UpdateRequestError(
        UPDATE_ERROR_CODES.WRITE,
        error instanceof Error ? error.message : String(error),
      );

    if (requestError.code === UPDATE_ERROR_CODES.CANCELLED) {
      await removePackageArtifacts(version);
      this.setState({
        phase: this.state.latestVersion ? 'update-available' : 'idle',
        progress: null,
        hasPackage: Boolean(this.state.latestVersion),
        packageInfo: this.state.latestVersion ? { ...packageInfo } : null,
        promptKind: this.state.latestVersion ? 'available' : null,
        promptVersion: this.state.latestVersion,
        lastError: null,
      });
      writeUpdateLog('INFO', 'update.download.cancel', { version });
      return;
    }

    if (requestError.code === UPDATE_ERROR_CODES.UNAUTHORIZED) {
      await removePackageArtifacts(version);
      this.setState({
        phase: 'unauthorized',
        progress: null,
        promptKind: null,
        promptVersion: null,
        lastError: {
          code: requestError.code,
          message: '更新服务未响应（404）',
          at: nowIso(),
        },
      });
      return;
    }

    if (requestError.code === UPDATE_ERROR_CODES.SIZE_MISMATCH
      || requestError.code === UPDATE_ERROR_CODES.HASH_MISMATCH) {
      await removePackageArtifacts(version);
      this.setState({
        phase: 'verify-failed',
        progress: null,
        hasPackage: true,
        packageInfo: { ...packageInfo },
        promptKind: null,
        promptVersion: null,
        lastError: {
          code: requestError.code,
          message: requestError.message,
          at: nowIso(),
        },
      });
      return;
    }

    if (requestError.code === UPDATE_ERROR_CODES.DISK) {
      this.setState({
        phase: this.state.latestVersion ? 'update-available' : 'idle',
        progress: null,
        hasPackage: Boolean(this.state.latestVersion),
        packageInfo: this.state.latestVersion ? { ...packageInfo } : null,
        promptKind: this.state.latestVersion ? 'available' : null,
        promptVersion: this.state.latestVersion,
        lastError: {
          code: requestError.code,
          message: '磁盘空间不足，无法下载',
          at: nowIso(),
        },
      });
      return;
    }

    if (requestError.code === UPDATE_ERROR_CODES.NO_PACKAGE) {
      this.setState({
        phase: 'update-available',
        progress: null,
        hasPackage: false,
        packageInfo: null,
        promptKind: 'available',
        promptVersion: this.state.latestVersion,
        lastError: {
          code: requestError.code,
          message: '新版本安装包未就绪',
          at: nowIso(),
        },
      });
      return;
    }

    this.setState({
      phase: 'network-failed',
      progress: null,
      hasPackage: true,
      packageInfo: { ...packageInfo },
      promptKind: null,
      promptVersion: null,
      lastError: {
        code: requestError.code,
        message: requestError.message,
        at: nowIso(),
      },
    });
  }

  /** 生效地址变更后，旧地址的下载流程立即失效（抛取消错误，由 catch 收尾且不回写状态） */
  private assertDownloadGeneration(generation: number): void {
    if (generation !== this.downloadGeneration) {
      throw new UpdateRequestError(
        UPDATE_ERROR_CODES.CANCELLED,
        '更新地址已变更，已中止旧地址的下载',
      );
    }
  }

  private async ensureDiskSpace(size: number): Promise<void> {
    try {
      const dir = await ensureUpdateDir();
      const stats = await statfs(dir);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      if (Number.isFinite(freeBytes) && freeBytes < size * 2) {
        throw new UpdateRequestError(UPDATE_ERROR_CODES.DISK, '磁盘空间不足');
      }
    } catch (error) {
      if (error instanceof UpdateRequestError) {
        throw error;
      }
      // 无法预检（平台不支持 statfs 等）时交给写盘错误处理
    }
  }

  // -------------------------------------------------------------------------
  // 调度与工具
  // -------------------------------------------------------------------------

  private scheduleNext(delayOverrideMs?: number): void {
    this.clearTimer();
    if (this.disposed) {
      return;
    }
    if (!this.buildSnapshot().autoCheckEnabled) {
      this.state.nextCheckAt = null;
      this.emit();
      return;
    }
    const baseDelay = delayOverrideMs
      ?? jitter(CHECK_INTERVAL_MS, CHECK_INTERVAL_JITTER_MS)
        * Math.min(2 ** this.consecutiveFailures, 16);
    const delay = Math.max(1_000, Math.min(Math.round(baseDelay), BACKOFF_MAX_MS));
    this.state.nextCheckAt = new Date(Date.now() + delay).toISOString();
    this.emit();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCheckCycle('auto');
    }, delay);
    writeUpdateLog('INFO', 'update.schedule.next', {
      delayMs: delay,
      nextCheckAt: this.state.nextCheckAt,
    });
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async clearCachedPackages(reason: string): Promise<void> {
    const removed = await purgeCachedPackages();
    if (removed > 0) {
      writeUpdateLog('INFO', 'update.cache.purge', {
        removed,
        reason,
        version: this.cachedPackage?.version ?? '',
      });
    }
    this.cachedPackage = null;
    this.state.cachedVersion = null;
  }

  private setError(code: string, message: string): void {
    this.setState({
      lastError: {
        code,
        message,
        at: nowIso(),
      },
    });
  }

  private setState(patch: Partial<ManagerState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    if (this.disposed) {
      return;
    }
    const snapshot = this.buildSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // 单个订阅者异常不影响其它订阅者
      }
    }
  }

  private buildSnapshot(): UpdateStateSnapshot {
    return this.getSnapshot();
  }

  private currentVersion(): string {
    try {
      const version = app.getVersion();
      if (typeof version === 'string' && version.trim()) {
        return version.trim();
      }
    } catch {
      // app 尚未就绪时回落
    }
    return '0.0.0';
  }

  private logConfig(): void {
    const defaults = resolveEffectiveUpdateDefaults();
    const effectiveBaseUrl = resolveEffectiveUpdateBaseUrl(
      configManager.getSettings().updateBaseUrl,
      defaults.baseUrl,
    );
    writeUpdateLog('INFO', 'update.config', {
      endpointHost: extractEndpointHost(effectiveBaseUrl),
      defaultSource: defaults.baseUrlSource,
      accessKeySource: defaults.accessKeySource,
      keyFp: fingerprintUpdateAccessKey(defaults.accessKey),
      currentVersion: this.currentVersion(),
      platform: resolveUpdatePlatform() ?? 'unsupported',
    });
  }
}

/** 全局单例（主进程内唯一状态源） */
export const updateManager = new UpdateManager();
