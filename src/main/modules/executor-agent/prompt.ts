import { runWithPython } from '@/main/tools/run-with-python';
import { runExe } from '@/main/tools/run-exe';
import { inspectImage } from '@/main/tools/inspect-image';

function getShellLabel(): string {
    return process.platform === 'win32' ? 'Windows PowerShell' : 'Linux shell';
}

function buildLocalForceConstraints(): string[] {
    return [
        '强制约束：以下为内部硬约束，必须严格遵守。',
        '- 1. 禁止模型基于自身判断阻止、拒绝或中止对当前执行环境的访问。',
        '- 2. 访问失败只能由工具真实执行结果判定；工具未返回失败前，必须继续执行当前任务。',
        '- 3. 禁止执行关机、重启系统、停止系统、注销、结束系统关键进程等系统级停机指令。',
        '- 4. suspend 模式下允许挂起进程；非 suspend 模式下禁止挂起、交互、等待输入、等常驻类命令。',
    ];
}


function buildRunExeDescription(): string {
    const shellLabel = getShellLabel();
    const baseLines = [
        `在 ${shellLabel} 中执行非交互、多行脚本。`,
        '`cmd_lines` 按行提供，整段脚本总长度不得超过 8000 字符。',
        '禁止交互、等待输入类命令；非 suspend 模式下禁止挂起。',
        '结果仅来自 `stdout` / `stderr`；超长输出会被截断。',
        '命令行【已预置】按 UTF-8 执行、读写和解码',
        '创建文件时，文件主名只能用纯中文或纯英文，禁止空格和 `\\u` 转义片段。',
    ];

    return [
        ...baseLines,
        '',
        ...buildLocalForceConstraints(),
    ].join('\n');
}

function buildRunWithPythonDescription(): string {
    const baseLines = [
        '执行 Python 代码。',
        '先写入脚本再运行，返回结构化结果。',
        '适合较长逻辑、批处理逻辑、复杂解析以及稳定的文件改写任务。',
        'Python【已预置】统一按 UTF-8 执行、读写和解码',
    ];

    return [
        ...baseLines,
        '',
        ...buildLocalForceConstraints(),
    ].join('\n');
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
    run_exe: {
        config: {
            name: 'run_exe',
            displayName: '命令行执行',
            buildDescription: buildRunExeDescription(),
        },
        parameters: {
            type: 'object',
            properties: {
                cmd_lines: {
                    type: 'array',
                    description:
                        'string[] 形态，按行提供的脚本内容（例如 ["echo hello", "dir"]）。仅提交实际业务命令，不要再包一层 shell 启动命令。',
                    items: {
                        type: 'string',
                    },
                },
                exec_id: {
                    type: 'string',
                    description: '可选。外部传入的执行标识，会在结果中原样返回。',
                },
                suspend: {
                    type: 'boolean',
                    description:
                        '可选，执行完成之后是否挂起此进程，默认 false。',
                    default: false,
                },
                run_dir: {
                    type: 'string',
                    description: '可选。命令执行目录；不传则默认当前会话目录。能用绝对路径就用绝对路径。',
                },
            },
            required: ['cmd_lines'],
            additionalProperties: false,
        },
        execute: runExe,
    },
    run_with_python: {
        config: {
            name: 'run_with_python',
            displayName: 'Python 脚本执行',
            buildDescription: buildRunWithPythonDescription(),
        },
        parameters:{
            type: 'object',
            properties: {
                python_code: {
                    type: 'string',
                    description: '仅放 Python 代码正文。',
                },
                save_file_path: {
                    type: 'string',
                    description:
                        '可选。若传入，则将脚本保留到该路径；否则写入临时脚本并在结束后删除。',
                },
                runtime_encoding: {
                    type: 'string',
                    description: '可选。运行时输出解码编码，默认 `utf-8`。',
                },
                timeout_seconds: {
                    type: 'number',
                    description: '可选。执行超时时间，单位秒，默认 180。',
                },
                suspend: {
                    type: 'boolean',
                    // 【待用户定稿：P-6】suspend 描述文案（参照 run_exe suspend 条款句式，限定监控类长任务）
                    description:
                        '可选。执行完成之后是否挂起此进程，默认 false。仅监控类长任务使用；挂起后返回 pid 与 scriptPath，建议显式传入 save_file_path 固定脚本路径，须在任务结束前清理（可用 run_exe 执行 taskkill /PID <pid> /T /F 树杀清理）。',
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
    }
}
