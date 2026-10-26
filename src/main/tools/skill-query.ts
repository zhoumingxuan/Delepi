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

/**
 * 技能内容查询工具（query_skill）执行体：owner 由注册侧固定（executor=执行子智能体 / main=主智能体），双端共用本实现。
 * 返回技能完整内容（技能模板全文）与该技能适用条件，供模型按需遵守。
 */
export async function skillQuery(
  input: unknown,
  _context: ToolRuntimeContext,
  owner: SkillOwner = 'executor',
): Promise<ToolResult> {
  const args = (input ?? {}) as SkillQueryInput;
  const skillTag = typeof args.skill_tag === 'string' ? args.skill_tag.trim() : '';

  if (!skillTag) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'skill_tag 缺失（未提供），期望为技能清单内的技能标签字符串',
    });
  }

  const allowed = new Set((await buildSkillInventory(owner)).map((entry) => entry.技能标签));
  if (!allowed.has(skillTag)) {
    const inventoryText = [...allowed].join('、');
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: `技能标签「${skillTag}」不在当前智能体技能清单内，允许值：${inventoryText}`,
    });
  }

  const result = await readSkillContent(owner, skillTag);
  if (!result.ok) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: result.error,
    });
  }

  return buildToolResult({
    success: true,
    code: ERR_OK,
    message: [
      `# 技能【${skillTag}】完整内容`,
      '```',
      result.content,
      '```',
    ].join('\n'),
  });
}
