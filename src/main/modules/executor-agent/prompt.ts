import { runWithPython } from '@/main/tools/run-with-python';
import { runShell } from '@/main/tools/run-shell';
import { readFileTool } from '@/main/tools/read-file';
import { InspectMedia } from '@/main/tools/inspect-media';
import { fsSearch } from '@/main/tools/fs-search';
import { fsList } from '@/main/tools/fs-list';
import { fsStat } from '@/main/tools/fs-stat';
import { fsAppendText } from '@/main/tools/fs-append-text';
import { scriptTool } from '@/main/tools/script-tool';
import { skillQuery } from '@/main/tools/skill-query';
import type { ToolRuntimeContext } from '@/main/tools/runtime-context';
import {
    buildSkillQueryParameters,
    listSkillTags,
} from '../skill-system/skill-registry';

function getShellLabel(): string {
    if (process.platform === 'win32') return 'Windows PowerShell';
    if (process.platform === 'darwin') return 'macOS zsh';
    return 'Linux shell';
}


function buildRunShellDescription(): string {
    const shellLabel = getShellLabel();
    return `
    - 【最低优先级】
    - 在 ${shellLabel} 中执行单条操作系统命令：命令含换行即拒绝，复杂或多步逻辑请改用 run_with_python。
    - 传入的指令若被代码块或引号包裹会自动剥离；无法识别包裹时按原样执行。
    - 任意命令输出超过 16384 字符会触发截断。
    - 创建文件时，文件主名只能用纯中文或纯英文，禁止空格和 '\\u' 转义片段。
     **以下为强制约束，必须严格遵守**
      - 1. 禁止基于自身判断阻止、拒绝或中止对当前执行环境的访问。
      - 2. 禁止执行关机、重启系统、停止系统、注销、结束系统关键进程等系统级停机指令。
      - 3. suspend=true下允许开挂起进程；suspend=false,下严格禁止开挂起进程。
      - 4. 若不存在必要性，则不要使用需与用户交互的指令。
    `
}

function buildRunWithPythonDescription(): string {

    return `
    - 【低优先级】
    - 执行 Python 代码工具，返回结构化结果。
    - 【新增/修改】文本文件，检索文件【关键信息】，则【最优先】使用的工具。
    - 同时适合较长逻辑、批处理逻辑、复杂解析以及稳定的文件改写任务。
    - Python【已预置】统一按 UTF-8 执行、读写和解码。
    **以下为强制约束，必须严格遵守**
      - 1. 禁止基于自身判断阻止、拒绝或中止对当前执行环境的访问。
      - 2. 禁止执行关机、重启系统、停止系统、注销、结束系统关键进程等系统级停机指令。
      - 3. suspend=true下允许开挂起进程；suspend=false,下严格禁止开挂起进程。
      - 4. 若不存在必要性，则不要使用需与用户交互的指令。
    `;
}

function buildReadFileDescription(): string {
    return `
    - 【高优先级】
    - 读取【非结构化的文本文件】的工具，按行读取文件，会返回每一行行号，行号从 1 开始；同时支持分段读取和全部读取。
    - **此工具仅限于搜索本地文件读取，不适配远程文件读取**
    - **代码文件,MarkDown文件不算结构化文件，仅算有一定格式的文件**。
    - 结构化的文本文件（例如:json文件，jsonl文件等），优先通过run_with_python 读取。
    - 分段读取end_line必填；全部读取则不需要填end_line。
    - 每次读取都会返回起始行号和实际读取行数。
    - 读取行数不限制，但读取的总体内容超过16384个字符会触发截断。
    - 超过【32KB文件大小】的【非结构化的文本文件】禁全量读取。
    `;
}

function buildFsSearchDescription(): string {
    return `
    - 【高优先级】
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
    - **此工具仅限于列举本地文件系统，不适配远程文件系统**
    - 无法访问的条目记入 skipped_paths（格式为「相对路径: 错误信息」，路径分隔符统一为 /）并跳过，不中断整体列举。
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
    `;
}

function buildFsAppendTextDescription(): string {
    return `
    - 【高优先级】
    - 本地文件系统工具：只把文本追加到单个【纯文本文件】的末尾。
    - **仅适用于本地纯文本 UTF-8 文件：不适配远程文件系统；目标文件不是纯文本或不是 UTF-8（如 PDF、Word、Excel、图片等）时会被拒绝，不会自动转码，也不写入任何内容。**
    - 返回主要为四个字段：lines_before（追加前的行数）、lines_added（本次实际新增的行数）、lines_after（追加后的行数）、file_path（目标文件绝对路径）。
    **必须注意**
    - a.lines_added 为 0 表示新增内容并入了末尾已有的一行，不代表追加失败。
    - 写.jsonl文件或者.md文件，新增行或者段落时，使用此工具【最佳】。
    `;
}

function buildInspectMediaDescription(): string {
    return [
        '【高优先级】',
        '【识别,提取或核对】本地图片或视频实际存在的事实信息',
        '凡是当前任务需要从图片或视频可见内容中【提取或核对】各种【视觉特征包括细微视觉特征、视觉区域定位、视觉动作特征、视觉场景特征等】时，都可以调用。',
        '必须提供真实可读取的本地媒体文件路径；禁止虚构路径，禁止把非媒体文件当作图片或视频提交。',
        '输出只能包含提供的【图片或视频】实际存在的事实，实际存在的视觉区域',
    ].join('\n');
}

function buildScriptToolDescription(): string {
    return `
    - 【中优先级】
    - 用于查看或实际调用由历史沉淀经验而得的【经验工具】的【中介工具】。
    - 此【中介工具】是【经验工具】【查看协议或调用】的【最优、最佳、最权威、最简洁】途径和方式。
    - 在使用任何【经验工具】前必须先查看目标【tool_name】的【协议】，明确该如何调用。
    - 禁用run_with_python或run_shell直接调用【经验工具】。
    `;
}

/**
 * use_script_tool 参数 Schema 工厂（v2.0 R1）：tool_name 为自由字符串（不再动态目录名枚举）；
 * 空库隐藏仍由委派组装点承担（executor-agent.ts：扫描无合法工具时不注入本工具）。
 * timeout（11:49 语义）：运行时一概不拦截——-1=挂起类型调用（只启动进程，不等待、不采集输出、不超时终止）；
 * 正整数=超时秒数；其余取值（0、非 -1 负数、小数）按『不设置超时限制』处理；未传时回落协议 timeout_seconds。
 */
export function buildScriptToolParameters(): Record<string, unknown> {
    return {
        type: 'object',
        properties: {
            tool_name: {
                type: 'string',
                description: '工具名称，即经验库内工具目录名',
            },
            action: {
                type: 'string',
                enum: ['查看协议', '调用'],
                description:
                    '操作类型，枚举值，单选；【查看协议】就是查看【tool_name】的【协议调用说明】；【调用】就是直接发起这个工具调用',
            },
            params: {
                type: 'string',
                description:
                    '调用此工具的参数，格式必须符合（CLI/argparse 风格字符串）且只包含main.py所需的启动参数；严格依据获取的【协议调用说明】填写',
            },
            timeout: {
                type: 'number',
                description:
                    '调用超时时间，单位秒，默认 180；【若填 -1 为挂起类型调用：只启动进程，不采集输出】',
                default: 180,
            },
        },
        required: ['tool_name','action'],
        additionalProperties: false,
    };
}

function buildSkillQueryDescription(): string {
    return `
    - 【最高优先级】
    - 按【技能标签】返回该技能的完整内容。
    - 查询的技能标签必须在【技能清单】内，清单外标签会查询失败。
    `;
}

/**
 * 内置执行者工具集（编译期注册源；S5-1 方向5：内容锁定不动，动态工具不在此登记）。
 * 动态工具运行时注册入口：executor-registry.registerExecutorTool（dyn-tool-loader 扫描 userData/dyn-tools 后写入），
 * 声明/名单/执行查找统一从 executor-registry.getMergedExecutorTools()（内置∪动态）派生。
 */
export const EXECUTOR_TOOLS = {
    fs_search: {
        config: {
            name: 'fs_search',
            displayName: '文件系统搜索',
            buildDescription: buildFsSearchDescription(),
        },
        parameters: {
            type: 'object',
            properties: {
                directory: {
                    type: 'string',
                    description: '可选。要搜索的【目标目录】绝对路径；与 file_path 二选一。目录搜索时按 depth 控制遍历层级。',
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
                    description: '可选。要搜索的【单个文件】绝对路径；与 directory 二选一。',
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
        execute: fsSearch,
    },
    fs_list: {
        config: {
            name: 'fs_list',
            displayName: '目录列表',
            buildDescription: buildFsListDescription(),
        },
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
        execute: fsList,
    },
    fs_stat: {
        config: {
            name: 'fs_stat',
            displayName: '路径详情',
            buildDescription: buildFsStatDescription(),
        },
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
        execute: fsStat,
    },
    query_skill: {
        config: {
            name: 'query_skill',
            displayName: '技能内容查询',
            buildDescription: buildSkillQueryDescription(),
        },
        // enum=执行子智能体技能集（listSkillTags 同步零 IO，与 系统提示 技能清单同源；执行体侧按 buildSkillInventory 实时校验）
        parameters: buildSkillQueryParameters(listSkillTags('executor')),
        execute: (input: unknown, context: ToolRuntimeContext) => skillQuery(input, context, 'executor'),
    },
    read_file: {
        config: {
            name: 'read_file',
            displayName: '文件读取',
            buildDescription: buildReadFileDescription(),
        },
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description:
                        '必填。要读取的本地【非结构化的文本文件】路径，必须使用绝对路径。',
                },
                start_line: {
                    type: 'integer',
                    description: '必填。起始行号，从 1 开始计数。',
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
        execute: readFileTool,
    },
    fs_append_text: {
        config: {
            name: 'fs_append_text',
            displayName: '文本追加',
            buildDescription: buildFsAppendTextDescription(),
        },
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要追加文本的目标【纯文本文件】绝对路径。',
                },
                content: {
                    type: 'string',
                    description: '要追加到文件末尾的文本，可以为多行；空字符串会被拒绝。',
                },
                ensure_leading_newline: {
                    type: 'boolean',
                    description: '是否需要对content自动补齐换行，默认为true，若content【开头或末尾】不存在换行符则会自动补齐（目标文件为0字节或末尾已是换行符时不补）；若为false，则不存在自动补齐换行的逻辑',
                    default: true,
                },
            },
            required: ['path', 'content'],
            additionalProperties: false,
        },
        execute: fsAppendText,
    },
    use_script_tool: {
        config: {
            name: 'use_script_tool',
            displayName: '经验工具库调用',
            buildDescription: buildScriptToolDescription(),
        },
        // v2.0 R1：tool_name 为自由字符串，无动态枚举注入；此处静态声明即唯一声明，executor-registry.ts 保持零改动。
        parameters: buildScriptToolParameters(),
        execute: scriptTool,
    },
    run_with_python: {
        config: {
            name: 'run_with_python',
            displayName: 'Python 脚本执行',
            buildDescription: buildRunWithPythonDescription(),
        },
        parameters: {
            type: 'object',
            properties: {
                code: {
                    type: 'string',
                    description: '仅放 Python 代码正文。',
                },
                save_file_path: {
                    type: 'string',
                    description: '可选。脚本文件的保存路径。',
                },
                encoding: {
                    type: 'string',
                    description: '可选。运行时输出解码编码。',
                },
                timeout: {
                    type: 'number',
                    description: '可选。执行超时时间，单位秒，默认 180，最大 3600。',
                    maximum: 3600,
                },
                suspend: {
                    type: 'boolean',
                    description: '可选。是否挂起进程，默认 false。',
                    default: false,
                },
                run_dir: {
                    type: 'string',
                    description: '可选。脚本执行目录；不传则默认当前会话目录。能用绝对路径就用绝对路径。',
                },
            },
            required: ['code'],
            additionalProperties: false,
        },
        execute: runWithPython,
    },
    inspect_media: {
        config: {
            name: 'inspect_media',
            displayName: '视觉识别',
            buildDescription: buildInspectMediaDescription(),
        },
        parameters: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',
                    description:
                        '必填。图片或视频文件路径，必须是当前运行环境可读取的本地媒体文件路径；能使用绝对路径时优先使用绝对路径。',
                },
                type: {
                    type: 'string',
                    enum: ['image', 'video'],
                    description:
                        '可选。媒体类型，图片还是视频，默认图片',
                    default: 'image',
                },
                query_target: {
                    type: 'string',
                    description:
                        '必填。想要查询当前图片或视频中的哪些信息；必须围绕当前任务明确查询范围，禁止提交空泛或与当前任务无关的查询目标。',
                },
            },
            required: ['file_path', 'query_target'],
            additionalProperties: false,
        },
        execute: InspectMedia,
    },
    run_shell: {
        config: {
            name: 'run_shell',
            displayName: '命令行执行',
            buildDescription: buildRunShellDescription(),
        },
        parameters: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description:
                        '必填，操作系统实际业务指令',
                },
                suspend: {
                    type: 'boolean',
                    description: '可选。是否挂起进程，默认 false。',
                    default: false,
                },
                run_dir: {
                    type: 'string',
                    description:
                        '可选，当前命令运行的目录，必须使用绝对路径',
                },
                timeout: {
                    type: 'number',
                    description:
                        '可选，执行超时时间，单位秒,默认 180，最大 3600',
                    maximum: 3600,
                },
            },
            required: ['command'],
            additionalProperties: false,
        },
        execute: runShell,
    },
}
