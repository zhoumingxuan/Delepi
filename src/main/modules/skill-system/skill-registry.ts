/**
 * 技能体系加载层
 * 职责：内置技能适用条件 yaml 读取（userData 覆写优先→归属对应内置目录→注册表 description 三级回退，永不抛错）、
 * 归属过滤技能清单构建（主/子技能集）、query_skill 工具数据源（技能内容查询）、
 * 主/执行两侧内置模板的归属判定与视图/白名单/正文读取（IPC 的唯一归属入口）。
 * 归属规则：主智能体四项标签 → main-agent/main-agent-workflow-templates（正文目录 MAIN_AGENT_SKILLS_DIR）；
 * 其余内置标签 → executor-agent/executor-workflow-templates（正文目录 EXECUTOR_WORKER_SKILLS_DIR）。
 * 本模块是两侧载体的唯一汇合点：两侧载体文件之间零互相 import。
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as yaml from 'js-yaml';

import {
  BUILTIN_MAIN_TASK_TAGS,
  BUILTIN_EXECUTOR_TASK_TAGS,
  EXECUTOR_WORKER_SKILLS_DIR,
  MAIN_AGENT_SKILLS_DIR,
} from '../../constants';
import {
  EXECUTOR_WORKFLOW_TEMPLATES,
  TASK_TAG_WORKFLOW_TEMPLATE_ID,
  getBuiltinOverridesDir,
  getCustomSkillTemplatePath,
  listCustomSkillTagMeta,
  readBuiltinTemplateContent,
  readCustomSkillTemplateContent,
} from '../executor-agent/executor-workflow-templates';
import {
  MAIN_AGENT_WORKFLOW_TEMPLATES,
  MAIN_TASK_TAG_WORKFLOW_TEMPLATE_ID,
} from '../main-agent/main-agent-workflow-templates';

/** 技能清单条目（对外唯一形态：仅两元素） */
export type SkillInventoryEntry = {
  技能标签: string;
  适用条件: string;
};

/** 内置适用条件文件名（固定名，与模板同目录） */
export const SKILL_CONDITION_FILE_NAME = 'skill.yaml';

/** 内置适用条件 yaml 载体 */
type BuiltinSkillConditionYaml = { name?: unknown; applicable_conditions?: unknown };

/** 归属范围（与 agent.ts SkillOwnerScope 同义；独立声明避免 constants↔shared 循环依赖） */
export type SkillOwner = 'main' | 'executor';

/** 内置模板最小结构（两侧注册表条目的公共投影，仅供本层按 owner 解析后统一消费） */
type BuiltinWorkflowTemplateShape = {
  id: string;
  title: string;
  description: string;
  fileName: string;
};

/** 内置模板视图（IPC skills:list 条目数据源：标签归属 + 标题/描述/正文相对路径） */
export type BuiltinSkillTemplateMeta = {
  owner: SkillOwner;
  title: string;
  description: string;
  fileName: string;
};

/** 内置标签归属判定（唯一运行时归属来源：主智能体四项标签集合成员判定，其余内置标签归执行子智能体） */
export function resolveBuiltinSkillOwner(tag: string): SkillOwner {
  return (BUILTIN_MAIN_TASK_TAGS as readonly string[]).includes(tag) ? 'main' : 'executor';
}

/** 归属 → 内置技能正文根目录（主源 main-skills／执行源 skills；打包后均为 resources 下同名目录） */
export function resolveBuiltinSkillsDir(owner: SkillOwner): string {
  return owner === 'main' ? MAIN_AGENT_SKILLS_DIR : EXECUTOR_WORKER_SKILLS_DIR;
}

/** 归属 + 标签 → 内置模板注册项（按 owner 分别查主源或执行源；该源未登记时返回 undefined） */
function resolveBuiltinTemplate(
  owner: SkillOwner,
  tag: string,
): BuiltinWorkflowTemplateShape | undefined {
  if (owner === 'main') {
    const templateId = MAIN_TASK_TAG_WORKFLOW_TEMPLATE_ID[
      tag as keyof typeof MAIN_TASK_TAG_WORKFLOW_TEMPLATE_ID
    ];
    return templateId ? MAIN_AGENT_WORKFLOW_TEMPLATES[templateId] : undefined;
  }
  const templateId = TASK_TAG_WORKFLOW_TEMPLATE_ID[
    tag as keyof typeof TASK_TAG_WORKFLOW_TEMPLATE_ID
  ];
  return templateId ? EXECUTOR_WORKFLOW_TEMPLATES[templateId] : undefined;
}

/** 主源内置模板正文相对路径集合（side 反查与白名单取值用） */
const BUILTIN_MAIN_FILE_NAMES: ReadonlySet<string> = new Set<string>(
  Object.values(MAIN_AGENT_WORKFLOW_TEMPLATES).map((template) => template.fileName),
);

/** 执行源内置模板正文相对路径集合（side 反查与白名单取值用） */
const BUILTIN_EXECUTOR_FILE_NAMES: ReadonlySet<string> = new Set<string>(
  Object.values(EXECUTOR_WORKFLOW_TEMPLATES).map((template) => template.fileName),
);

/** 内置模板白名单取值（IPC READ_TEMPLATE / SAVE_BUILTIN_OVERRIDE 共用；主4+执行9 双源合并） */
export function listBuiltinSkillTemplateFileNames(): string[] {
  return [...BUILTIN_MAIN_FILE_NAMES, ...BUILTIN_EXECUTOR_FILE_NAMES];
}

/** 内置模板 fileName → 归属（两源 fileName 命名空间互不重叠；未命中任一注册表返回 undefined） */
export function resolveSkillOwnerByFileName(fileName: string): SkillOwner | undefined {
  if (BUILTIN_MAIN_FILE_NAMES.has(fileName)) return 'main';
  if (BUILTIN_EXECUTOR_FILE_NAMES.has(fileName)) return 'executor';
  return undefined;
}

/** 内置技能模板视图（按标签归属解析；未登记返回 undefined） */
export function getBuiltinSkillTemplateMeta(tag: string): BuiltinSkillTemplateMeta | undefined {
  const owner = resolveBuiltinSkillOwner(tag);
  const template = resolveBuiltinTemplate(owner, tag);
  if (!template) return undefined;
  return {
    owner,
    title: template.title,
    description: template.description,
    fileName: template.fileName,
  };
}

/** 读取内置技能正文（IPC READ_TEMPLATE 数据源：按 fileName 判定归属 → 覆写优先 → 归属对应内置目录） */
export async function readBuiltinSkillTemplateContent(fileName: string): Promise<string> {
  const owner = resolveSkillOwnerByFileName(fileName);
  if (!owner) {
    throw new Error(`内置模板文件名不在主源/执行源任一注册表内: ${fileName}`);
  }
  return readBuiltinTemplateContent(fileName, resolveBuiltinSkillsDir(owner));
}

/** 读取单个内置技能适用条件（userData 覆写优先→归属对应内置 yaml→注册表 description 三级回退；永不抛错） */
async function readBuiltinApplicableCondition(
  owner: SkillOwner,
  tag: string,
): Promise<string> {
  const template = resolveBuiltinTemplate(owner, tag);
  const fallback = template?.description ?? '';
  if (!template) return fallback;
  const dirName = path.dirname(template.fileName);            // 如 'issue-location' / 'concept-design'
  for (const candidate of [
    path.join(getBuiltinOverridesDir(), dirName, SKILL_CONDITION_FILE_NAME),  // 覆写优先
    path.join(resolveBuiltinSkillsDir(owner), dirName, SKILL_CONDITION_FILE_NAME), // 归属对应内置目录
  ]) {
    try {
      const doc = yaml.load(await readFile(candidate, 'utf-8')) as BuiltinSkillConditionYaml | null;
      const condition = doc && typeof doc === 'object'
        && typeof doc.applicable_conditions === 'string'
        && doc.applicable_conditions.trim()
        ? doc.applicable_conditions.trim()
        : '';
      if (!condition) continue;
      if (typeof doc?.name === 'string' && doc.name.trim() && doc.name.trim() !== tag) {
        console.warn(`[skill-registry] skill.yaml name(${doc.name}) 与注册表标签(${tag})不一致，以注册表为准: ${candidate}`);
      }
      return condition;
    } catch (error) {
      console.warn(`[skill-registry] skill.yaml 读取/解析失败，回退注册表 description: ${candidate}, ${(error as Error).message}`);
    }
  }
  return fallback;
}

/** 读取单个内置技能适用条件（同步版：主智能体系统提示构建用；按 owner 双源，三级回退同异步版，永不抛错） */
function readBuiltinApplicableConditionSync(owner: SkillOwner, tag: string): string {
  const template = resolveBuiltinTemplate(owner, tag);
  const fallback = template?.description ?? '';
  if (!template) return fallback;
  const dirName = path.dirname(template.fileName);
  for (const candidate of [
    path.join(getBuiltinOverridesDir(), dirName, SKILL_CONDITION_FILE_NAME),
    path.join(resolveBuiltinSkillsDir(owner), dirName, SKILL_CONDITION_FILE_NAME),
  ]) {
    let text: string;
    try {
      text = readFileSync(candidate, 'utf-8');
    } catch {
      continue;
    }
    try {
      const doc = yaml.load(text) as BuiltinSkillConditionYaml | null;
      const condition = doc && typeof doc === 'object'
        && typeof doc.applicable_conditions === 'string'
        && doc.applicable_conditions.trim()
        ? doc.applicable_conditions.trim()
        : '';
      if (!condition) continue;
      if (typeof doc?.name === 'string' && doc.name.trim() && doc.name.trim() !== tag) {
        console.warn(`[skill-registry] skill.yaml name(${doc.name}) 与注册表标签(${tag})不一致，以注册表为准: ${candidate}`);
      }
      return condition;
    } catch (error) {
      console.warn(`[skill-registry] skill.yaml 读取/解析失败，回退注册表 description: ${candidate}, ${(error as Error).message}`);
    }
  }
  return fallback;
}

/** 构建指定归属的技能清单（内置分组 ∪ 启用且归属匹配的自定义；顺序=内置在前、自定义按存储序） */
export async function buildSkillInventory(owner: SkillOwner): Promise<SkillInventoryEntry[]> {
  const builtinTags = owner === 'main' ? BUILTIN_MAIN_TASK_TAGS : BUILTIN_EXECUTOR_TASK_TAGS;
  const entries: SkillInventoryEntry[] = [];
  for (const tag of builtinTags) {
    entries.push({ 技能标签: tag, 适用条件: await readBuiltinApplicableCondition(owner, tag) });
  }
  for (const custom of listCustomSkillTagMeta()) {
    if (!custom || custom.enabled !== true) continue;
    if ((custom.owner ?? 'executor') !== owner) continue;      // 存量无 owner 懒归一为 executor
    entries.push({ 技能标签: custom.name, 适用条件: (custom.description ?? '').trim() });
  }
  return entries;
}

/** 同步构建指定归属的技能清单（主智能体系统提示用；内置条件 readFileSync 直读，与 enum 同步性最强） */
export function listSkillTagsWithConditions(owner: SkillOwner): SkillInventoryEntry[] {
  const builtinTags = owner === 'main' ? BUILTIN_MAIN_TASK_TAGS : BUILTIN_EXECUTOR_TASK_TAGS;
  const entries: SkillInventoryEntry[] = [];
  for (const tag of builtinTags) {
    entries.push({ 技能标签: tag, 适用条件: readBuiltinApplicableConditionSync(owner, tag) });
  }
  for (const custom of listCustomSkillTagMeta()) {
    if (!custom || custom.enabled !== true) continue;
    if ((custom.owner ?? 'executor') !== owner) continue;
    if (!custom.name) continue;
    entries.push({ 技能标签: custom.name, 适用条件: (custom.description ?? '').trim() });
  }
  return entries;
}

/** 归属过滤标签集（同步零 IO：内置分组常量直拼 + 启用且归属匹配的自定义 name；schema enum 数据源） */
export function listSkillTags(owner: SkillOwner): string[] {
  const builtinTags: readonly string[] = owner === 'main' ? BUILTIN_MAIN_TASK_TAGS : BUILTIN_EXECUTOR_TASK_TAGS;
  const tags: string[] = [...builtinTags];
  for (const custom of listCustomSkillTagMeta()) {
    if (!custom || custom.enabled !== true) continue;
    if ((custom.owner ?? 'executor') !== owner) continue;
    if (!custom.name || tags.includes(custom.name)) continue;
    tags.push(custom.name);
  }
  return tags;
}

/** 技能内容查询（query_skill 工具数据源）：归属+标签双校验→模板全文（按归属读主源/执行源，内置覆写优先） */
export async function readSkillContent(owner: SkillOwner, skillTag: string): Promise<
  { ok: true; title: string; content: string } | { ok: false; error: string }
> {
  const tag = typeof skillTag === 'string' ? skillTag.trim() : '';
  const builtinSet = new Set<string>(owner === 'main' ? BUILTIN_MAIN_TASK_TAGS : BUILTIN_EXECUTOR_TASK_TAGS);
  if (builtinSet.has(tag)) {
    const template = resolveBuiltinTemplate(owner, tag);
    if (!template) {
      return { ok: false, error: `技能标签「${tag}」未在${owner === 'main' ? '主智能体' : '执行子智能体'}内置模板注册表中登记` };
    }
    try {
      const content = (await readBuiltinTemplateContent(template.fileName, resolveBuiltinSkillsDir(owner))).trim();
      if (!content) return { ok: false, error: `技能「${tag}」模板内容为空` };
      return { ok: true, title: template.title, content };
    } catch (error) {
      return { ok: false, error: `读取技能「${tag}」模板内容失败：${(error as Error).message}` };
    }
  }
  const custom = listCustomSkillTagMeta().find((item) => item && item.enabled === true && item.name === tag);
  if (custom && (custom.owner ?? 'executor') === owner) {
    try {
      const content = (await readCustomSkillTemplateContent(custom.slug)).trim();
      if (!content) {
        return { ok: false, error: `自定义技能「${tag}」模板内容为空：${getCustomSkillTemplatePath(custom.slug)}` };
      }
      return { ok: true, title: custom.title, content };
    } catch (error) {
      return { ok: false, error: `读取自定义技能「${tag}」模板内容失败：${(error as Error).message}` };
    }
  }
  return { ok: false, error: `技能标签「${tag}」不在当前智能体（${owner === 'main' ? '主智能体' : '执行子智能体'}）的技能清单内` };
}

/** query_skill 参数 Schema 工厂（双端逐字一致；enum 由调用方按归属注入，保证与技能清单同源最新） */
export function buildSkillQueryParameters(allowedTags: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      skill_tag: {
        type: 'string',
        enum: allowedTags,
        description: '必填。要查询的技能标签，必须从【技能清单】中按【适用条件】匹配后选择。',
      },
    },
    required: ['skill_tag'],
    additionalProperties: false,
  };
}
