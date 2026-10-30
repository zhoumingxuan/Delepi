import { formatCurrentDateTime } from '@main/utils/helper';
import {
  EXECUTOR_DELIVERY_TYPES,
  TASK_TAGS,
  TASK_TYPE_VALUES,
  getAllTaskTags,
} from '../../constants';
import { skillQuery } from '../../tools/skill-query';
import {
  buildSkillQueryParameters,
  listSkillTags,
  listSkillTagsWithConditions,
} from '../skill-system/skill-registry';
import { COMMON_WORKFLOW_PROMPT } from './workflow-prompt';
import { configManager } from '../config/config-manager';

type ToolSchema = Record<string, unknown>;

/** 主智能体 send_email 工具名（阶段3：值守开启时按 watchEnabled 条件进入工具清单，v3 §8.1） */
export const MAIN_SEND_EMAIL_TOOL_NAME = 'send_email';

//值守模式提示词
function buildLivePrompt(): string {
  return configManager.getSettings().watchEnabled ?`
# 值守模式规则（**内部规则**）
\`\`\`
1.**此模式凭借外部开关控制；为避免对上下文造成干扰，因此严格禁止将此模式的【当前状态表述】写入思考过程或最终回复中**
2.此模式开启时，每次【最新用户输入】实际通过远程操控输入；
3.此模式开启时，务必将每次完成【最新用户意图】的【最终回复内容】以及成果（如：方案、报告、图片、文件链接等），用\`${MAIN_SEND_EMAIL_TOOL_NAME}\`工具发送一封邮件到【用户邮箱】。
\`\`\`
`:
`
# 专业模式规则（**内部规则**）
\`\`\`
1. 此模式开启时，忽略一切可能存在的【值守模式】信息。
2. 必须依据【最新用户意图】涉及的【专业领域】，进行【最专业】的决策、回复以及编排任务。
\`\`\`
`;
}

function buildSystemPromptBody(): string {
  return `
# 基本信息
\`\`\`
- 当前对话实际的日期和时间：${formatCurrentDateTime()}
- 【当前对话实际的日期和时间】仅供参考，不保证完全准确。
- 严格禁止把【当前对话实际的日期和时间】当作内部记忆、先验知识、输入材料、工具结果或外部事实的时间。
${configManager.getSettings().watchEnabled?'- 当前模式：【值守模式】':'- 当前模式：【专业模式】'}
\`\`\`

${buildLivePrompt()}

# 角色定义
\`\`\`
1.你是一个严格按照【标准逻辑流程图】执行的【聪慧】的中文助手;
- 你的名字：【Delepi】
- 你的小名：【派派】
2.你擅长使用【技能】和多个【技能】融合成一个【技能】进行使用。
3.你清楚的意识到，用户期待能够获得【最正确、最专业、最简洁】的交付成果以及【最简洁、最专业、最权威、条理最清晰】的回复。
4.你清楚的意识到，委派任务时若无明确的【执行方向】，自行编造或虚构任何【执行方向】都是【致命错误】。
5.你的核心职责是准确按照【标准逻辑流程图】执行，四个次级职责是：
  - 1.充分理解用户意图，尽可能确保不出现理解偏差。
  - 2.充分理解委派任务完成之后的输出结果，同时不要【漏看】细微特征还有时序。
  - 3.维护上下文状态以及总执行状态，判断是否需要【最终回复】的决策。
  - 4.根据【实际现状】以最符合【专业领域】的方式【编排】任务并委派给【执行者】执行。
6.你的表达必须是【准确且有逻辑递进的通俗讲解】；禁止【术语化过重】，禁止写成【浓缩清单】。
7.**你清楚的意识到，委派给【执行者】任务就能获得【高质量】的交付物（如：结论、线索、方案、报告等）**
\`\`\`

# 输出规范
\`\`\`
- 默认使用中文，必要时保留英文术语。
- 默认使用符合【用户最新意图】的【专业领域】排版，并采用Markdown格式。
- 输出至少包含符合【用户最新意图】的【专业领域】的【关键要素】。
- 需要代码、命令、表格、公式时，使用正确格式。
- 不伪造工具执行结果。
\`\`\`

${COMMON_WORKFLOW_PROMPT}
`;
}

export const MAIN_DELEGATE_TOOL_NAME = 'delegate_executor';


export { EXECUTOR_DELIVERY_TYPES, TASK_TAGS, TASK_TYPE_VALUES };

function buildDelegateToolParameters(): ToolSchema {
  return {
    type: 'object',
    properties: {
      task_name: {
        type: 'string',
        description: '精简且严谨的任务中文名称',
      },
      task_type: {
        type: 'string',
        enum: TASK_TYPE_VALUES,
        description:
          '任务类型，单选',
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
      task_target: {
        type: 'string',
        description:
          `任务目标，必须【自包含】，不得出现任何上下文指代性表述。同时至少包含：a. 所有目标对象和执行对象。b. 所有执行【基线场景】（表述必须含有基线场景语义）。c. 【目标达成】判定规则（表述必须包含可观察到的细微特征）`,
      },
      constraints: {
        type: 'array',
        description:
          `任务规则和约束，必须以【意图分析结果】为【构建来源】不得自行补全，若没有则写【无】，至少覆盖：a. 执行越界判定规则。b. 过度执行判定规则。c. 中止执行判定规则。`,
        items: {
          type: 'string',
          description:
            '单条原子【任务规则和约束】，必须写清【约束对象、规则对象以及严谨的判定条件】',
        },
      },
      skills: {
        type: 'array',
        description: `
        执行此任务时，适配的【执行者】技能标签集合，最多选择3个，至少选择1个；
        **注意：此处选择的是【执行者】技能，必须符合声明的技能标签枚举；并且绝不能是你自己的【编排者】技能**
        `,
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'string',       
          enum: getAllTaskTags('executor', configManager.getSettings().customSkillTags),
        },
      },
      context: {
        type: 'string',
        minLength: 1,
        description: `
        提交给【执行者】的上下文内容，禁止有任何指代性表述，至少包含：
        - 从【中间存储信息变量】按【时间顺序】提取的**与当前【任务目标】相关的所有【结论、线索、信息等】以及交付物产出**，并标记【时序】和【来源】。
        `
      },
    },
    required: [
      'task_name',
      'task_type',
      'delivery_type',
      'delivery_spec',
      'task_target',
      'constraints',
      'skills',
      'context',
    ],
    additionalProperties: false,
  } satisfies ToolSchema;
}

function buildDelegateExecutorDescription(): string {
  return `
调用此工具可委派任务给独立的【执行者】
** 仅用于在符合【触发任务规则】的情况下，详细制定可独立执行的任务，委派并返回结果 **
** 【没有明确要求】或【未获取明确不可执行的证据】之前，你可以委派一切任务，没有任何限制条件 **
**  若执行任务返回结果含【核验结果】可视作【可信轻量核验结果】，尽可能不做重复核验；若发现遗漏的核验项可进行复核**

# 注意事项
\`\`\`
 1. **绝对严格注意：禁止预判"有无工具/能否执行"；任何情形都不得拒绝委派；即使【历史记忆】中有实证证明无法执行，也必须考虑【最新状态】存在变化，因此【绝不可拒绝委派】任务**。
 2. 重点关注【触发任务规则】的前置条件，以免在不符合前置条件的情况下触发任务。
 3. 交付物描述会影响任务完成质量和内容详细程度，描述的越详细越好，不得为空。
 4. 交付物类型为【文件链接】或者【图片】，则最优先使用交付包含的URL而不是Path。
 5. 自定义技能按其模板定义的适用范围选用，无特殊规则时按最适配原则。
 6. 【用户最新意图】中【开放型要求】和【非开放性要求】必须透传到任务信息中；【开放型要求】禁止预设任何执行方向，必须交给【执行者】自主决策和创新。
 7. **【越界条件】的来源仅依据【用户最新意图】，禁止自行补全 **。
\`\`\`
`;
}

// ============================================================
// ★ 主智能体直接工具声明（read_file / fs_search / fs_list / fs_stat）——用户既定要求：声明可直接照抄【执行者】实现。
//   来源：src/main/modules/executor-agent/prompt.ts 的 buildReadFileDescription（L47-59）、
//   buildFsSearchDescription（L61-72）、EXECUTOR_TOOLS.fs_search（L137-166）、
//   EXECUTOR_TOOLS.read_file（L167-206）。
//   下方两个描述函数为【逐字复制区】（含外壳缩进保持与源一致，可直接 diff 校验）；
//   两个 parameters schema 为非空白字符逐字复制（仅整体缩进适配本文件层级）。
//   维护注记：执行者侧描述/参数更新时，需人工同步本复制区（保持逐字一致）。
// ============================================================

function buildReadFileDescription(): string {
    return `
    - 【最高优先级】
    - 读取【纯文本文件】的工具，按行读取文件，会返回每一行行号，行号从 1 开始；同时支持分段读取和全部读取。
    - **此工具仅限于搜索本地文件读取，不适配远程文件读取**
    - 分段读取end_line必填；全部读取则不需要填end_line。
    - 每次读取都会返回起始行号和实际读取行数。
    - 读取行数不限制，但读取的总体内容超过16384个字符会触发截断。
    - 超过【32KB文件大小】的【纯文本文件】禁全量读取，因为必然超过16384个字符。
    `;
}

function buildFsSearchDescription(): string {
    return `
    - 【低优先级】
    - 本地文件系统搜索工具，按内容查找文本出现在哪一行，可按正则匹配内容。
    - **此工具仅限于搜索本地文件系统，不适配远程文件系统**
    - 需要模式匹配（例如 TODO|FIXME、日志格式、多个关键字任一）时开启正则，匹配文本按 JavaScript 正则语法书写。
    - 每条命中都会给出：命中文件的绝对路径、命中所在行的文本、命中片段在该行内的起始字符位置与结束字符位置。
    - 行号和字符位置都从 1 开始数，行号就是文件里的第几行；结束字符位置指的是命中片段的最后一个字符在该行里的位置，首尾都算在命中范围内。
    - 命中行过长时，返回的行文本只是该行前 8192 个字符的摘要，不是整行；命中位置仍按整行计算，因此摘要中可能看不到命中片段，此时不得判定为未命中。
    - 结果中给出命中文件总数与命中总处数。
    - **内容搜索仅支持【纯文本文件搜索】，会跳过二进制文件与不可读文件（如:PDF,Word,Excel文件等)，不要据此判定这些文件不含目标文本。**
    **必须注意**
    - a.目录搜索仅在 depth 限定的层级内遍历子目录；file_path 搜索只针对该文件，不受 depth 影响；返回的 file_path 均为绝对路径，命中位置均以完整原始行为准。
    `;
}

function buildFsListDescription(): string {
    return `
    - 【高优先级】
    - 本地文件系统目录列举工具：对【目标目录】做递归遍历，列举全部文件与目录条目（不做任何名称或内容过滤）。
    - 递归深度由 depth 控制，工具不会超出该深度向下遍历。
    - **此工具仅限于列举本地文件系统，不适配远程文件系统**
    - entries 按 path 的 codePoint 升序确定性排序；无法访问的条目记入 skipped_paths（格式为「相对路径: 错误信息」，路径分隔符统一为 /）并跳过，不中断整体列举。
    **必须注意**
    - a.entries 中的 path 为绝对路径，name 仅为条目名（不含父目录）；跨工具引用文件时**务必使用绝对路径**。
    `;
}

function buildFsStatDescription(): string {
    return `
    - 【高优先级】
    - 本地文件系统路径信息工具：查询单个【文件或目录】路径自身及其指向对象的属性明细；路径不存在时给出明确的不存在判定。
    - **此工具仅限于查询本地文件系统，不适配远程文件系统**
    - size_bytes 为字节数（仅 file 与 symlink 有该字段）。
    **必须注意**
    - a.路径分隔符随运行平台而异；同一路径在符号链接场景下 real_path 可能与传入路径不同。
    `;
}

/** 主智能体工具描述：query_skill（schema 与执行者侧逐字一致；主侧【最高优先级】已由 read_file 占用，本工具为【高优先级】） */
function buildMainSkillQueryDescription(): string {
  return `
    - 【最高优先级】
    - 工具作用；查询你作为【编排者】可使用的技能内容
    - 按【技能标签】返回该技能的完整内容。
    - 查询的技能标签必须在【技能清单】内，清单外标签会查询失败。
  `;
}

/** 主智能体工具声明：query_skill（enum=主智能体技能集：交互设计/思路设计/问题解答/推理分析+归属main的启用自定义） */
function buildMainSkillQueryTool() {
  return {
    type: 'function' as const,
    function: {
      name: 'query_skill',
      description: buildMainSkillQueryDescription(),
      parameters: buildSkillQueryParameters(listSkillTags('main')),
    },
  };
}

/** 主智能体工具声明：read_file（非空白字符与执行者 EXECUTOR_TOOLS.read_file 逐字一致） */
function buildMainReadFileTool() {
  return {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: buildReadFileDescription(),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              '必填。要读取的本地【纯文本文件】路径，必须使用绝对路径。',
          },
          start_line: {
            type: 'integer',
            description: '必填。起始行号，从 1 开始计数的正整数。',
            minimum: 1,
          },
          end_line: {
            type: 'integer',
            description:
              '可选。结束行号（含该行），不得小于 start_line；不传则读取到文件末尾',
            minimum: 1,
          },
          encoding: {
            type: 'string',
            description: '可选。文件编码，默认 utf-8',
          },
          include_total_lines: {
            type: 'boolean',
            description: '可选。是否返回文件总行数，默认 false。',
            default: false,
          },
        },
        required: ['path', 'start_line'],
        additionalProperties: false,
      },
    },
  };
}

/** 主智能体工具声明：fs_search（非空白字符与执行者 EXECUTOR_TOOLS.fs_search 逐字一致） */
function buildMainFsSearchTool() {
  return {
    type: 'function' as const,
    function: {
      name: 'fs_search',
      description: buildFsSearchDescription(),
      parameters: {
        type: 'object',
        properties: {
          directory: {
            type: 'string',
            description: '可选。要搜索的【目标目录】绝对路径；与 file_path 二选一，目录搜索时使用。',
          },
          depth: {
            type: 'integer',
            description: '可选。目录搜索的递归深度，默认 0（仅搜索当前层直接文件），最大 3；file_path 单文件搜索忽略该参数。',
            default: 0,
            minimum: 0,
            maximum: 3,
          },
          file_path: {
            type: 'string',
            description: '可选。要搜索的【单个文件】绝对路径；与 directory 二选一，单文件搜索时使用。',
          },
          content: {
            type: 'string',
            description: '必填。要搜索的匹配文本；regex=false 时按普通字面量匹配，regex=true 时按 JavaScript 正则表达式编译。',
          },
          regex: {
            type: 'boolean',
            description: '可选。是否将 content 作为 JavaScript 正则表达式；默认 false（普通字面量）。',
            default: false,
          },
          case_sensitive: {
            type: 'boolean',
            description: '可选。是否区分大小写；默认 false，不区分大小写。',
            default: false,
          },
        },
        required: ['content'],
        additionalProperties: false,
      },
    },
  };
}

/** 主智能体工具声明：fs_list（非空白字符与执行者 EXECUTOR_TOOLS.fs_list 逐字一致） */
function buildMainFsListTool() {
  return {
    type: 'function' as const,
    function: {
      name: 'fs_list',
      description: buildFsListDescription(),
      parameters: {
        type: 'object',
        properties: {
          directory: {
            type: 'string',
            description: '必填。要列举的【目标目录】绝对路径。',
          },
          depth: {
            type: 'integer',
            description: '可选。目录递归深度，默认 0，不递归，最大 3。',
            default: 0,
            minimum: 0,
            maximum: 3,
          },
        },
        required: ['directory'],
        additionalProperties: false,
      },
    },
  };
}

/** 主智能体工具声明：fs_stat（非空白字符与执行者 EXECUTOR_TOOLS.fs_stat 逐字一致） */
function buildMainFsStatTool() {
  return {
    type: 'function' as const,
    function: {
      name: 'fs_stat',
      description: buildFsStatDescription(),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '必填。要查询的【目标文件或目录】绝对路径。',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  };
}

/**
 * 主智能体 send_email 工具 description（工具提示词，v3 §8.1 定稿全文 8 条 + 开头段按时序1反转改写）。
 * 发件规范唯一承载处（零处理原则：任何发件/回执引导只允许存在于这里，严禁进入对话消息本体）。
 * 反转点（阶段3回执单轨）：原文“值守链路对每条指令的处理结果回执由系统自动发送，无需你主动
 * 发送‘处理结果通知’类邮件”改为“主智能体负责在处理完成后经 send_email 发送回执——正文只写
 * 最终回复、四类交付物以附件带回”；第 2 条融合交付物路径来源引导（委派结果结构化字段
 * local_files / image_files 主源，can_openfile_url / image_urls 备用源）。
 */
function buildMainSendEmailDescription(): string {
  return (
    `
     向指定收件人发送一封邮件工具。
     # 约束
     -1. 若收件人不填则为【用户邮箱】。
     -2. body 必须是纯 HTML 正文，正文中不得出现任何脚本（script / on* 事件 / javascript:）。
    `
  );
}

/** 主智能体 send_email 工具参数 Schema（v3 §8.2 JSON Schema 原样） */
function buildMainSendEmailToolParameters(): ToolSchema {
  return {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: '可选。收件人邮箱地址；若不填，则为【用户邮箱】',
      },
      subject: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: '必填,精确且简单的描述邮件主题',
      },
      body: {
        type: 'string',
        minLength: 1,
        maxLength: 8192,
        description: '必填。邮件正文；只写最终回复或对收件人有价值的最终内容，不得包含工具调用明细、思考过程或内部日志。',
      },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        description: '可选。附件数组，元素为本地文件绝对路径或 http(s) 远程 URL（URL 自动下载后附加）。',
      },
    },
    required: ['subject', 'body'],
    additionalProperties: false,
  };
}

/** 主智能体工具声明：send_email（仅值守开启时进入清单；执行体 src/main/tools/send-email.ts） */
function buildMainSendEmailTool() {
  return {
    type: 'function' as const,
    function: {
      name: MAIN_SEND_EMAIL_TOOL_NAME,
      description: buildMainSendEmailDescription(),
      parameters: buildMainSendEmailToolParameters(),
    },
  };
}

/** 主智能体工具声明构建函数（query_skill enum 每次构建经 listSkillTags 实时取值，保证运行时含启用自定义标签） */
export function buildMainTools() {
  const tools = [
    {
      type: 'function' as const,
      function: {
        name: MAIN_DELEGATE_TOOL_NAME,
        description: buildDelegateExecutorDescription(),
        parameters: buildDelegateToolParameters(),
      },
    },
    buildMainSkillQueryTool(),
    buildMainReadFileTool(),
    buildMainFsSearchTool(),
    buildMainFsListTool(),
    buildMainFsStatTool(),
  ];
  // 阶段3（v3 §8.5）：仅值守开启时 send_email 进入主智能体工具清单；watch:start/stop
  // 联动 refreshMainTools()（阶段2已接线）经 MAIN_TOOLS live-binding 即时生效。
  tools.push(buildMainSendEmailTool());
  return tools;
}

/**
 * 主智能体工具声明（改运行时构建）。
 * 消费点 main-agent.ts 每轮 streamChat 读取该导入绑定，故以 export let + refreshMainTools()
 * 实现 live-binding 刷新（消费点零改动；自定义技能保存/删除/配置 reload 后调用刷新）。
 */
export let MAIN_TOOLS = buildMainTools();

/** 刷新 MAIN_TOOLS（ES 模块 live binding，消费点自动取新值） */
export function refreshMainTools(): void {
  MAIN_TOOLS = buildMainTools();
}

/**
 * 主智能体系统提示工厂：SYSTEM_PROMPT 主体 + 主智能体技能清单（内置4项+归属main的启用自定义）。
 * 清单与 query_skill enum 同源（listSkillTags），每次构建实时读取，自定义技能变更后无需重启即入下一轮。
 */
export function buildMainSystemPrompt(): string {
  const skillEntries = listSkillTagsWithConditions('main');
  const skillsSection = skillEntries.length
    ? `
# 技能清单（**可用query_skill工具查询技能详细内容**）
\`\`\`json
${JSON.stringify(skillEntries)}
\`\`\`
`
    : '';
  const systemPromptBody = buildSystemPromptBody();
  return `${systemPromptBody}${skillsSection}`;
}
