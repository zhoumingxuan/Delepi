import { access, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { app } from 'electron';

import type { CustomSkillTag } from '@shared/types/config';
import { configManager } from '../config/config-manager';
import {
  CUSTOM_TASK_TAG_LIMIT,
  EXECUTOR_WORKER_SKILLS_DIR,
  TASK_TAG_SET,
  getAllTaskTags,
} from '../../constants';
import type { TaskTag } from '../../constants';

export type ExecutorWorkflowTemplateId =
  | 'research_analysis'
  | 'issue_location'
  | 'solution_design'
  | 'change_execution'
  | 'simulation_operation'
  | 'use_case_writing'
  | 'use_case_execution'
  | 'visual_design';

export type ExecutorWorkflowTemplateKind = 'specific';

export type ExecutorWorkflowTemplate = {
  id: ExecutorWorkflowTemplateId;
  kind: ExecutorWorkflowTemplateKind;
  title: string;
  description: string;
  fileName: string;
};

export const EXECUTOR_WORKFLOW_TEMPLATES: Record<
  ExecutorWorkflowTemplateId,
  ExecutorWorkflowTemplate
> = {
  research_analysis: {
    id: 'research_analysis',
    kind: 'specific',
    title: '调查研究',
    description: '用于基于已知或可取得材料建立证据链，判断研究对象之间的事实关系、比较关系和结论成立性的任务。',
    fileName: 'research-analysis/research-analysis.md',
  },
  issue_location: {
    id: 'issue_location',
    kind: 'specific',
    title: '问题诊断',
    description: '用于报错、异常、差异、瓶颈、错误结果、状态不一致等问题追踪和根因定位类任务。',
    fileName: 'issue-location/issue-location.md',
  },
  solution_design: {
    id: 'solution_design',
    kind: 'specific',
    title: '方案设计',
    description: '用于方案、结构、接口、流程、数据、权限、交互和执行路径设计类任务。',
    fileName: 'solution-design/solution-design.md',
  },
  change_execution: {
    id: 'change_execution',
    kind: 'specific',
    title: '执行变更',
    description: '用于新增、修改、修复、重构、优化等会改变既有或新增产物的任务。',
    fileName: 'change-execution/change-execution.md',
  },
  simulation_operation: {
    id: 'simulation_operation',
    kind: 'specific',
    title: '自动化交互',
    description: '用于在授权范围内执行真实请求、浏览器、远程命令、界面交互、文件链路或截图识别，并取得可核验证据。',
    fileName: 'simulation-operation/simulation-operation.md',
  },
  use_case_writing: {
    id: 'use_case_writing',
    kind: 'specific',
    title: '用例编写',
    description: '用于按需求、变更、接口、流程、风险或验收口径设计可执行测试用例。',
    fileName: 'use-case-writing/use-case-writing.md',
  },
  use_case_execution: {
    id: 'use_case_execution',
    kind: 'specific',
    title: '用例执行',
    description: '用于按既有测试用例执行网站、API、单元和应用程序测试，并记录执行过程、阻塞和结果。',
    fileName: 'use-case-execution/use-case-execution.md',
  },
  visual_design: {
    id: 'visual_design',
    kind: 'specific',
    title: '视觉设计',
    description: '用于海报、封面、插画、图标、示意图、视觉素材等视觉内容的设计和生成类任务。',
    fileName: 'visual-design/visual-design.md',
  }
};

export const TASK_TAG_WORKFLOW_TEMPLATE_ID: Record<
  TaskTag,
  ExecutorWorkflowTemplateId
> = {
  问题诊断: 'issue_location',
  方案设计: 'solution_design',
  自动化交互: 'simulation_operation',
  用例编写: 'use_case_writing',
  用例执行: 'use_case_execution',
  执行变更: 'change_execution',
  调查研究: 'research_analysis',
  视觉设计: 'visual_design',
};

// ============================================================
// 自定义技能模板（运行时来源；上方内置注册表与映射 Record 只读锁定，不可被自定义覆盖）
// 载体：app.getPath('userData')/custom-skills/<slug>/template.md（固定名+纯 Markdown，
// 同构内置格式：无变量占位符、无 front matter；不进 skills 打包目录规避只读风险 D2R5）
// ============================================================

/** 自定义模板固定文件名 */
export const CUSTOM_SKILL_TEMPLATE_FILE_NAME = 'template.md';

/** 自定义技能模板根目录（userData/custom-skills） */
export function getCustomSkillsDir(): string {
  return path.join(app.getPath('userData'), 'custom-skills');
}

/** 自定义模板文件绝对路径：userData/custom-skills/<slug>/template.md */
export function getCustomSkillTemplatePath(slug: string): string {
  return path.join(getCustomSkillsDir(), slug, CUSTOM_SKILL_TEMPLATE_FILE_NAME);
}

// ============================================================
// 内置模板覆写层（方向2扩展：内置技能允许编辑模板内容；标签名/标题/描述常量锁定不动）
// 载体：userData/builtin-skill-overrides/<fileName>（fileName 含同构子目录）；执行链读取时
// 覆写优先（executor-agent readWorkflowTemplateContent），content=null 删除覆写=恢复默认
// ============================================================

/** 内置模板覆写根目录（userData/builtin-skill-overrides） */
export function getBuiltinOverridesDir(): string {
  return path.join(app.getPath('userData'), 'builtin-skill-overrides');
}

/** 内置模板覆写文件绝对路径：userData/builtin-skill-overrides/<fileName>（同构子目录） */
export function getBuiltinOverridePath(fileName: string): string {
  return path.join(getBuiltinOverridesDir(), fileName);
}

/** 读取内置模板内容（userData 覆写优先；无覆写回退内置目录；读取失败抛错由调用方处理） */
export async function readBuiltinTemplateContent(fileName: string): Promise<string> {
  const overridePath = getBuiltinOverridePath(fileName);
  let useOverride = false;
  try {
    await access(overridePath);
    useOverride = true;
  } catch {
    useOverride = false;
  }
  const templatePath = useOverride
    ? overridePath
    : path.join(EXECUTOR_WORKER_SKILLS_DIR, fileName);
  return readFile(templatePath, 'utf-8');
}

/** 写入内置模板覆写文件（mkdir 递归创建同构子目录） */
export async function writeBuiltinOverride(fileName: string, content: string): Promise<void> {
  const overridePath = getBuiltinOverridePath(fileName);
  await mkdir(path.dirname(overridePath), { recursive: true });
  await writeFile(overridePath, content, 'utf-8');
}

/** 删除内置模板覆写文件（恢复默认语义；覆写文件不存在则 no-op 幂等） */
export async function deleteBuiltinOverride(fileName: string): Promise<void> {
  const overridePath = getBuiltinOverridePath(fileName);
  try {
    await access(overridePath);
    await unlink(overridePath);
  } catch {
    // 覆写文件不存在：no-op
  }
}
/** 自定义 slug 合法性（[a-z0-9-]，首字符字母数字，≤64 字符） */
export function isValidCustomSkillSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);
}

/** 读取全部自定义技能标签元数据（settings.customSkillTags；异常容错返回 []） */
export function listCustomSkillTagMeta(): CustomSkillTag[] {
  const tags = configManager.getSettings().customSkillTags;
  return Array.isArray(tags) ? tags : [];
}

/** 读取启用状态的自定义技能标签元数据（放行链与模板映射的自定义来源） */
export function getEnabledCustomSkillTags(): CustomSkillTag[] {
  return listCustomSkillTagMeta().filter((item) => item && item.enabled === true);
}

/** 放行集合统一数据源：内置∪启用自定义（单一定义源，放行链三关共用） */
export function getAllowedTaskTagSet(): ReadonlySet<string> {
  return new Set<string>(getAllTaskTags(listCustomSkillTagMeta()));
}

/** skills:save 输入结构（新建/编辑共用；slug 由主进程管理：新建生成、编辑锁定） */
export interface CustomSkillTagSaveInput {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
  /** null = 保持现有模板文件不变（编辑元数据/启停场景，三通道约束下无模板读取通道）；新建时必填 */
  templateContent: string | null;
}

/**
 * 校验自定义技能标签输入（existingOthers=除自身外的既有自定义标签；空 issues=通过）。
 * 硬约束：不可与内置8标签重名（内置映射锁定不可被覆盖）；数量上限 CUSTOM_TASK_TAG_LIMIT。
 */
export function validateCustomSkillTagInput(
  input: CustomSkillTagSaveInput,
  existingOthers: ReadonlyArray<CustomSkillTag>,
  options: { isCreate: boolean },
): string[] {
  const issues: string[] = [];
  const name = (input.name ?? '').trim();
  const title = (input.title ?? '').trim();
  const description = (input.description ?? '').trim();
  const templateContent = input.templateContent;

  if (!name) {
    issues.push('标签名不能为空');
  } else if (name.length > 32) {
    issues.push('标签名长度不能超过 32 字符');
  } else if (TASK_TAG_SET.has(name)) {
    issues.push(`标签名「${name}」与内置技能标签重名（内置标签只读锁定，不可覆盖）`);
  }

  if (!title) {
    issues.push('模板标题不能为空');
  } else if (title.length > 64) {
    issues.push('模板标题长度不能超过 64 字符');
  }

  if (description.length > 200) {
    issues.push('模板描述长度不能超过 200 字符');
  }

  if (templateContent == null) {
    // 保持现有模板文件：仅新建场景必填
    if (options.isCreate) {
      issues.push('模板内容不能为空');
    }
  } else if (!templateContent.trim()) {
    issues.push('模板内容不能为空');
  }

  if (name && existingOthers.some((item) => item.name === name)) {
    issues.push(`标签名「${name}」已存在`);
  }
  if (existingOthers.length + 1 > CUSTOM_TASK_TAG_LIMIT) {
    issues.push(`自定义技能标签数量已达上限 ${CUSTOM_TASK_TAG_LIMIT} 个（不含内置8项）`);
  }

  return issues;
}

/** 写入自定义模板文件（mkdir 递归创建 <slug> 目录） */
export async function writeCustomSkillTemplate(slug: string, content: string): Promise<void> {
  const templatePath = getCustomSkillTemplatePath(slug);
  await mkdir(path.dirname(templatePath), { recursive: true });
  await writeFile(templatePath, content, 'utf-8');
}

/** 读取自定义模板内容（读取失败抛出，由调用方包装告警；内置模板维持现状 warn 行为） */
export async function readCustomSkillTemplateContent(slug: string): Promise<string> {
  const templatePath = getCustomSkillTemplatePath(slug);
  return (await readFile(templatePath, 'utf-8')).trim();
}

/** 删除自定义模板目录（userData/custom-skills/<slug>；连带删除，force 容错） */
export async function removeCustomSkillTemplateDir(slug: string): Promise<void> {
  await rm(path.join(getCustomSkillsDir(), slug), { recursive: true, force: true });
}