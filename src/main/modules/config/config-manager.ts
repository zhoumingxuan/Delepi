/**
 * 配置管理器
 * 管理三类配置：写死配置、应用可配配置（SQLite持久化）、只读配置（运行时推断）
 */

import { HARDCODED_CONFIG, DEFAULT_MAX_TOKENS } from './env';
import type { HardcodedConfig, AppSettings, ComputedConfig, AppConfig } from '../../types/config';
import { DEFAULT_APP_SETTINGS } from '@shared/constants';
import { listSettings } from '../../db';

export class ConfigManager {
  private hardcoded: HardcodedConfig;
  private settings: AppSettings;
  private computed: ComputedConfig;

  constructor() {
    this.hardcoded = { ...HARDCODED_CONFIG };
    this.settings = { ...DEFAULT_APP_SETTINGS };
    this.computed = this.buildComputedConfig();
  }

  /** 获取写死配置 */
  getHardcoded(): Readonly<HardcodedConfig> {
    return this.hardcoded;
  }

  /** 获取应用可配配置 */
  getSettings(): Readonly<AppSettings> {
    return this.settings;
  }

  /** 获取只读配置 */
  getComputed(): Readonly<ComputedConfig> {
    return this.computed;
  }

  /** 获取全量配置 */
  getAll(): AppConfig {
    return {
      hardcoded: { ...this.hardcoded },
      settings: { ...this.settings },
      computed: { ...this.computed },
    };
  }

  /** 更新应用配置（单个键） */
  setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.settings[key] = value;
  }

  /** 批量更新应用配置 */
  patchSettings(patch: Partial<AppSettings>): void {
    Object.assign(this.settings, patch);
  }

  /** 重新加载配置（从 SQLite settings 表读取并合并默认值） */
  reload(): void {
    const rows = listSettings();
    const saved: Partial<AppSettings> = {};
    for (const [key, value] of Object.entries(rows)) {
      if (key in DEFAULT_APP_SETTINGS) {
        (saved as Record<string, unknown>)[key] = value;
      }
    }

    // P1-05: 过滤空字符串值，避免覆盖非空默认值
    const filtered: Partial<AppSettings> = {};
    for (const [key, value] of Object.entries(saved)) {
      if (value !== '' && value !== null && value !== undefined) {
        (filtered as Record<string, unknown>)[key] = value;
      }
    }

    this.settings = { ...DEFAULT_APP_SETTINGS, ...filtered };
    this.computed = this.buildComputedConfig();
  }

  /**
   * 检查是否已配置（对齐参考项目 GET /api/config 的 configured 字段）
   * 至少一个模型的 API Key 已设置即视为已配置
   */
  isConfigured(): boolean {
    return this.settings.mainModelApiKey.length > 0
        || this.settings.executorModelApiKey.length > 0;
  }

  /** 构建运行时推断的只读配置 */
  private buildComputedConfig(): ComputedConfig {
    // 阶段1使用默认值，阶段2引入 electron app 对象
    return {
      APP_VERSION: '0.1.0',
      APP_NAME: 'Delepi',
      APP_PLATFORM: 'win32',
      APP_DATA_DIR: '',
    };
  }
}

/** 全局单例 */
export const configManager = new ConfigManager();
