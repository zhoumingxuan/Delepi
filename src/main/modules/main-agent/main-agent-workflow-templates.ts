/**
 * 主智能体内置技能模板注册表（主智能体专属载体）
 * 载体内涵：主智能体两项技能（思路设计/推理分析）的模板 id、kind、标题、描述与正文相对路径。
 * 与执行者载体 executor-agent/executor-workflow-templates.ts 零交叉：执行者侧只承载九项执行者技能。
 * 主技能正文目录：MAIN_AGENT_SKILLS_DIR（生产 resources/main-skills；开发 项目根 main-skills）。
 */
import { BUILTIN_MAIN_TASK_TAGS } from '../../constants';

export type MainAgentWorkflowTemplateId =
  | 'approach_design'
  | 'reasoning_analysis';

export type MainAgentWorkflowTemplateKind = 'specific';

export type MainAgentWorkflowTemplate = {
  id: MainAgentWorkflowTemplateId;
  kind: MainAgentWorkflowTemplateKind;
  title: string;
  description: string;
  fileName: string;
};

export const MAIN_AGENT_WORKFLOW_TEMPLATES: Record<
  MainAgentWorkflowTemplateId,
  MainAgentWorkflowTemplate
> = {
  approach_design: {
    id: 'approach_design',
    kind: 'specific',
    title: '思路设计',
    description: '用于目标问题已明确、解决路径尚未确定，需要发散多条思路并比较收敛为唯一设计思路的任务。',
    fileName: 'approach-design/approach-design.md',
  },
  reasoning_analysis: {
    id: 'reasoning_analysis',
    kind: 'specific',
    title: '推理分析',
    description: '用于待证结论已经提出、支撑该结论的事实与推导尚未逐条核验，需要补齐推导链并检索反例后判定其成立性的分析类任务。',
    fileName: 'reasoning-analysis/reasoning-analysis.md',
  },
};

/** 主智能体任务标签 → 主模板 id（键类型直取 BUILTIN_MAIN_TASK_TAGS，标签归属变更时编译期强制同步） */
export const MAIN_TASK_TAG_WORKFLOW_TEMPLATE_ID: Record<
  (typeof BUILTIN_MAIN_TASK_TAGS)[number],
  MainAgentWorkflowTemplateId
> = {
  思路设计: 'approach_design',
  推理分析: 'reasoning_analysis',
};
