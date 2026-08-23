/**
 * 跨进程共享的常量定义
 * 主进程和渲染进程均从此文件导入
 */

import type { AppSettings } from './types/config';

/** 默认对话标题（fallback） */
export const DEFAULT_CONVERSATION_TITLE = '新对话';

/** 应用可配配置默认值（主进程和渲染进程共用同一份） */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  mainModelBaseUrl: '',
  mainModelApiKey: '',
  mainModelName: '',
  mainModelMultimodal: true,

  executorModelBaseUrl: '',
  executorModelApiKey: '',
  executorModelName: '',
  executorThinkingLevel: 'max',

  // 视觉模型
  visionLlmApiKey: '',
  visionLlmBaseUrl: '',
  visionLlmModel: '',
  visionEnabled: true,

  // 模型档案（多槽位）
  modelProfiles: [],
  activeProfileId: '',

  // 自定义技能标签（方向2；键白名单硬要求：必须与 AppSettings 同步，否则 reload 静默丢弃）
  customSkillTags: [],
  useBuiltinPython: true,
  customPythonPath: '',

};

/** 单次最多上传文件数 */
export const MAX_UPLOAD_COUNT = 10;

/** 图片最大宽度（超过则缩放） */

/** 图片最大高度（超过则缩放） */
