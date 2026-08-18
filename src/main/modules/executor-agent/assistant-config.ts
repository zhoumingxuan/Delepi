/**
 * Assistant 运行时配置类型
 * 适配自参考项目 E:\ai_fr
 * 简化版：仅保留 executor-agent 需要的字段
 */

import type { ModelConfig } from '../llm/openai-client';

export interface AssistantRuntimeConfig {
  /** 主模型配置 */
  mainModel: ModelConfig;
  /** 执行子智能体模型配置 */
  executorModel: ModelConfig;
}
