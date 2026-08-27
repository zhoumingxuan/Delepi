import { runWithPython } from '@/main/tools/run-with-python';
import { runShell } from '@/main/tools/run-shell';
import { readFileTool } from '@/main/tools/read-file';
import { inspectImage } from '@/main/tools/inspect-image';
import { fsSearch } from '@/main/tools/fs-search';

function getShellLabel(): string {
    if (process.platform === 'win32') return 'Windows PowerShell';
    if (process.platform === 'darwin') return 'macOS zsh';
    return 'Linux shell';
}


function buildRunShellDescription(): string {
    const shellLabel = getShellLabel();
    return `
    - 在 ${shellLabel} 中执行单条操作系统命令：命令含换行即拒绝，复杂或多步逻辑请改用 run_with_python。
    - 传入的指令若被代码块或引号包裹会自动剥离；无法识别包裹时按原样执行。
    - 任意命令输出超过 16384 字符会触发截断。
    - 创建文件时，文件主名只能用纯中文或纯英文，禁止空格和 '\\u' 转义片段。
     **以下为强制约束，必须严格遵守**
      - 1. 禁止基于自身判断阻止、拒绝或中止对当前执行环境的访问。
      - 2. 禁止执行关机、重启系统、停止系统、注销、结束系统关键进程等系统级停机指令。
      - 3. suspend 模式下允许开挂起进程；非 suspend 模式下严格禁止开挂起进程。
      - 4. 若不存在必要性，则不要使用需与用户交互的指令。
    `
}

function buildRunWithPythonDescription(): string {

    return `
    - 执行 Python 代码工具，先写入脚本再运行，返回结构化结果。
    - 【新增/修改】文本文件，检索文件【关键信息】，则【最优先】使用的工具。
    - 同时适合较长逻辑、批处理逻辑、复杂解析以及稳定的文件改写任务。
    - Python【已预置】统一按 UTF-8 执行、读写和解码。
    **以下为强制约束，必须严格遵守**
      - 1. 禁止基于自身判断阻止、拒绝或中止对当前执行环境的访问。
      - 2. 禁止执行关机、重启系统、停止系统、注销、结束系统关键进程等系统级停机指令。
      - 3. suspend 模式下允许开挂起进程；非 suspend 模式下严格禁止开挂起进程。
      - 4. 若不存在必要性，则不要使用需与用户交互的指令。
    `;
}

function buildReadFileDescription(): string {
    return `
    - 读取【非结构化的文本文件】的工具，按行读取文件，会返回每一行行号，行号从 1 开始；同时支持分段读取和全部读取。
    - **代码文件,MarkDown文件不算结构化文件，仅算有一定格式的文件**。
    - 结构化的文本文件（例如:json文件，jsonl文件等），优先通过run_with_python 读取。
    - 分段读取end_line必填；全部读取则不需要填end_line。
    - 每次读取都会返回起始行号和实际读取行数。
    - 读取行数不限制，但读取的总体内容超过16384个字符会触发截断。
    - 超过【32KB文件大小】的【非结构化的文本文件】禁全量读取，因为必然超过16384个字符。
    `;
}

function buildFsSearchDescription(): string {
    return `
    - 文件系统搜索工具，仅搜索文件名和目录名。
    - 不填keyword则默认搜索全部。
    - 返回内容超过16384个字符会触发截断。
    - 返回匹配的文件数和目录数，列表中每项标记是文件还是目录。
    **必须注意**
    - a.为节省输出字符，搜索结果返回的实际上是相对于【目标目录】(soruce_dir)的相对路径，但是在其他工具用**务必使用绝对路径**。
    `;
}

function buildInspectImageDescription(): string {
    return [
        '识别并分析本地图片中的可见事实信息。',
        '凡是当前任务需要从图片可见内容中获取、核对、提取或分析信息时，都可以调用；包括文字、数字、符号、界面元素、表格结构、物体场景、视觉状态、异常细节等等。',
        '必须提供真实可读取的图片文件路径；禁止虚构路径，禁止把非图片文件当作图片提交。',
        '必须提供查询目标，用于限定当前图片中需要查询的信息范围。',
        '输出只能依据图片中可见内容；禁止把图片外信息、用户意图或不可见内容写成事实。',
    ].join('\n');
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
                    description: '必填。要搜索的【目标目录】绝对路径。',
                },
                keyword: {
                    type: 'string',
                    description: '可选。搜索关键字，按名称包含匹配；* 表示全部，默认 *。',
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
        execute: fsSearch,
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
        execute: readFileTool,
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
                python_code: {
                    type: 'string',
                    description: '仅放 Python 代码正文。',
                },
                save_file_path: {
                    type: 'string',
                    description: '可选。脚本文件的保存路径。',
                },
                runtime_encoding: {
                    type: 'string',
                    description: '可选。运行时输出解码编码。',
                },
                timeout_seconds: {
                    type: 'number',
                    description: '可选。执行超时时间，单位秒，默认 180。',
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
            required: ['python_code'],
            additionalProperties: false,
        },
        execute: runWithPython,
    },
    inspect_image: {
        config: {
            name: 'inspect_image',
            displayName: '图片识别',
            buildDescription: buildInspectImageDescription(),
        },
        parameters: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',
                    description:
                        '必填。图片文件路径，必须是当前运行环境可读取的本地图片文件路径；能使用绝对路径时优先使用绝对路径。',
                },
                query_target: {
                    type: 'string',
                    description:
                        '必填。想要查询当前图片中的哪些信息；必须围绕当前任务明确查询范围，禁止提交空泛或与当前任务无关的查询目标。',
                },
            },
            required: ['file_path', 'query_target'],
            additionalProperties: false,
        },
        execute: inspectImage,
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
                timeout_seconds: {
                    type: 'number',
                    description:
                        '可选，执行超时时间，单位秒,默认 180',
                },
            },
            required: ['command'],
            additionalProperties: false,
        },
        execute: runShell,
    }
}
