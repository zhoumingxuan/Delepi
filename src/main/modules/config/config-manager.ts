/**
 * 配置管理器
 * 管理三类配置：写死配置、应用可配配置（SQLite持久化）、只读配置（运行时推断）
 */

import { app } from 'electron';
import { HARDCODED_CONFIG, DEFAULT_MAX_TOKENS } from './env';
import type { HardcodedConfig, AppSettings, ComputedConfig, AppConfig } from '../../types/config';
import { DEFAULT_APP_SETTINGS } from '@shared/constants';
import type { ModelProfile } from '@shared/types/config';
import { getDb, listSettings } from '../../db';
import { readConfigRevision, writeSettingsTransaction } from './settings-transaction';
import { v4 as uuidv4 } from 'uuid';

export class ConfigManager {
  private hardcoded: HardcodedConfig;
  private settings: AppSettings;
  private computed: ComputedConfig;
  private readonly modelConfigurationListeners = new Set<()=>void>();

  onModelConfigurationChanged(listener:()=>void):()=>void {
    this.modelConfigurationListeners.add(listener);return ()=>this.modelConfigurationListeners.delete(listener);
  }
  private notifyModelConfigurationChanged(previous:AppSettings):void {
    const keys: Array<keyof AppSettings>=['mainModelBaseUrl','mainModelName','mainModelApiKey','executorModelBaseUrl','executorModelName','executorModelApiKey'];
    if(!keys.some(key=>previous[key]!==this.settings[key]))return;
    for(const listener of this.modelConfigurationListeners) {try{listener();}catch{ /* Config persisted; consumers remain fail-closed until a trusted refresh. */ }}
  }

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
    const previous={...this.settings};
    this.settings[key] = value;
    this.notifyModelConfigurationChanged(previous);
  }

  /** 批量更新应用配置 */
  patchSettings(patch: Partial<AppSettings>): void {
    const previous={...this.settings};
    Object.assign(this.settings, patch);
    this.notifyModelConfigurationChanged(previous);
  }

  getRevision(): number { return readConfigRevision(getDb()); }

  /** Publish memory only after the whole SQLite transaction commits. */
  commitSettings(patch: Partial<AppSettings>, expectedRevision?: number): number {
    const copied = JSON.parse(JSON.stringify(patch)) as Partial<AppSettings>;
    const nextSettings = { ...this.settings, ...copied };
    const revision = writeSettingsTransaction(getDb(), copied, expectedRevision);
    const previous=this.settings;
    this.settings = nextSettings;
    this.notifyModelConfigurationChanged(previous);
    return revision;
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

    // 思考档位的空串表示服务商默认，须保留用户选择；其余空值继续过滤。
    const filtered: Partial<AppSettings> = {};
    for (const [key, value] of Object.entries(saved)) {
      const isThinkingLevel = key === 'mainThinkingLevel' || key === 'executorThinkingLevel';
      if ((value !== '' || isThinkingLevel) && value !== null && value !== undefined) {
        (filtered as Record<string, unknown>)[key] = value;
      }
    }

    const nextSettings = { ...DEFAULT_APP_SETTINGS, ...filtered };
    // Existing installs previously selected a protocol by probing. Adding the new UI must not
    // silently switch their route before the user saves a choice; fresh installs still default to CC.
    const hasSavedSettings = Object.keys(rows).length > 0;
    if (hasSavedSettings) {
      if (rows.mainModelProtocol === undefined) nextSettings.mainModelProtocol = undefined;
      if (rows.executorModelProtocol === undefined) nextSettings.executorModelProtocol = undefined;
    }
    const repairs: Partial<AppSettings> = {};
    // Persist the fresh-install defaults with the initial profile, so its next reload is not
    // mistaken for a legacy database. Existing settings receive no protocol migration writes.
    if (!hasSavedSettings) {
      repairs.mainModelProtocol = nextSettings.mainModelProtocol;
      repairs.executorModelProtocol = nextSettings.executorModelProtocol;
    }

    // 【模型配置方案使能】方案列表为空时创建默认方案：以当前生效配置（三组九键+多模态开关/思考档位）
    // 为快照源（对齐 profiles-save 的另存为语义，含 ModelProfile 全部 14 个配置键的合理默认值），
    // 保证首启/清空后始终存在一个可用方案，前端方案 Select 不再因空列表被禁用；创建后持久化写回 settings 表。
    if (nextSettings.modelProfiles.length === 0) {
      const defaultProfile: ModelProfile = {
        id: uuidv4(),
        name: '默认方案',
        mainModelBaseUrl: nextSettings.mainModelBaseUrl,
        mainModelApiKey: nextSettings.mainModelApiKey,
        mainModelName: nextSettings.mainModelName,
        mainModelMultimodal: nextSettings.mainModelMultimodal,
        mainThinkingLevel: nextSettings.mainThinkingLevel,
        mainModelProtocol: nextSettings.mainModelProtocol,
        executorModelBaseUrl: nextSettings.executorModelBaseUrl,
        executorModelApiKey: nextSettings.executorModelApiKey,
        executorModelName: nextSettings.executorModelName,
        executorThinkingLevel: nextSettings.executorThinkingLevel,
        executorModelProtocol: nextSettings.executorModelProtocol,
        visionLlmBaseUrl: nextSettings.visionLlmBaseUrl,
        visionLlmApiKey: nextSettings.visionLlmApiKey,
        visionLlmModel: nextSettings.visionLlmModel,
      };
      nextSettings.modelProfiles = [defaultProfile];
      repairs.modelProfiles = nextSettings.modelProfiles;
    }

    // 【模型配置方案使能】activeProfileId 为空或指向不存在的方案但方案列表非空时，
    // 自动补选第一个方案并持久化写回，保证链路C（修改配置写回激活方案）不因激活键为空静默失效。
    const activeProfileIdValid = nextSettings.modelProfiles.some(
      (item) => item.id === nextSettings.activeProfileId,
    );
    if (nextSettings.modelProfiles.length > 0 && !activeProfileIdValid) {
      nextSettings.activeProfileId = nextSettings.modelProfiles[0].id;
      repairs.activeProfileId = nextSettings.activeProfileId;
    }

    if (Object.keys(repairs).length) writeSettingsTransaction(getDb(), repairs);
    const previous=this.settings;
    this.settings = nextSettings;
    this.notifyModelConfigurationChanged(previous);
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
    return {
      APP_VERSION: app.getVersion(),
      APP_NAME: 'Delepi',
      APP_PLATFORM: process.platform,
      APP_DATA_DIR: app.getPath('userData'),
    };
  }
}

/** 全局单例 */
export const configManager = new ConfigManager();
