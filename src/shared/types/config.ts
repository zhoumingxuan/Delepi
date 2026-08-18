/**
 * 跨进程共享的配置类型定义
 * 主进程和渲染进程均从此文件导入 AppSettings 类型
 */

import type { DepsLevel } from './deps';

/** 应用可配配置 */
export interface AppSettings {
  // 主智能体模型
  mainModelBaseUrl: string;
  mainModelApiKey: string;
  mainModelName: string;
  /** 主模型是否启用多模态协议（默认 true） */
  mainModelMultimodal: boolean;

  // 执行子智能体模型
  executorModelBaseUrl: string;
  executorModelApiKey: string;
  executorModelName: string;

  // 视觉模型
  visionLlmApiKey: string;
  visionLlmBaseUrl: string;
  visionLlmModel: string;
  /** 是否使用内置Python环境（默认 true）。
   *  true: 使用内置 embeddable Python 3.14.6
   *  false: 使用自定义 Python 环境 */
  useBuiltinPython: boolean;
  /** 自定义 Python 解释器路径（仅在 useBuiltinPython=false 时生效） */
  customPythonPath: string;

  // pip 依赖管理
  /** 依赖包安装级别（默认 'core'）。
   *  'core': 核心6包 / 'recommended': 推荐14包 / 'full': 全部24包 */
  pipPackageLevel?: DepsLevel;
  /** pip 镜像源 URL（默认空字符串，使用官方 PyPI 源） */
  pipMirrorUrl: string;
  /** 是否自动引导安装 pip（默认 true） */
  pipAutoBootstrap?: boolean;
}

/**
 * config:get 返回结构（对齐参考项目 GET /api/config 语义）
 * 包含配置状态摘要和完整 AppSettings
 */
export interface ConfigGetResult {
  /** 是否已配置（至少一个模型的 apiKey 已设置） */
  configured: boolean;
  /** 当前主模型名称 */
  model: string;
  /** 当前主模型 API 地址 */
  baseUrl: string;
  /** 模型配置详情（向后兼容） */
  settings: AppSettings;
}

/** 配置就绪检查结果 */
export interface ConfigReadinessResult {
  /** 是否所有必要配置均已就绪 */
  isReady: boolean;
  /** 缺失的配置项列表 */
  missingItems: ConfigMissingItem[];
}

/** 配置缺失项详情 */
export interface ConfigMissingItem {
  /** 配置类型 */
  type: 'llm_config' | 'python_config';
  /** 配置项显示标签 */
  label: string;
  /** 指向的配置选项卡 */
  targetTab: 'model' | 'python';
  /** 缺失明细说明 */
  detail: string[];
}
