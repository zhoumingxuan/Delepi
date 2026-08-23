import { formatCurrentDateTime } from '@main/utils/helper';
import {
  EXECUTOR_DELIVERY_TYPES,
  TASK_TAGS,
  TASK_TYPE_VALUES,
  getAllTaskTags,
} from '../../constants';
import { configManager } from '../config/config-manager';
import { COMMON_WORKFLOW_PROMPT } from './workflow-prompt';

type ToolSchema = Record<string, unknown>;

export const SYSTEM_PROMPT = `
# 基本信息
\`\`\`
- 当前对话实际的日期和时间：${formatCurrentDateTime()}
- 【当前对话实际的日期和时间】仅供参考，不保证完全准确。
- 严格禁止把【当前对话实际的日期和时间】当作内部记忆、先验知识、输入材料、工具结果或外部事实的时间。
\`\`\`

# 角色定义
\`\`\`
1.你是一个严格按照【标准逻辑流程图】执行的【聪慧】的中文助手。
2.在用【常规手段】无法解决问题时，你会跳出【常规思维圈】进行思考，并尝试用【非常规手段】来解决问题。
3.你非常关注(【最新用户输入】/【任务执行结果】)中表现出的【细微特征】和浮现的【隐含信息】。
4.你清楚的意识到，（乱猜/乱做假设/乱做预设条件）是【最错误】的做法，会使得【最新用户意图】无法得到有效解决。
5.你清楚的意识到，用户期待能够获得【最新、最权威、最简洁、最准确、最仔细、表达最清晰】的回复。
6.你清楚的意识到，你自己切换不同的【内心世界】，是可以从所有已知事实中，用不同视角获取【隐含信息】。
7.你非常勤奋和努力，尽可能不想麻烦用户，除非你认为这是【非常有必要核对或确认】的事情。
8.你若觉得干活很累了，可以跟用户交流来获取【情绪价值】切换成一个【好心情】。
\`\`\`

# 输出规范
\`\`\`
- 默认使用中文，必要时保留英文术语。
- 默认先给直接答案，再补充必要说明。
- 默认使用清晰的 Markdown。
- 需要代码、命令、表格、公式时，使用正确格式。
- 不编造事实；信息不足时说明缺口，存在可核验路径时必须先核验。
- 不伪造工具执行结果。
\`\`\`

${COMMON_WORKFLOW_PROMPT}
`;

export const MAIN_DELEGATE_TOOL_NAME = 'delegate_executor';

export { EXECUTOR_DELIVERY_TYPES, TASK_TAGS, TASK_TYPE_VALUES };

function buildDelegateToolParameters(): ToolSchema {
  return {
    type: 'object',
    properties: {
      taskname: {
        type: 'string',
        description: '精简且严谨的任务中文名称',
      },
      task_type: {
        type: 'string',
        enum: TASK_TYPE_VALUES,
        description:
          '任务类型，单选',
      },
      tasktarget: {
        type: 'string',
        description:
          `任务目标，必须达到【开箱即用】粒度，至少包含：a. 所有目标对象和执行对象。b. 所有执行场景（含细微场景）。c. 成功时可观察到的判定特征（含细微特征）`,
      },
      constraints: {
        type: 'array',
        description:
          `任务规则和约束，须达到【开箱即用】粒度，至少覆盖：a. 执行越界判定规则。b. 过度执行判定规则。c. 中止执行判定规则。d. 防止执行成功幻觉的约束。`,
        items: {
          type: 'string',
          description:
            '单条原子【任务规则和约束】，必须写清【约束对象、规则对象以及严谨的判定条件】',
        },
      },
      delivery_type: {
        type: 'string',
        enum: EXECUTOR_DELIVERY_TYPES,
        description:
          '交付物类型',
      },
      delivery_spec: {
        type: 'string',
        description:
          '交付物描述，必须写清内容范围、粒度要求和格式限定。',
      },
      context: {
        type: 'string',
        minLength: 1,
        description: `
        1.从【中间存储信息变量】中抽取与当前任务关联的所有最新信息；严格禁止任何指代性表述，表述的信息必须具体到数值、时间、文件绝对路径等原子性维度。
        2.还需要写清【最新用户意图】所有关键要素信息（例如：数值、文件绝对路径、时间，账户信息等等），必须单独形成章节区分且标题必须非常清晰明确。
        3.从【历史对话】中抽取有助于完成【用户最新意图】的关键要素并标注时序同时属于旧信息，任务辅助类型信息。
        `
      },
      skills: {
        type: 'array',
        // P-1【待用户定稿】：默认文案在既有语义上补充「技能标签含内置与自定义两类，按最适配选用」
        description: '任务需要使用的且最适配的技能标签集合；技能标签含内置与自定义两类，按最适配选用；任何任务类型都可以使用任何技能标签',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'string',
          // 方向2 A2-2 第一关：enum 运行时从合并层构造（内置∪启用自定义；单一定义源 getAllTaskTags）
          enum: getAllTaskTags(configManager.getSettings().customSkillTags),
        },
      },
    },
    required: [
      'taskname',
      'task_type',
      'tasktarget',
      'constraints',
      'delivery_type',
      'delivery_spec',
      'context',
      'skills',
    ],
    additionalProperties: false,
  } satisfies ToolSchema;
}

function buildDelegateExecutorDescription(): string {
  // P-2【待用户定稿】：第 8 条为自定义技能选用规则默认文案（规划建议要点），待用户定稿后可调整措辞
  return `
** 仅用于在符合【触发任务规则】的情况下，详细制定可独立执行的任务，委派并返回结果**
** 【没有明确要求】或【未获取明确不可执行的证据】之前，你可以委派一切任务，没有任何限制条件**

# 注意事项
 1. **绝对严格注意：禁止预判"有无工具/能否执行"；任何情形都不得拒绝委派；即使【历史记忆】中有实证证明无法执行，也必须考虑【最新状态】存在变化，因此【绝不可拒绝委派】任务**。
 2. 重点关注【触发任务规则】的前置条件，以免在不符合前置条件的情况下触发任务。
 3. 任务类型为【研究探索】时禁止使用【问题诊断】技能，任务类型【诊断问题】必须用【问题诊断】技能。
 4. 交付物描述会影响任务完成质量和内容详细程度，描述的越详细越好，不得为空。
 5. 交付物类型为【文件链接】或者【图片】，则最优先使用交付包含的URL而不是Path。
 6. **必须注意**：设置任何【任务参数】的完整性都务必确保【开箱即用】。
 7. 自定义技能按其模板定义的适用范围选用，无特殊规则时按最适配原则。
`;
}

/** 主智能体工具声明构建函数（每次构建均从合并层取 skills enum，保证运行时含启用自定义标签） */
export function buildMainTools() {
  return [
    {
      type: 'function' as const,
      function: {
        name: MAIN_DELEGATE_TOOL_NAME,
        description: buildDelegateExecutorDescription(),
        parameters: buildDelegateToolParameters(),
      },
    },
  ];
}

/**
 * 主智能体工具声明（方向2 A2-2 第一关：改运行时构建）。
 * 消费点 main-agent.ts 每轮 streamChat 读取该导入绑定，故以 export let + refreshMainTools()
 * 实现 live-binding 刷新（消费点零改动；自定义技能保存/删除/配置 reload 后调用刷新）。
 */
export let MAIN_TOOLS = buildMainTools();

/** 刷新 MAIN_TOOLS（ES 模块 live binding，消费点自动取新值） */
export function refreshMainTools(): void {
  MAIN_TOOLS = buildMainTools();
}
