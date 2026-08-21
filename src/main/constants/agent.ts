/**
 * 智能体相关常量
 * 归集自 executor-agent.ts、executor-structured-payload.ts、main-agent.ts、title-generation.ts
 */

import path from 'node:path';

// ============================================================
// 工作流模板
// ============================================================

/** 最大工作流模板数量 */
export const MAX_WORKFLOW_TEMPLATE_COUNT = 3;

/** 执行子智能体技能目录 */
export const EXECUTOR_WORKER_SKILLS_DIR = path.join(
  process.cwd(),
  'skills',
);

/** 工具进度名称映射 */
export const EXECUTOR_TOOL_PROGRESS_NAMES: Record<string, string> = {
  inspect_image: '图片识别',
  run_exe: '命令行执行',
  run_with_python: 'Python 脚本执行',
};

// ============================================================
// 执行子智能体
// ============================================================

/** 最终输出修复最大尝试次数 */
export const MAX_EXECUTOR_FINAL_OUTPUT_REPAIR_ATTEMPTS = 3;

/** 修复提示中输出截断长度 */
export const EXECUTOR_OUTPUT_TRUNCATE_LENGTH = 8192;

/** 无效输出截断长度 */
export const EXECUTOR_INVALID_OUTPUT_TRUNCATE_LENGTH = 8192;

// ============================================================
// 主智能体
// ============================================================

/** 对话标题最大长度 */
export const MAX_CONVERSATION_TITLE_LENGTH = 28;

// ============================================================
// 最终输出协议解析
// ============================================================

/** JSON 代码块起始标记 */
export const JSON_CODE_BLOCK_START = '```json';

/** JSON 代码块结束标记 */
export const JSON_CODE_BLOCK_END = '```';

// ============================================================
// 交付类型判断用常量
// ============================================================

/** 图片交付类型 */
export const DELIVERY_TYPE_IMAGE = '图片';

/** 文件链接交付类型 */
export const DELIVERY_TYPE_FILE_LINK = '文件链接';


/** 方案交付类型 */
export const DELIVERY_TYPE_PLAN = '方案';

/** 详细规划交付类型 */
export const DELIVERY_TYPE_PLAN_BOOK = '详细规划';

/** 测试用例交付类型 */
export const DELIVERY_TYPE_TEST_CASE = '测试用例';

/** 图片交付类型对应的文件路径字段名 */
export const IMAGE_FILES_FIELD_NAME = 'image_files';

/** 图片交付类型对应的 FILE URL 字段名 */

/** 文件链接交付类型对应的文件路径字段名 */
export const LOCAL_FILES_FIELD_NAME = 'local_files';

/** 文件链接交付类型对应的 FILE URL 字段名 */
export const FILE_URLS_FIELD_NAME = 'can_openfile_url';


// ============================================================
// 任务类型 / 交付类型 / 技能标签（统一定义）
// 同步源：E:\ai_fr\lib\tools\main-registry.ts、
// E:\ai_fr\lib\chat\task-tags.ts、
// E:\ai_fr\lib\chat\executor-structured-payload.ts
// ============================================================

/** 主智能体可委派的任务类型 */
export const TASK_TYPE_VALUES = [
  '信息整理',
  '诊断问题',
  '研究探索',
  '设计方案',
  '统筹规划',
  '执行落地',
  '验收验证',
  '编写用例',
] as const;
export type TaskType = (typeof TASK_TYPE_VALUES)[number];

/** 执行子智能体可用的技能标签 */
export const TASK_TAGS = [
  '问题诊断',
  '方案设计',
  '自动化交互',
  '用例编写',
  '用例执行',
  '执行变更',
  '调查研究',
  '视觉设计',
] as const;
export type TaskTag = (typeof TASK_TAGS)[number];

/** 执行子智能体交付类型 */
export const EXECUTOR_DELIVERY_TYPES = [
  '线索集合',
  '权威结论',
  '方案',
  '详细规划',
  '文件链接',
  '图片',
  '测试用例',
] as const;
export type ExecutorDeliveryType = (typeof EXECUTOR_DELIVERY_TYPES)[number];


/** 已知任务标签集合（性能优化：O(1) 查找） */
export const TASK_TAG_SET: ReadonlySet<string> = new Set<string>(TASK_TAGS);

/** 已知交付类型集合（性能优化：O(1) 查找） */
export const EXECUTOR_DELIVERY_TYPE_SET: ReadonlySet<string> = new Set<string>(EXECUTOR_DELIVERY_TYPES);
