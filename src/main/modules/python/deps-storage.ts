/**
 * 依赖存储模块
 * 管理 deps-installed.json 文件的读写，替代 SQLite 存储已安装的 pip 包列表
 * 包含从 SQLite 到 JSON 的一次性迁移逻辑
 */

import { app } from 'electron';
import { listSettings, saveSetting } from '../../db';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ================================================================
// 类型
// ================================================================

/** pip 已安装包信息（JSON 持久化格式） */
interface PipPackage {
  name: string;
  version: string;
}

/** SQLite 中 deps_installed_packages 的旧格式（DepsPackage 数组） */
interface LegacyDepsPackage {
  name: string;
  level: string;
  status: string;
  version?: string;
  size?: number;
  error?: string;
}

// ================================================================
// 常量
// ================================================================

/** 已安装包 JSON 文件名 */
const INSTALLED_FILE_NAME = 'deps-installed.json';

/** Python 数据目录名 */
const PYTHON_DIR_NAME = 'python';

/** 迁移标记文件名 */
const MIGRATED_FLAG_NAME = '.deps_migrated';

/** SQLite 中已安装包列表的 key */
const DEPS_SETTINGS_KEY = 'deps_installed_packages';

// ================================================================
// DepsStorage
// ================================================================

export class DepsStorage {
  // ==============================================================
  // 路径相关
  // ==============================================================

  /**
   * 获取 deps-installed.json 完整路径
   * - 打包环境：process.resourcesPath/python/deps-installed.json
   * - 开发环境：userData/python/deps-installed.json
   */
  getFilePath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, PYTHON_DIR_NAME, INSTALLED_FILE_NAME);
    }
    return path.join(app.getPath('userData'), PYTHON_DIR_NAME, INSTALLED_FILE_NAME);
  }

  /**
   * 获取迁移标记文件路径
   */
  private getMigratedFlagPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, PYTHON_DIR_NAME, MIGRATED_FLAG_NAME);
    }
    return path.join(app.getPath('userData'), PYTHON_DIR_NAME, MIGRATED_FLAG_NAME);
  }

  /**
   * 确保 Python 数据目录存在
   */
  private ensureDir(): void {
    const dir = path.dirname(this.getFilePath());
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // ==============================================================
  // 读写操作
  // ==============================================================

  /**
   * 读取已安装包列表
   * 从 deps-installed.json 解析 PipPackage[]
   * 文件不存在时返回空数组
   */
  readInstalledPackages(): PipPackage[] {
    const filePath = this.getFilePath();
    if (!fs.existsSync(filePath)) {
      return [];
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);

      if (!Array.isArray(parsed)) {
        console.warn('[DepsStorage] deps-installed.json 不是数组格式，返回空列表');
        return [];
      }

      // 校验并过滤有效的 PipPackage 条目
      return parsed.filter((item: unknown): item is PipPackage => {
        return (
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).name === 'string' &&
          typeof (item as Record<string, unknown>).version === 'string'
        );
      });
    } catch (err) {
      console.error('[DepsStorage] 读取 deps-installed.json 失败:', err);
      return [];
    }
  }

  /**
   * 写入已安装包列表（SHA256 对比后决定是否写入）
   * @param rawJson 完整的 JSON 字符串
   * @returns true 表示已写入（内容有变化），false 表示跳过（内容无变化）
   */
  writeInstalledPackages(rawJson: string): boolean {
    const filePath = this.getFilePath();

    // 计算新内容的 SHA256
    const newHash = this.computeHash(rawJson);

    // 如果文件已存在，对比 SHA256
    if (fs.existsSync(filePath)) {
      try {
        const existingRaw = fs.readFileSync(filePath, 'utf-8');
        const existingHash = this.computeHash(existingRaw);
        if (existingHash === newHash) {
          // 内容无变化，跳过写入
          return false;
        }
      } catch (err) {
        // 读取失败视为内容不一致，继续写入
        console.warn('[DepsStorage] 读取现有文件失败，将覆盖写入:', err);
      }
    }

    // 确保目录存在
    this.ensureDir();

    // 写入文件
    try {
      fs.writeFileSync(filePath, rawJson, 'utf-8');
      console.log('[DepsStorage] deps-installed.json 已更新');
      return true;
    } catch (err) {
      console.error('[DepsStorage] 写入 deps-installed.json 失败:', err);
      return false;
    }
  }

  // ==============================================================
  // 哈希计算
  // ==============================================================

  /**
   * 计算字符串的 SHA256 哈希值
   * @param data 待计算的数据
   * @returns 小写十六进制哈希字符串
   */
  computeHash(data: string): string {
    return crypto.createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  // ==============================================================
  // 迁移
  // ==============================================================

  /**
   * 从 SQLite 迁移数据到 deps-installed.json（首次启动时调用）
   *
   * 幂等设计：
   * 1. 检查 .deps_migrated 标记文件 → 存在则跳过
   * 2. 检查 deps-installed.json → 已存在则创建标记并跳过
   * 3. 从 SQLite 读取 deps_installed_packages
   * 4. 写入 deps-installed.json
   * 5. 删除 SQLite 中的旧数据（saveSetting 置 null）
   * 6. 创建 .deps_migrated 标记
   */
  async migrateFromSqlite(): Promise<void> {
    // 步骤 1：检查迁移标记
    if (this.isMigrated()) {
      console.log('[DepsStorage] 迁移已完成（标记文件存在），跳过迁移');
      return;
    }

    // 步骤 2：检查 deps-installed.json 是否已存在
    const jsonPath = this.getFilePath();
    if (fs.existsSync(jsonPath)) {
      console.log('[DepsStorage] deps-installed.json 已存在，创建迁移标记并跳过');
      this.createMigratedFlag();
      return;
    }

    try {
      // 步骤 3：从 SQLite 读取 deps_installed_packages
      const settings = listSettings();
      const rawPackages = settings[DEPS_SETTINGS_KEY];

      if (!rawPackages || !Array.isArray(rawPackages)) {
        // SQLite 中无有效数据，直接创建标记
        console.log('[DepsStorage] SQLite 中无 deps_installed_packages 数据，创建迁移标记');
        this.createMigratedFlag();
        return;
      }

      // 转换为 PipPackage[] 格式
      const packages: PipPackage[] = [];
      for (const item of rawPackages) {
        if (
          typeof item === 'object' &&
          item !== null &&
          typeof (item as LegacyDepsPackage).name === 'string'
        ) {
          const pkg = item as LegacyDepsPackage;
          packages.push({
            name: pkg.name,
            version: pkg.version || 'unknown',
          });
        }
      }

      if (packages.length === 0) {
        console.log('[DepsStorage] SQLite 数据为空，创建迁移标记');
        this.createMigratedFlag();
        return;
      }

      // 步骤 4：写入 deps-installed.json
      const rawJson = JSON.stringify(packages, null, 2);
      const written = this.writeInstalledPackages(rawJson);
      if (written) {
        console.log(`[DepsStorage] 已从 SQLite 迁移 ${packages.length} 个包到 deps-installed.json`);
      }

      // 步骤 5：删除 SQLite 中的旧数据
      try {
        saveSetting(DEPS_SETTINGS_KEY, null);
        console.log('[DepsStorage] 已清除 SQLite 中的 deps_installed_packages');
      } catch (err) {
        console.error('[DepsStorage] 清除 SQLite 旧数据失败:', err);
        // 不阻塞迁移流程
      }

      // 步骤 6：创建迁移标记
      this.createMigratedFlag();
      console.log('[DepsStorage] 迁移完成');
    } catch (err) {
      console.error('[DepsStorage] 迁移过程出错:', err);
      // 迁移失败不抛出异常，下次启动会重试
    }
  }

  /**
   * 检查是否已完成迁移
   * @returns true 表示迁移已完成
   */
  isMigrated(): boolean {
    const flagPath = this.getMigratedFlagPath();
    return fs.existsSync(flagPath);
  }

  /**
   * 创建迁移完成标记文件
   */
  private createMigratedFlag(): void {
    try {
      this.ensureDir();
      const flagPath = this.getMigratedFlagPath();
      fs.writeFileSync(flagPath, new Date().toISOString(), 'utf-8');
      console.log('[DepsStorage] 迁移标记已创建:', flagPath);
    } catch (err) {
      console.error('[DepsStorage] 创建迁移标记失败:', err);
    }
  }
}

/** 全局单例 */
export const depsStorage = new DepsStorage();
