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

  // 视觉模型
  visionLlmApiKey: '',
  visionLlmBaseUrl: '',
  visionLlmModel: '',
  useBuiltinPython: true,
  customPythonPath: '',

  // pip 依赖管理
  pipPackageLevel: 'recommended',
  pipMirrorUrl: 'https://pypi.org/simple/',
  pipAutoBootstrap: true,
};

/** 单次最多上传文件数 */
export const MAX_UPLOAD_COUNT = 10;

/** 图片最大宽度（超过则缩放） */

/** 图片最大高度（超过则缩放） */
