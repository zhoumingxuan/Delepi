/**
 * 跨进程共享的配置类型定义
 * 主进程和渲染进程均从此文件导入 AppSettings 类型
 */


/**
 * 模型档案：主/子/视觉三组模型配置完整快照 + 执行子智能体思考档位。
 * visionEnabled 为视觉识别总开关，保持全局语义不入档（切换档案不改变总开关状态）。
 * 档案切换 = 把档案内全部配置键批量写回 AppSettings 当前生效九键 + 开关/档位。
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
  mainThinkingLevel: 'low' | 'high' | 'max';
  // 执行子智能体模型
  executorModelBaseUrl: string;
  executorModelApiKey: string;
  executorModelName: string;
  executorThinkingLevel: 'low' | 'high' | 'max';
  // 视觉模型
  visionLlmBaseUrl: string;
  visionLlmApiKey: string;
  visionLlmModel: string;
}

/**
 * 自定义技能标签元数据（settings 新键 customSkillTags 的数组元素）。
 * 内置8标签只读锁定：name 不可与内置重名；内置模板映射不可被自定义覆盖。
 */
export interface CustomSkillTag {
  /** 技能标签名（自定义集合内唯一；不可与内置8标签重名） */
  name: string;
  /** 模板目录 slug（userData/custom-skills/<slug>/template.md；新建后锁定不变） */
  slug: string;
  /** 模板注入标题（包装为「##【{title}】工作方式」代码块） */
  title: string;
  /** 模板描述（技能管理列表展示） */
  description: string;
  /** 启用状态（停用后不进入放行链与 enum，元数据保留） */
  enabled: boolean;
}

/** 应用可配配置 */
export interface AppSettings {
  // 主智能体模型
  mainModelBaseUrl: string;
  mainModelApiKey: string;
  mainModelName: string;
  /** 主模型是否启用多模态协议（默认 true） */
  mainModelMultimodal: boolean;
  /** 主智能体思考程度（默认 'high'；档位对齐 openai-client ThinkingIntent 的 'low'|'high'|'max'，不含 medium） */
  mainThinkingLevel: 'low' | 'high' | 'max';

  // 执行子智能体模型
  executorModelBaseUrl: string;
  executorModelApiKey: string;
  executorModelName: string;
  /** 执行子智能体思考程度（默认 'max'；档位对齐 openai-client ThinkingIntent 的 'low'|'high'|'max'，不含 medium） */
  executorThinkingLevel: 'low' | 'high' | 'max';

  // 视觉模型
  visionLlmApiKey: string;
  visionLlmBaseUrl: string;
  visionLlmModel: string;
  /** 视觉识别总开关（默认 true）：关闭时 inspect_image 工具禁用，主智能体多模态同步关闭 */
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
