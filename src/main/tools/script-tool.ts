/**
 * script_tool 内置门面工具执行内核（经验库 script-tools 的查看协议/调用两分支）
 *
 * 职责（6.3）：
 * - 分支一【查看协议】：根目录检查（含兜底重建）→ 扫描 → 聚合清单（省略 tool_name）/返回单个工具协议全文+摘要（填写 tool_name）；
 * - 分支二【调用】七步：根目录检查 → 定位工具目录（目录名精确等值）→ 读校验协议 → 校验 params string →
 *   将 params string（CLI/argparse 风格，--key value）直接作为启动命令 CLI 参数携带（不再落地 input.json、不再 --input 传参）
 *   → spawn python main.py（cwd=工具目录；PYTHONUTF8=1；
 *   SCRIPT_TOOL_WORK_DIR=会话工作目录，D14；超时=调用参数 timeout 显式传入时优先、否则按协议 timeout_seconds；
 *   timeout=-1=挂起类型调用：只启动进程，不等待/不采集输出/不超时终止）→ stdout 完整透传至 data、stderr 完整透传至 message（超 16K 截断并附提示后缀），success=进程退出码===0。
 *
 * 遵循 dyn-tool-loader.ts L228-230 “只读参照，不 import 不依赖”哲学（D6）：
 * 执行内核独立参照实现，不 import dyn-tool-loader 内部函数。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';

import type { ToolResult } from './result';
import { buildToolResult, truncateToolOutput } from './result';
import type { ToolRuntimeContext } from './runtime-context';
import { ensureErrorMessage } from '../utils/index';
import { configManager } from '../modules/config/config-manager';
import { pythonManager } from '../modules/python';
import { MAX_SCRIPT_TOOLS, SCRIPTS_TOOLS_DIR } from '../constants';
import {
  SCRIPT_TOOL_CODES,
  SCRIPT_TOOL_TIMEOUT_MAX_SECONDS,
  scanScriptToolsDir,
  type ScriptToolScanEntry,
} from './script-tool-protocol';

// ============================================================
// 输入解析与公共助手
// ============================================================

function fail(code: string, message: string): ToolResult {
  return buildToolResult({ success: false, code, message });
}

/** V1/C1：根目录存在性检查 + 兜底重建一次（R2 启动创建失败的补偿；重建失败才报 DIR_MISSING） */
function ensureScriptToolsRootDir(): { ok: true } | { ok: false; error: string } {
  if (existsSync(SCRIPTS_TOOLS_DIR)) {
    return { ok: true };
  }
  try {
    mkdirSync(SCRIPTS_TOOLS_DIR, { recursive: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: ensureErrorMessage(error) };
  }
}

function buildDirMissingResult(detail: string): ToolResult {
  return fail(
    SCRIPT_TOOL_CODES.DIR_MISSING,
    `经验库根目录不存在且兜底重建失败：${SCRIPTS_TOOLS_DIR}（期望路径）。原因：${detail}。` +
      '维护指引：请确认程序目录可写（打包态 resources 只读时以 SCRIPT_TOOL_DIR_NOT_WRITABLE 语义如实上报），重启程序将再次自动尝试创建。',
  );
}

// ============================================================
// 入口：输入解析与分支路由
// ============================================================

export async function scriptTool(input: unknown, context: ToolRuntimeContext): Promise<ToolResult> {
  const resolved = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  const actionRaw = resolved.action;
  if (typeof actionRaw !== 'string' || !actionRaw.trim()) {
    return fail(SCRIPT_TOOL_CODES.PARAMS_INVALID, 'action 必填（枚举：查看协议 / 调用）');
  }
  const action = actionRaw.trim();
  if (action !== '查看协议' && action !== '调用') {
    return fail(
      SCRIPT_TOOL_CODES.PARAMS_INVALID,
      `action 仅允许「查看协议」或「调用」，当前值：${JSON.stringify(actionRaw)}`,
    );
  }

  let toolName: string | undefined;
  if (resolved.tool_name !== undefined) {
    if (typeof resolved.tool_name !== 'string' || !resolved.tool_name.trim()) {
      return fail(SCRIPT_TOOL_CODES.PARAMS_INVALID, 'tool_name 传入时必须为非空字符串（目标工具目录名）');
    }
    toolName = resolved.tool_name.trim();
  }

  let params: string | undefined;
  if (resolved.params !== undefined) {
    if (typeof resolved.params !== 'string') {
      return fail(
        SCRIPT_TOOL_CODES.PARAMS_INVALID,
        'params 必须为字符串（CLI/argparse 风格参数串，形如 --expression "sin(x)" --x-min -10 --width-px 3840；键名 kebab-case、布尔参数使用明确开关形式；顶层禁止使用保留字 context）',
      );
    }
    params = resolved.params.trim();
  }

  // timeout：调用超时秒数（可选）。仅约束为数字，取值一概不拦截：-1=挂起类型调用；正整数=超时秒数；
  // 其余数字（0、非 -1 负数、小数）按『不设置超时限制』自然语义处理；非数字视为未传入（回落协议超时）。
  // 仅 action=调用 时生效；action=查看协议 时不参与逻辑（本地读文件无 spawn 超时概念）。
  const timeoutOverride: number | undefined = typeof resolved.timeout === 'number' ? resolved.timeout : undefined;

  if (action === '调用') {
    if (!toolName) {
      return fail(SCRIPT_TOOL_CODES.PARAMS_INVALID, 'action=调用 时 tool_name 必填（取值为经验库内工具目录名，可先【查看协议】获取）');
    }
    if (!params) {
      return fail(SCRIPT_TOOL_CODES.PARAMS_INVALID, 'action=调用 时 params 必填（CLI/argparse 风格字符串，只填参数本身；调用前应先【查看协议】确认参数结构）');
    }
    return executeScriptToolCall(toolName, params, timeoutOverride, context);
  }
  return executeScriptToolView(toolName);
}

// ============================================================
// 分支一：查看协议（V1→V2/V3→V4a/V4b）
// ============================================================

async function executeScriptToolView(toolName: string | undefined): Promise<ToolResult> {
  // V1：根目录检查 + 兜底重建一次
  const ensure = ensureScriptToolsRootDir();
  if (!ensure.ok) {
    return buildDirMissingResult(ensure.error);
  }

  // V2/V3：扫描子目录（过滤两块文件齐备目录）+ 逐目录解析协议（坏目录逐条记录不阻断）
  const entries = await scanScriptToolsDir();
  const validEntries = entries.filter((entry): entry is Extract<ScriptToolScanEntry, { ok: true }> => entry.ok);
  const invalidEntries = entries.filter((entry): entry is Extract<ScriptToolScanEntry, { ok: false }> => !entry.ok);
  const validNames = validEntries.map((entry) => entry.dirName);

  // V4b：填写 tool_name → 返回该工具协议全文 + 解析摘要
  if (toolName) {
    const hit = validEntries.find((entry) => entry.dirName === toolName);
    if (!hit) {
      const invalidHit = invalidEntries.find((entry) => entry.dirName === toolName);
      const hint = invalidHit
        ? `目录 ${toolName} 存在但未通过校验：[${invalidHit.code}] ${invalidHit.error}`
        : '';
      return fail(
        SCRIPT_TOOL_CODES.TOOL_NOT_FOUND,
        `未找到工具目录 ${toolName}。${hint ? hint + '；' : ''}当前合法工具目录：${
          validNames.length > 0 ? validNames.join('、') : '（空）'
        }`,
      );
    }

    let protocolText: string;
    try {
      protocolText = await readFile(hit.protocolPath, 'utf-8');
    } catch (error) {
      return fail(
        SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
        `protocol.yaml 读取失败：${ensureErrorMessage(error)}`,
      );
    }

    return buildToolResult({
      success: true,
      message: `已返回工具「${toolName}」的协议全文（protocol.yaml 原样）与解析摘要。`,
      data: {
        tool_name: hit.dirName,
        root_dir: SCRIPTS_TOOLS_DIR,
        tool_dir: hit.toolDir,
        main_py_path: hit.mainPyPath,
        protocol_text: protocolText,
        protocol: {
          name: hit.protocol.name,
          title: hit.protocol.title,
          description: hit.protocol.description,
          inputSchema: hit.protocol.inputSchema,
          timeout_seconds: hit.protocol.timeoutSeconds,
          ...(hit.protocol.progressName ? { progress_name: hit.protocol.progressName } : {}),
          ...(hit.protocol.applicableConditions ? { applicable_conditions: hit.protocol.applicableConditions } : {}),
          ...(hit.protocol.pythonDeps ? { python_deps: hit.protocol.pythonDeps } : {}),
        },
      },
    });
  }

  // V4a：省略 tool_name → 聚合全部合法工具清单
  const data: Record<string, unknown> = {
    root_dir: SCRIPTS_TOOLS_DIR,
    tools: validEntries.map((entry) => ({
      tool_name: entry.dirName,
      name: entry.protocol.name,
      title: entry.protocol.title,
      description: entry.protocol.description,
      timeout_seconds: entry.protocol.timeoutSeconds,
      applicable_conditions: entry.protocol.applicableConditions ?? '（未声明适用条件）',
    })),
  };
  if (invalidEntries.length > 0) {
    data.invalid_tools = invalidEntries.map((entry) => ({
      tool_name: entry.dirName,
      code: entry.code,
      error: entry.error,
    }));
  }

  let message: string;
  if (validEntries.length === 0) {
    message =
      '经验库为空（空库属正常状态：经验库内容由使用期沉淀产生，无出厂预置）。' +
      '可先以【查看协议】确认现状，再按系统提示词【经验工具库维护规范】的维护规程沉淀首批工具。';
  } else {
    message = `经验库共 ${validEntries.length} 个可用工具${
      invalidEntries.length > 0 ? `；另有 ${invalidEntries.length} 个未通过校验的目录（见 data.invalid_tools）` : ''
    }。`;
  }

  // 超限兜底提示（R2：扫描期自动剔除已在协议层收口，本分支为删除未完全成功时的不可达兜底；不硬阻断，存量工具仍可调用）
  if (validEntries.length > MAX_SCRIPT_TOOLS) {
    data.warning =
      `SCRIPT_TOOL_DIR_LIMIT：合法工具数 ${validEntries.length} 超过 MAX_SCRIPT_TOOLS=${MAX_SCRIPT_TOOLS}（扫描期自动剔除未完全成功，存量工具仍可调用）；` +
      '请合并同类工具或手动清理创建时间最旧的工具目录。';
  }

  return buildToolResult({ success: true, message, data });
}

// ============================================================
// 分支二：调用（C1→C2/C3→C4→C5→C6→C7）
// ============================================================

async function executeScriptToolCall(
  toolName: string,
  params: string,
  timeoutOverride: number | undefined,
  context: ToolRuntimeContext,
): Promise<ToolResult> {
  // C1：根目录检查 + 兜底重建一次
  const ensure = ensureScriptToolsRootDir();
  if (!ensure.ok) {
    return buildDirMissingResult(ensure.error);
  }

  // C2/C3：定位工具目录（目录名精确等值）+ 协议校验（scan 已完成）
  const entries = await scanScriptToolsDir();
  const validEntries = entries.filter((entry): entry is Extract<ScriptToolScanEntry, { ok: true }> => entry.ok);
  const validNames = validEntries.map((entry) => entry.dirName);
  const hit = validEntries.find((entry) => entry.dirName === toolName);
  if (!hit) {
    const invalidHit = entries.find((entry): entry is Extract<ScriptToolScanEntry, { ok: false }> => !entry.ok && entry.dirName === toolName);
    if (invalidHit) {
      return fail(
        invalidHit.code,
        `工具目录 ${toolName} 校验未通过：${invalidHit.error}；当前合法工具目录：${
          validNames.length > 0 ? validNames.join('、') : '（空）'
        }`,
      );
    }
    return fail(
      SCRIPT_TOOL_CODES.TOOL_NOT_FOUND,
      `未找到工具目录 ${toolName}。当前合法工具目录：${validNames.length > 0 ? validNames.join('、') : '（空）'}`,
    );
  }

  // C4：校验 params string（CLI/argparse 风格基础校验；字段级约束由工具侧入口 argparse 承担）
  const paramsCheck = validateParamsString(params);
  if (!paramsCheck.ok) {
    return fail(
      SCRIPT_TOOL_CODES.PARAMS_INVALID,
      `params 校验失败（工具 ${toolName}）：${paramsCheck.error}。请先以【查看协议】核对该工具 protocol.yaml 的 inputSchema 定义。`,
    );
  }

  // C5：params string 直接作为启动命令 CLI 参数携带（移除 input.json 落地与 --input 传参；支持引号包裹含空格的值）
  const paramsArgs = tokenizeParamsString(params);

  // C6/C7：spawn 执行 + 收尾解析
  // 超时优先级（本轮决策）：调用参数 timeout 显式传入时完全优先（含 -1 挂起语义）；未传时回落协议
  // timeout_seconds（协议解析已归一化：缺省 180、上限 3600，恒为正整数）。
  const suspend = timeoutOverride === -1;
  const effectiveTimeoutSeconds =
    timeoutOverride !== undefined && !suspend ? timeoutOverride : hit.protocol.timeoutSeconds;
  return executeScriptToolProcess({
    paramsArgs,
    toolName,
    toolDir: hit.toolDir,
    mainPyPath: hit.mainPyPath,
    timeoutSeconds: effectiveTimeoutSeconds,
    suspend,
    context,
  });
}

// ============================================================
// C4：params string 校验（CLI/argparse 风格基础校验）与 CLI 参数分词
// ============================================================

/**
 * params string 基础校验：非空且至少含一个 --key 形式参数名。
 * 字段级约束（required/类型/enum）由工具侧入口 argparse 在进程内校验并回报错误，
 * 调用侧不再按协议逐字段预校验（params 为字符串形态，无法可靠反解字段结构）。
 */
function validateParamsString(params: string): { ok: true } | { ok: false; error: string } {
  const trimmed = params.trim();
  if (!trimmed) {
    return { ok: false, error: 'params 为空字符串：至少需要一个 --key value 参数' };
  }
  if (!/--[A-Za-z0-9][A-Za-z0-9-]*/.test(trimmed)) {
    return { ok: false, error: 'params 不是合法 CLI/argparse 风格参数串：未找到 --key 形式的参数名' };
  }
  return { ok: true };
}

/**
 * 将 params string 按 shell 风格分词为 argv 数组：支持单引号/双引号包裹含空格的值，
 * 引号仅作分组定界符不保留在 token 中；未闭合引号按普通字符处理。
 * 示例：--title "y = sin(x)" → ['--title', 'y = sin(x)']
 */
function tokenizeParamsString(params: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let hasToken = false;

  const push = () => {
    if (hasToken) {
      tokens.push(current);
      current = '';
      hasToken = false;
    }
  };

  for (const ch of params) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      hasToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      push();
      continue;
    }
    current += ch;
    hasToken = true;
  }
  push();
  return tokens;
}

// ============================================================
// C6/C7：spawn 执行内核（独立参照 dyn-tool-loader 模式实现，不 import）
// ============================================================

type PythonCommand = {
  command: string;
  prefixArgs: string[];
};

/** 解释器选择优先级（5.3）：内置 Python > 自定义路径 > 系统 python/python3 */
function resolveScriptToolPythonCommand(): PythonCommand {
  const settings = configManager.getSettings();

  if (settings.useBuiltinPython) {
    const builtinPath = pythonManager.getPythonPath();
    if (builtinPath) {
      return { command: builtinPath, prefixArgs: [] };
    }
  }

  const customPath = settings.customPythonPath;
  if (customPath && existsSync(customPath)) {
    return { command: customPath, prefixArgs: [] };
  }

  return process.platform === 'win32'
    ? { command: 'python', prefixArgs: [] }
    : { command: 'python3', prefixArgs: [] };
}

/** 环境约定（5.3）：UTF-8 强制 + SCRIPT_TOOL_WORK_DIR 产物落点（D14；未注入会话目录时=系统临时目录） */
function buildScriptToolEnv(runDir: string | undefined): NodeJS.ProcessEnv {
  // Node.js child_process spread required: 子进程需要继承 PATH 等环境变量定位解释器
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    SCRIPT_TOOL_WORK_DIR: runDir && runDir.trim() ? runDir : os.tmpdir(),
  };
}

async function executeScriptToolProcess(options: {
  paramsArgs: string[];
  toolName: string;
  toolDir: string;
  mainPyPath: string;
  timeoutSeconds: number;
  suspend: boolean;
  context: ToolRuntimeContext;
}): Promise<ToolResult> {
  const python = resolveScriptToolPythonCommand();

  return new Promise<ToolResult>((resolve) => {
    if (options.context.signal?.aborted) {
      resolve(fail(SCRIPT_TOOL_CODES.ABORTED, '经验库工具执行已被中止（进入前已中止）'));
      return;
    }

    const child = spawn(
      python.command,
      [...python.prefixArgs, options.mainPyPath, ...options.paramsArgs],
      {
        cwd: options.toolDir,
        env: buildScriptToolEnv(options.context.runDir),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    // 挂起类型调用（timeout=-1）：只负责启动进程——立即返回自洽 ToolResult（success=true），
    // 不等待进程结束、不采集 stdout/stderr、不设超时 kill、不挂 abort 监听（无 input.json 待清理）。
    // error 事件挂空监听：解释器缺失等异步启动失败时防止未处理 'error' 事件导致主进程崩溃（结果已返回不再改写）；
    // stdout/stderr 置流动模式丢弃数据：防止管道缓冲写满造成背压阻塞挂起进程。
    if (options.suspend) {
      child.once('error', () => {
        // 已返回的结果不再改写；仅吞掉事件避免未处理 'error' 导致进程崩溃
      });
      child.stdout?.resume();
      child.stderr?.resume();
      resolve(
        buildToolResult({
          success: true,
          message: `经验库工具（${options.toolName}）已按挂起类型启动（timeout=-1）：只启动进程，不等待结束、不采集输出、不超时终止。PID: ${
            child.pid ?? '未知'
          }；当前任务结束前请务必清理`,
          data: {
            tool_name: options.toolName,
            suspended: true,
            timeout: -1,
            pid: child.pid,
            main_py_path: options.mainPyPath,
            params_args: options.paramsArgs,
          },
        }),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;
    // 超时取值不拦截：仅正整数秒挂 kill 定时器；0、非 -1 负数、小数按『不设置超时限制』自然语义（不挂 kill 定时器）。
    const timeoutMs =
      options.timeoutSeconds > 0 && Number.isInteger(options.timeoutSeconds)
        ? options.timeoutSeconds * 1000
        : null;
    let timer: NodeJS.Timeout | null =
      timeoutMs !== null
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, timeoutMs)
        : null;

    const abortHandler = () => {
      if (settled) {
        return;
      }
      aborted = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      child.kill();
    };

    if (options.context.signal) {
      options.context.signal.addEventListener('abort', abortHandler, { once: true });
    }

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (options.context.signal) {
        options.context.signal.removeEventListener('abort', abortHandler);
      }
    };

    const finish = (result: ToolResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.once('error', (error) => {
      finish(
        fail(
          SCRIPT_TOOL_CODES.SPAWN_ERROR,
          `经验库工具（${options.toolName}）进程启动失败：${ensureErrorMessage(error)}（请检查 Python 环境与 main.py）`,
        ),
      );
    });

    child.once('close', (code) => {
      if (aborted) {
        finish(fail(SCRIPT_TOOL_CODES.ABORTED, `经验库工具（${options.toolName}）执行已被中止`));
        return;
      }
      if (timedOut) {
        finish(
          fail(
            SCRIPT_TOOL_CODES.TIMEOUT,
            `经验库工具（${options.toolName}）执行超时（${options.timeoutSeconds} 秒）已被终止；可调整调用参数 timeout 或 protocol.yaml 的 timeout_seconds（上限 ${SCRIPT_TOOL_TIMEOUT_MAX_SECONDS} 秒）`,
          ),
        );
        return;
      }

      // stdout/stderr 完整透传：不做 JSON 解析/末行提取/逐字段截断等加工，仅经 truncateToolOutput 16K 截断+提示后缀
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');

      const success = code === 0;
      const stdoutText = stdout.trim();
      const stderrText = stderr.trim();

      let message: string;
      if (stderrText) {
        message = truncateToolOutput(stderrText);
      } else if (!success) {
        message = `经验库工具（${options.toolName}）进程非零退出（code=${code ?? 'null'}）`;
      } else {
        message = '';
      }

      finish(
        buildToolResult({
          success,
          message,
          data: truncateToolOutput(stdoutText),
        }),
      );
    });
  });
}

