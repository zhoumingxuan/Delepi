/**
 * 配置管理器
 * 管理三类配置：写死配置、应用可配配置（SQLite持久化）、只读配置（运行时推断）
 */

import { HARDCODED_CONFIG, DEFAULT_MAX_TOKENS } from './env';
import type { HardcodedConfig, AppSettings, ComputedConfig, AppConfig } from '../../types/config';
import { DEFAULT_APP_SETTINGS } from '@shared/constants';
import type { ModelProfile } from '@shared/types/config';
import { listSettings, saveSetting } from '../../db';
import { v4 as uuidv4 } from 'uuid';

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

    // 【模型配置方案使能】方案列表为空时创建默认方案：以当前生效配置（三组九键+多模态开关/思考档位）
    // 为快照源（对齐 profiles-save 的另存为语义，含 ModelProfile 全部 12 个配置键的合理默认值），
    // 保证首启/清空后始终存在一个可用方案，前端方案 Select 不再因空列表被禁用；创建后持久化写回 settings 表。
    if (this.settings.modelProfiles.length === 0) {
      const defaultProfile: ModelProfile = {
        id: uuidv4(),
        name: '默认方案',
        mainModelBaseUrl: this.settings.mainModelBaseUrl,
        mainModelApiKey: this.settings.mainModelApiKey,
        mainModelName: this.settings.mainModelName,
        mainModelMultimodal: this.settings.mainModelMultimodal,
        mainThinkingLevel: this.settings.mainThinkingLevel,
        executorModelBaseUrl: this.settings.executorModelBaseUrl,
        executorModelApiKey: this.settings.executorModelApiKey,
        executorModelName: this.settings.executorModelName,
        executorThinkingLevel: this.settings.executorThinkingLevel,
        visionLlmBaseUrl: this.settings.visionLlmBaseUrl,
        visionLlmApiKey: this.settings.visionLlmApiKey,
        visionLlmModel: this.settings.visionLlmModel,
      };
      this.settings.modelProfiles = [defaultProfile];
      saveSetting('modelProfiles', this.settings.modelProfiles);
    }

    // 【模型配置方案使能】activeProfileId 为空或指向不存在的方案但方案列表非空时，
    // 自动补选第一个方案并持久化写回，保证链路C（修改配置写回激活方案）不因激活键为空静默失效。
    const activeProfileIdValid = this.settings.modelProfiles.some(
      (item) => item.id === this.settings.activeProfileId,
    );
    if (this.settings.modelProfiles.length > 0 && !activeProfileIdValid) {
      this.settings.activeProfileId = this.settings.modelProfiles[0].id;
      saveSetting('activeProfileId', this.settings.activeProfileId);
    }

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
