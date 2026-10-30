/**
 * 跨进程共享的配置类型定义
 * 主进程和渲染进程均从此文件导入 AppSettings 类型
 */


/**
 * 模型档案：主/子/视觉三组模型配置完整快照 + 执行子智能体思考档位。
 * visionEnabled 为视觉识别总开关，保持全局语义不入档（切换档案不改变总开关状态）。
 * 档案切换 = 把档案内全部配置键批量写回 AppSettings 当前生效九键 + 开关/档位/协议。
 * 协议两键可选：存量档案与 config-manager 默认方案构造缺键时，切换逐键 if (value === undefined) continue 兜底（保持当前生效协议不动）。
 */
export interface ModelProfile {
  /** 档案唯一标识（uuid） */
  id: string;
  /** 档案名称（用户可读，另存为时同名覆盖） */
  name: string;
  // 主智能体模型
  mainModelBaseUrl: string;
  mainModelApiKey: string;
  mainModelName: string;
  mainModelMultimodal: boolean;
  mainThinkingLevel: '' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  mainModelProtocol?: 'cc' | 'responses';
  // 执行子智能体模型
  executorModelBaseUrl: string;
  executorModelApiKey: string;
  executorModelName: string;
  executorThinkingLevel: '' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 执行子智能体触发上下文压缩阈值（字符数，默认 ''=不设置；可选 64K/128K/256K 档位；必需键：所有档案构造点显式携带，切换逐键写回） */
  executorContextCompressionThreshold: '' | '64K' | '128K' | '256K';
  executorModelProtocol?: 'cc' | 'responses';
  // 视觉模型
  visionLlmBaseUrl: string;
  visionLlmApiKey: string;
  visionLlmModel: string;
}

/**
 * 邮箱服务商类型（阶段7 目标3）：
 * - 'qq'：内置 QQ 邮箱 provider（imap.qq.com:993 隐式 TLS / smtp.qq.com:465 隐式 TLS）
 * - 'custom'：其他邮箱，端点由 mailCustomImap* / mailCustomSmtp* 六个键自定义
 */
export type MailProviderType = 'qq' | 'custom';

/**
 * 邮件端点加密方式（阶段7 目标3）：
 * - 'ssl'：隐式 TLS（IMAPS / SMTPS，建连即 TLS 握手）
 * - 'starttls'：明文建连后经 STARTTLS 命令升级为 TLS
 * 不提供 'plain'（明文凭据）选项：授权码等价密码，明文传输视为不可接受的安全缺陷。
 */
export type MailSocketEncryption = 'ssl' | 'starttls';

/**
 * 自定义技能标签元数据（settings 新键 customSkillTags 的数组元素）。
 * 内置9标签只读锁定：name 不可与内置重名；内置模板映射不可被自定义覆盖。
 */
/** 技能归属（主智能体/执行子智能体二值；内置归属由常量锁定，自定义技能按本字段归属） */
export type SkillOwner = 'main' | 'executor';

export interface CustomSkillTag {
  /** 技能标签名（自定义集合内唯一；不可与内置9标签重名） */
  name: string;
  /** 模板目录 slug（userData/custom-skills/<slug>/template.md；新建后锁定不变） */
  slug: string;
  /** 模板注入标题（包装为「##【{title}】技能」代码块） */
  title: string;
  /** 模板描述（技能管理列表展示；对外作为该技能的适用条件） */
  description: string;
  /** 启用状态（停用后不进入清单与 enum，元数据保留） */
  enabled: boolean;
  /** 技能归属（'main'=主智能体技能；'executor'=执行子智能体技能；存量数据缺失时按 'executor' 懒归一） */
  owner: SkillOwner;
}

/** 应用可配配置 */
export interface AppSettings {
  // 主智能体模型
  mainModelBaseUrl: string;
  mainModelApiKey: string;
  mainModelName: string;
  /** 主模型是否启用多模态协议（默认 true） */
  mainModelMultimodal: boolean;
  /** 主智能体思考程度/推理档位（默认 'high'；''=不设置=请求体不带 reasoning_effort，服务端走默认档位；可选 minimal/low/medium/high/xhigh/max） */
  mainThinkingLevel: '' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 主智能体 API 协议（默认 'cc'=Chat Completion；'responses'=OpenAI Response API 端点；指定协议后 init 失败直接报错，不自动降级） */
  mainModelProtocol: 'cc' | 'responses';

  // 执行子智能体模型
  executorModelBaseUrl: string;
  executorModelApiKey: string;
  executorModelName: string;
  /** 执行子智能体思考程度/推理档位（默认 'max'；''=不设置=请求体不带 reasoning_effort，服务端走默认档位；可选 minimal/low/medium/high/xhigh/max） */
  executorThinkingLevel: '' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 执行子智能体触发上下文压缩阈值（字符数，默认 ''=不设置；可选 64K/128K/256K 档位） */
  executorContextCompressionThreshold: '' | '64K' | '128K' | '256K';
  /** 执行子智能体 API 协议（默认 'cc'=Chat Completion；'responses'=OpenAI Response API 端点） */
  executorModelProtocol: 'cc' | 'responses';

  // 视觉模型
  visionLlmApiKey: string;
  visionLlmBaseUrl: string;
  visionLlmModel: string;
  /** 视觉识别总开关（默认 true）：关闭时 inspect_media 工具禁用，主智能体多模态同步关闭 */
  visionEnabled: boolean;

  // 模型档案（多槽位）
  /** 模型档案列表（默认 []；档案 = 主/子/视觉三组完整快照 + 思考档位） */
  modelProfiles: ModelProfile[];
  /** 当前激活档案 id（默认 '' 表示未激活；切换成功后写入，删除激活档案时清空） */
  activeProfileId: string;

  // 自定义技能标签（方向2）
  /** 自定义技能标签元数据（默认 []；空自定义=行为与现状完全一致，为天然回滚态） */
  customSkillTags: CustomSkillTag[];
  /** 是否使用内置Python环境（默认 true）。
   *  true: 使用内置 embeddable Python 3.14.6
   *  false: 使用自定义 Python 环境 */
  useBuiltinPython: boolean;
  /** 自定义 Python 解释器路径（仅在 useBuiltinPython=false 时生效） */
  customPythonPath: string;

  // 值守模式（阶段1：配置层与界面骨架；收发同一账号，当前版本仅支持 QQ 邮箱）
  /** 值守模式总开关（默认 false；仅 watch:start / watch:stop / 自动恢复回落写回，阶段2起 config:save 直接写该键将被拒绝） */
  watchEnabled: boolean;
  /** 值守邮箱地址（默认 ''；收发同一账号：IMAP 轮询、SMTP 发件、指令收件人三合一；保存时 trim） */
  watchMailboxAddress: string;
  /** 值守邮箱授权码（默认 ''；QQ 邮箱「设置 → 账号 → POP3/IMAP/SMTP 服务」生成；任何界面/日志/回执中一律以 <QQ邮箱授权码> 占位，严禁明文外泄） */
  watchMailboxAuthCode: string;
  /** 轮询间隔（分钟；默认 2、最小 1、无上限夹紧；false 与 0 不被 reload 过滤，读取侧 normalizeWatchSettings 夹紧：非有限数/NaN→2、<1→1、非整数→向下取整） */
  watchPollIntervalMinutes: number;
  /** 回执收件人（默认 ''=回执发回值守邮箱自身；非空时须为合法邮箱） */
  watchReceiptRecipient: string;

  // 邮箱服务商（阶段7 目标3：provider 抽象；键白名单硬要求同值守五键）
  /** 邮箱类型（默认 'qq'）：'qq' 使用内置 QQ 端点；'custom' 使用下方自定义端点 */
  mailProviderType: MailProviderType;
  /** 自定义 IMAP 主机（默认 ''；mailProviderType='custom' 时必填） */
  mailCustomImapHost: string;
  /** 自定义 IMAP 端口（默认 993；读取侧夹紧为 1-65535） */
  mailCustomImapPort: number;
  /** 自定义 IMAP 加密方式（默认 'ssl'） */
  mailCustomImapEncryption: MailSocketEncryption;
  /** 自定义 SMTP 主机（默认 ''；mailProviderType='custom' 时必填） */
  mailCustomSmtpHost: string;
  /** 自定义 SMTP 端口（默认 465；读取侧夹紧为 1-65535） */
  mailCustomSmtpPort: number;
  /** 自定义 SMTP 加密方式（默认 'ssl'） */
  mailCustomSmtpEncryption: MailSocketEncryption;

  // 客户端自动更新（v1 仅两个配置键：不做「自动安装」「跳过版本」「通道」等扩展）
  /** 是否启用自动检查更新（默认 true；关闭后不再自动检查，仍可手动检查） */
  updateAutoCheckEnabled: boolean;
  /** 更新服务地址（空串=回落构建期默认值；默认值唯一来源见 update-constants.ts 的 UPDATE_BASE_URL_SOURCE_DEFAULT） */
  updateBaseUrl: string;

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
