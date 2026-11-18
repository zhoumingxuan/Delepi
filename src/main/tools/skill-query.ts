/**
 * 技能内容查询工具（query_skill）
 * 双端共用执行体：owner 由注册侧固定（executor=执行子智能体 / main=主智能体）。
 */
import { type ToolRuntimeContext } from './runtime-context';
import { buildToolResult, type ToolResult } from './result';
import { ERR_INVALID_ARGUMENT, ERR_OK } from '../constants';
import {
  buildSkillInventory,
  readSkillContent,
  type SkillOwner,
} from '../modules/skill-system/skill-registry';

type SkillQueryInput = {
  skill_tag?: unknown;
};

/** 单个技能块（与单标签返回逐字一致：标题行 + 三重反引号包裹的正文） */
function buildSkillBlock(skillTag: string, content: string): string {
  return [
    `# 技能【${skillTag}】完整内容`,
    '```',
    content,
    '```',
  ].join('\n');
}

/** 入参缺失类错误（未提供 / 空字符串 / 空数组共用同一文案；数组可用性说明为本次新增） */
function buildMissingTagResult(): ToolResult {
  return buildToolResult({
    success: false,
    code: ERR_INVALID_ARGUMENT,
    message: 'skill_tag 缺失（未提供），期望为技能清单内的技能标签字符串或字符串数组',
  });
}

/** 数组元素非法（非字符串 / 空白字符串）错误 */
function buildInvalidItemResult(index: number, reason: string): ToolResult {
  return buildToolResult({
    success: false,
    code: ERR_INVALID_ARGUMENT,
    message: `skill_tag 数组第 ${index + 1} 项${reason}，期望为技能清单内的技能标签字符串`,
  });
}

/**
 * 技能内容查询工具（query_skill）执行体：owner 由注册侧固定（executor=执行子智能体 / main=主智能体），双端共用本实现。
 * 返回技能完整内容（技能模板全文）与该技能适用条件，供模型按需遵守。
 * 入参形态：单个字符串（主智能体侧既有形态，逐字保留原行为）或字符串数组（执行者侧批量形态，按入参顺序逐块返回）。
 */
export async function skillQuery(
  input: unknown,
  _context: ToolRuntimeContext,
  owner: SkillOwner = 'executor',
): Promise<ToolResult> {
  const args = (input ?? {}) as SkillQueryInput;
  const rawSkillTag = args.skill_tag;

  let skillTags: string[];
  if (Array.isArray(rawSkillTag)) {
    if (rawSkillTag.length === 0) {
      return buildMissingTagResult();
    }
    const collected: string[] = [];
    for (let index = 0; index < rawSkillTag.length; index += 1) {
      const item: unknown = rawSkillTag[index] as unknown;
      if (typeof item !== 'string') {
        return buildInvalidItemResult(
          index,
          `不是字符串（实际类型：${item === null ? 'null' : typeof item}）`,
        );
      }
      const tag = item.trim();
      if (!tag) {
        return buildInvalidItemResult(index, '为空字符串');
      }
      collected.push(tag);
    }
    skillTags = collected;
  } else {
    const skillTag = typeof rawSkillTag === 'string' ? rawSkillTag.trim() : '';
    if (!skillTag) {
      return buildMissingTagResult();
    }
    skillTags = [skillTag];
  }

  const allowed = new Set((await buildSkillInventory(owner)).map((entry) => entry.技能标签));
  const inventoryText = [...allowed].join('、');
  for (const skillTag of skillTags) {
    if (!allowed.has(skillTag)) {
      return buildToolResult({
        success: false,
        code: ERR_INVALID_ARGUMENT,
        message: `技能标签「${skillTag}」不在当前智能体技能清单内，允许值：${inventoryText}`,
      });
    }
  }

  const blocks: string[] = [];
  for (const skillTag of skillTags) {
    const result = await readSkillContent(owner, skillTag);
    if (!result.ok) {
      return buildToolResult({
        success: false,
        code: ERR_INVALID_ARGUMENT,
        message: result.error,
      });
    }
    blocks.push(buildSkillBlock(skillTag, result.content));
  }

  return buildToolResult({
    success: true,
    code: ERR_OK,
    message: blocks.join('\n\n'),
  });
}
