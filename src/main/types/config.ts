/**
 * 配置相关类型定义
 * AppSettings 已移至 @shared/types/config，此处 re-export
 */

import type { AppSettings } from '@shared/types/config';
export type { AppSettings } from '@shared/types/config';

/** 写死配置（不可变更） */
export interface HardcodedConfig {
  APP_DB_DRIVER: 'sqlite';
  FINAL_OUTPUT_DIR_FORMAT: string;
}

/** 只读配置（运行时推断） */
export interface ComputedConfig {
  APP_VERSION: string;
  APP_NAME: string;
  APP_PLATFORM: string;
  APP_DATA_DIR: string;
}

/** 联合配置类型 */
export interface AppConfig {
  hardcoded: HardcodedConfig;
  settings: AppSettings;
  computed: ComputedConfig;
}
