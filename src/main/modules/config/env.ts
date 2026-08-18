/**
 * 环境变量与硬编码默认值
 */

import type { HardcodedConfig } from '../../types/config';

/** 写死配置（2项，不可变更） */
export const HARDCODED_CONFIG: HardcodedConfig = {
  APP_DB_DRIVER: 'sqlite',
  FINAL_OUTPUT_DIR_FORMAT: 'call_{seq}_{random}',
};

/** 默认最大 Token 数 */
export const DEFAULT_MAX_TOKENS = 16384;
