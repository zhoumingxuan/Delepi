﻿/**
 * 智能体相关常量
 * 归集自 executor-agent.ts、executor-structured-payload.ts、main-agent.ts、title-generation.ts
 */

import path from 'node:path';

import { app } from 'electron';

// ============================================================
// 工作流模板
// ============================================================

/** 最大工作流模板数量（内置+自定义合并计数） */
export const MAX_WORKFLOW_TEMPLATE_COUNT = 3;

/** 自定义技能标签数量上限（不含内置8项） */
export const CUSTOM_TASK_TAG_LIMIT = 16;

/** 单个自定义模板最大字符数（与内置最大模板同量级，防上下文 token 膨胀） */
export const CUSTOM_TEMPLATE_MAX_LENGTH = 16000;

/** 执行子智能体技能目录（生产：打包 resources/skills；开发：项目根 skills） */
export const EXECUTOR_WORKER_SKILLS_DIR = path.join(
  app.isPackaged ? process.resourcesPath : process.cwd(),
  'skills',
);

/** 工具进度名称映射 */
export const EXECUTOR_TOOL_PROGRESS_NAMES: Record<string, string> = {
  inspect_image: '图片识别',
  run_exe: '命令行执行',
  run_with_python: 'Python 脚本执行',
};

/**
 * 工具进度名解析（S5-4 方向5：函数式查找——内置映射 + 动态工具三级回退）。
 * 内置工具（dynamicToolMeta 为 null/undefined）：EXECUTOR_TOOL_PROGRESS_NAMES[toolName] ?? toolName，
 *   与改造前直查映射行为逐字节一致（S5-1 等价性约束）。
 * 动态工具三级回退：manifest.progressName → displayName → 工具 name（A5-3；displayName 为 manifest
 *   必填项保证回退链终点非空）。
 */
export function resolveExecutorToolProgressDisplayName(
  toolName: string,
  dynamicToolMeta?: { progressName?: string; displayName?: string } | null,
): string {
  if (dynamicToolMeta) {
    return dynamicToolMeta.progressName || dynamicToolMeta.displayName || toolName;
  }
  return EXECUTOR_TOOL_PROGRESS_NAMES[toolName] ?? toolName;
}

// ============================================================
// 执行子智能体
// ============================================================

/** 最终输出修复最大尝试次数 */
export const MAX_EXECUTOR_FINAL_OUTPUT_REPAIR_ATTEMPTS = 3;

/** 委派参数校验失败重试上限（主智能体当轮重生成，超限走 MAIN_AGENT_ERROR_EVENT 终止） */
export const DELEGATE_ARGUMENTS_RETRY_LIMIT = 3;

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

/** 执行子智能体内置技能标签（只读锁定：现有8项一字不动、不可删除；内置模板映射不可被自定义覆盖） */
export const BUILTIN_TASK_TAGS = [
  '问题诊断',
  '方案设计',
  '自动化交互',
  '用例编写',
  '用例执行',
  '执行变更',
  '调查研究',
  '视觉设计',
] as const;
export type TaskTag = (typeof BUILTIN_TASK_TAGS)[number];

/** 运行时链使用的宽化标签名（内置∪自定义）；内置 TaskTag 联合类型保留用于内置模板映射 Record 的类型级锁定（D2R3） */
export type TaskTagName = string;

/** 兼容别名（既有导出消费兼容；语义=内置只读标签集合） */
export const TASK_TAGS = BUILTIN_TASK_TAGS;

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


/** 内置任务标签集合（O(1) 查找；只读锁定=内置8项，用于自定义重名校验；放行集合统一走 getAllTaskTags 合并层） */
export const TASK_TAG_SET: ReadonlySet<string> = new Set<string>(BUILTIN_TASK_TAGS);

/**
 * 合并层取值函数：内置∪启用自定义技能标签（放行链三关统一数据源）。
 * 内置优先且内置名占用不可被自定义覆盖；停用（enabled=false）标签不进入放行链；自动去重。
 * customSkillTags 形参按结构最小约定收窄（避免常量层依赖 config 模块）。
 */
export function getAllTaskTags(
  customSkillTags?: ReadonlyArray<{ name?: unknown; enabled?: unknown }>,
): string[] {
  const merged: string[] = [...BUILTIN_TASK_TAGS];
  if (!Array.isArray(customSkillTags)) {
    return merged;
  }
  for (const item of customSkillTags) {
    const name = item && typeof (item as { name?: unknown }).name === 'string'
      ? (item as { name: string }).name.trim()
      : '';
    if (!name || TASK_TAG_SET.has(name) || merged.includes(name)) {
      continue;
    }
    if ((item as { enabled?: unknown }).enabled === false) {
      continue;
    }
    merged.push(name);
  }
  return merged;
}

/** 已知交付类型集合（性能优化：O(1) 查找） */
export const EXECUTOR_DELIVERY_TYPE_SET: ReadonlySet<string> = new Set<string>(EXECUTOR_DELIVERY_TYPES);
