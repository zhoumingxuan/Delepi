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
