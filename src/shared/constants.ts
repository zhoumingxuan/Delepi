/**
 * 跨进程共享的常量定义
 * 主进程和渲染进程均从此文件导入
 */

import type { AppSettings } from './types/config';
import { UPDATE_BASE_URL_SOURCE_DEFAULT } from './update-constants';

/** 默认对话标题（fallback） */
export const DEFAULT_CONVERSATION_TITLE = '新对话';

/** 应用可配配置默认值（主进程和渲染进程共用同一份） */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  mainModelBaseUrl: '',
  mainModelApiKey: '',
  mainModelName: '',
  mainModelMultimodal: true,
  mainThinkingLevel: 'high',
  mainModelProtocol: 'cc',

  executorModelBaseUrl: '',
  executorModelApiKey: '',
  executorModelName: '',
  // 子智能体推理档位默认 max（主智能体默认 high；默认值仅作缺省读取合并——不写库不迁移，存量非空档位不受影响）
  executorThinkingLevel: 'max',
  // 子智能体触发上下文压缩阈值（字符数）默认 ''=不设置；可选 64K/128K/256K（默认值仅作缺省读取合并——不写库不迁移）
  executorContextCompressionThreshold: '',
  executorModelProtocol: 'cc',

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

  // 值守模式：键白名单硬要求同上（必须与 AppSettings 同步，否则 reload 静默丢弃）
  watchEnabled: false,
  watchMailboxAddress: '',
  watchMailboxAuthCode: '',
  watchPollIntervalMinutes: 2,
  watchReceiptRecipient: '',

  // 邮箱服务商（阶段7 目标3）：键白名单硬要求同上，必须与 AppSettings 逐键同步
  mailProviderType: 'qq',
  mailCustomImapHost: '',
  mailCustomImapPort: 993,
  mailCustomImapEncryption: 'ssl',
  mailCustomSmtpHost: '',
  mailCustomSmtpPort: 465,
  mailCustomSmtpEncryption: 'ssl',

  // 客户端自动更新：键白名单硬要求同上（必须与 AppSettings 逐键同步，否则 reload 静默丢弃）
  updateAutoCheckEnabled: true,
  updateBaseUrl: UPDATE_BASE_URL_SOURCE_DEFAULT,

};

/** 单次最多上传文件数 */
export const MAX_UPLOAD_COUNT = 10;

/** 图片最大宽度（超过则缩放） */

/** 图片最大高度（超过则缩放） */
