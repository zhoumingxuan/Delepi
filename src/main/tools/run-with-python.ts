import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { ToolRuntimeContext } from './runtime-context';
import { pythonManager, PythonState } from '../modules/python';
import { configManager } from '../modules/config/config-manager';
import {
  buildExecutedToolResultData,
  buildToolResult,
  truncateToolOutput,
  type ToolResult,
} from './result';
import {
  ioPrint,
} from '../utils/index';
import {
  DEFAULT_TIMEOUT_SECONDS,
  PYCACHE_DIR_NAME,
  ERR_INVALID_ARGUMENT,
  ERR_INVALID_RUN_DIR,
  ERR_WRITE_FILE_ERROR,
  ERR_COMPILE_ERROR,
  ERR_TIMEOUT,
  ERR_EXECUTION_ERROR,
  ERR_OK,
  ERR_PROCESS_EXITED_NON_ZERO,
  ERR_CONFIG_NOT_READY,
} from '../constants';

type PythonCommand = {
  command: string;
  prefixArgs: string[];
};

type RunWithPythonInput = {
  python_code?: unknown;
  run_dir?: unknown;
  save_file_path?: unknown;
  runtime_encoding?: unknown;
  timeout_seconds?: unknown;
  suspend?: unknown;
};

type SpawnCommandResult = {
  returncode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const UTF8_RUNTIME_ENCODING_PATTERN = /^utf-?8$/i;

function buildPythonUtf8Env(): NodeJS.ProcessEnv {
  // Node.js child_process spread required: child process needs inherited env (PATH 等) to locate python executable
  // 这是 Node.js child_process 框架运行时的必要依赖，不可去除
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(process.platform === 'win32'
      ? {}
      : {
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
        }),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };

  // 根据配置将 Python 目录前置到 PATH，并设置虚拟环境变量
  const settings = configManager.getSettings();
  let pythonDir = '';

  if (settings.useBuiltinPython) {
    // 内置模式：将 Python 版本目录前置到 PATH
    const pythonPath = pythonManager.getPythonPath();
    if (pythonPath) {
      pythonDir = path.dirname(pythonPath);
    }
  } else if (settings.customPythonPath) {
    // 自定义模式：推断 venv/conda 并设置环境变量
    pythonDir = path.dirname(settings.customPythonPath);
    const parentDir = path.dirname(pythonDir);
    const dirName = path.basename(pythonDir);

    // 检测 venv：python 在 <venv>/Scripts/（Win）或 <venv>/bin/（Unix）
    if (dirName === 'Scripts' || dirName === 'bin') {
      const activateScript = process.platform === 'win32'
        ? path.join(pythonDir, 'activate.bat')
        : path.join(pythonDir, 'activate');
      if (existsSync(activateScript)) {
        env.VIRTUAL_ENV = parentDir;
      }
    }

    // 检测 conda：检查 conda-meta 目录
    const condaMetaInPythonDir = path.join(pythonDir, 'conda-meta');
    const condaMetaInParentDir = path.join(parentDir, 'conda-meta');
    if (existsSync(condaMetaInPythonDir)) {
      env.CONDA_PREFIX = pythonDir;
    } else if (existsSync(condaMetaInParentDir)) {
      env.CONDA_PREFIX = parentDir;
    }
  }

  // 将 Python 目录前置到 PATH
  if (pythonDir) {
    env.PATH = `${pythonDir}${path.delimiter}${env.PATH || ''}`;
  }

  return env;
}

function normalizePath(pathText: unknown): string {
  return String(pathText ?? '').trim().replace(/^["']+|["']+$/g, '');
}

async function safeRemoveFile(filePath: string): Promise<boolean> {
  try {
    if (!filePath) {
      return false;
    }

    const fileStat = await stat(filePath);

    if (!fileStat.isFile()) {
      return false;
    }

    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

async function safeRemovePycache(runDir: string): Promise<boolean> {
  try {
    if (!runDir) {
      return false;
    }

    const pycachePath = path.join(runDir, PYCACHE_DIR_NAME);
    const pycacheStat = await stat(pycachePath);

    if (!pycacheStat.isDirectory()) {
      return false;
    }

    await rm(pycachePath, {
      recursive: true,
      force: true,
    });
    return true;
  } catch {
    return false;
  }
}

function decodeOutput(chunks: Buffer[], encoding: string): string {
  const decoder = new TextDecoder(encoding);
  return decoder.decode(Buffer.concat(chunks));
}

function toTimeoutSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  return DEFAULT_TIMEOUT_SECONDS;
}

function normalizeOptionalBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off' || normalized === '') {
      return false;
    }
  }
  return false;
}

function getPythonCommand(): PythonCommand {
  // 读取配置：是否使用内置 Python
  const useBuiltinPython = configManager.getSettings().useBuiltinPython;

  if (useBuiltinPython) {
    // 优先使用内置 Python
    const builtinPath = pythonManager.getPythonPath();
    if (builtinPath) {
      return {
        command: builtinPath,
        prefixArgs: [],
      };
    }
    // M2 修复：内置路径为空时不再静默落穿到系统 Python（原 :221-225 裸 'python' fallback）。
    // 按 checkPythonReady 语义显式报错；useBuiltinPython=false 的系统 Python 合法语义不受影响。
    const pythonNotReady = checkPythonReady();
    const stateText = pythonManager.getStatus().state;
    throw new Error(
      pythonNotReady
        ? `内置 Python 不可用（状态: ${stateText}）：${pythonNotReady}`
        : `内置 Python 状态为 ${stateText} 但解释器路径为空（状态机异常），请重启应用或前往设置重新下载内置 Python；也可在设置中关闭“使用内置 Python”改用自定义或系统 Python。`,
    );
  } else {
    // 自定义 Python 环境：优先使用用户指定的路径
    const customPath = configManager.getSettings().customPythonPath;
    if (customPath && existsSync(customPath)) {
      return {
        command: customPath,
        prefixArgs: [],
      };
    }
  }

  // Fallback：系统 Python（平台判断）
  if (process.platform === 'win32') {
    return {
      command: 'python',
      prefixArgs: [],
    };
  }

  return {
    command: 'python3',
    prefixArgs: [],
  };
}

/**
 * 检查 Python 是否就绪，若未就绪返回友好错误信息
 */
function checkPythonReady(): string | null {
  const status = pythonManager.getStatus();

  if (status.state === PythonState.READY) {
    return null;
  }

  if (status.state === PythonState.DETECTING) {
    return 'Python 环境正在检测中，请稍后重试。';
  }

  if (status.state === PythonState.DOWNLOADING) {
    const progress = status.progress ?? 0;
    return `Python 环境正在下载中（${progress}%），请稍后重试。`;
  }

  if (status.state === PythonState.EXTRACTING) {
    return 'Python 环境正在解压配置中，请稍后重试。';
  }

  if (status.state === PythonState.FAILED) {
    return `Python 环境初始化失败: ${status.error || '未知错误'}`;
  }


  if (status.state === PythonState.CANCELLED_PHASE1) {
    return 'Python 环境安装已取消，Python 不可用。';
  }

  if (status.state === PythonState.CANCELLED_PHASE2) {
    const pythonPath = pythonManager.getPythonPath();
    if (!pythonPath) {
      return 'Python 环境安装已取消，Python 不可用。';
    }
    return null;
  }

  if (status.state === PythonState.INSTALLING_PIP) {
    const pythonPath = pythonManager.getPythonPath();
    if (!pythonPath) {
      return 'Python 环境正在安装 pip，请稍后重试。';
    }
    return null;
  }


  return null;
}

async function runSpawnCommand(
  pythonCommand: PythonCommand,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    encoding: string;
  },
  signal?: AbortSignal,
): Promise<SpawnCommandResult> {
  return new Promise<SpawnCommandResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('ABORTED'));
      return;
    }
    const child = spawn(pythonCommand.command, [...pythonCommand.prefixArgs, ...args], {
      cwd: options.cwd,
      env: buildPythonUtf8Env(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

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

    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.once('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    });

    child.once('close', (code) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (aborted) {
        reject(new Error('ABORTED'));
        return;
      }

      resolve({
        returncode: timedOut ? 124 : code ?? 1,
        stdout: decodeOutput(stdoutChunks, options.encoding),
        stderr: decodeOutput(stderrChunks, options.encoding),
        timedOut,
      });
    });
  });
}

/**
 * 方向6挂起模式启动期（毫秒）：与 run-shell.ts 挂起启动期 200ms 对齐（A6-1）。
 */
const SUSPEND_STARTUP_DELAY_MS = 200;

type SuspendedSpawnResult =
  | {
      exited: true;
      returncode: number;
      stdout: string;
      stderr: string;
    }
  | {
      exited: false;
      returncode: null;
      stdout: string;
      stderr: string;
      pid: number;
      platform: NodeJS.Platform;
    };

/**
 * 挂起模式执行（A6-1/A6-2）：
 * - spawn 后不等 close：监听 stdout/stderr data 事件收集启动期输出；
 * - 不设超时定时器（timeout_seconds 语义=忽略）；
 * - 启动期（200ms）内 abort → kill 并以 ABORTED 结束（returncode 130 协议参照 run-shell.ts）；
 * - 启动期内进程已 exit（秒退/启动失败）→ 返回 exited=true（不返回已死 pid）；
 * - 启动期后进程仍活 → 挂起成功返回 pid；此后移除 abort 监听（启动期后不受会话 abort 影响），
 *   tmp 脚本与 __pycache__ 保留（由调用方经 scriptPath 在任务结束前清理）。
 */
async function runSuspendedSpawnCommand(
  pythonCommand: PythonCommand,
  args: string[],
  options: {
    cwd: string;
    encoding: string;
  },
  signal?: AbortSignal,
): Promise<SuspendedSpawnResult> {
  return new Promise<SuspendedSpawnResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('ABORTED'));
      return;
    }

    const child = spawn(pythonCommand.command, [...pythonCommand.prefixArgs, ...args], {
      cwd: options.cwd,
      env: buildPythonUtf8Env(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let aborted = false;
    let settled = false;
    let collecting = true;

    // A6-2：挂起模式不设超时定时器（timeout_seconds 语义=忽略，DEFAULT_TIMEOUT_SECONDS 豁免）
    const startupTimer: NodeJS.Timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      if (aborted) {
        // 启动期内 abort 已 kill：即使进程尚未完全退出也不返回 pid
        reject(new Error('ABORTED'));
        return;
      }

      const pid = child.pid;

      if (typeof pid !== 'number') {
        child.kill();
        reject(new Error('无法获取挂起 Python 进程 PID'));
        return;
      }

      // 挂起成功：停止收集后续输出（流切换 flowing 丢弃，防父进程内存膨胀且不阻塞子进程写管道）
      collecting = false;
      child.stdout.removeAllListeners('data');
      child.stdout.resume();
      child.stderr.removeAllListeners('data');
      child.stderr.resume();

      resolve({
        exited: false,
        returncode: null,
        stdout: decodeOutput(stdoutChunks, options.encoding),
        stderr: decodeOutput(stderrChunks, options.encoding),
        pid,
        platform: process.platform,
      });
    }, SUSPEND_STARTUP_DELAY_MS);

    const abortHandler = () => {
      if (settled) {
        return;
      }
      // A6-2：仅启动期内 abort 生效 → kill（close 事件触发后以 ABORTED 结束）
      aborted = true;
      child.kill();
    };

    const cleanup = () => {
      clearTimeout(startupTimer);
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    child.stdout.on('data', (chunk: Buffer | string) => {
      if (!collecting) {
        return;
      }
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      if (!collecting) {
        return;
      }
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.once('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      // spawn 启动失败：进程从未存活，走既有异常路径
      reject(error);
    });

    child.once('close', (code) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (aborted) {
        // 启动期内 abort：kill 后进程退出 → ABORTED（returncode 130）
        reject(new Error('ABORTED'));
        return;
      }

      // 启动期内秒退：不返回已死 pid，结果交由普通模式既有结果路径处理
      resolve({
        exited: true,
        returncode: code ?? 1,
        stdout: decodeOutput(stdoutChunks, options.encoding),
        stderr: decodeOutput(stderrChunks, options.encoding),
      });
    });
  });
}


async function resolveExecutionPaths(
  input: RunWithPythonInput,
  context: ToolRuntimeContext | undefined,
): Promise<{
  runDir: string;
  scriptPath: string;
  persistScript: boolean;
}> {
  const requestedRunDir = normalizePath(input.run_dir);
  const requestedSavePath = normalizePath(input.save_file_path);

  const resolvedRunDir = requestedRunDir || normalizePath(context?.runDir) || process.cwd();

  const scriptPath = requestedSavePath
    ? requestedSavePath
    : path.join(
        resolvedRunDir,
        `tmp_run_with_python_${randomUUID().replace(/-/g, '')}.py`,
      );

  return {
    runDir: resolvedRunDir,
    scriptPath,
    persistScript: Boolean(requestedSavePath),
  };
}

export async function runWithPython(
  input: unknown,
  context: ToolRuntimeContext,
): Promise<ToolResult> {
  const resolvedInput =
    input && typeof input === 'object' ? (input as RunWithPythonInput) : {};
  const responseId = randomUUID();
  const execId = randomUUID();
  const code = String(resolvedInput.python_code ?? '');
  const inputRuntimeEncoding =
    String(resolvedInput.runtime_encoding ?? 'utf-8').trim() || 'utf-8';
  const resolvedRuntimeEncoding = UTF8_RUNTIME_ENCODING_PATTERN.test(
    inputRuntimeEncoding,
  )
    ? 'utf-8'
    : '';
  const timeoutSeconds = toTimeoutSeconds(resolvedInput.timeout_seconds);
  // S6-1 方向6：suspend 挂起模式开关（默认 false=现状等价；true 仅监控类长任务）
  const suspend = normalizeOptionalBoolean(resolvedInput.suspend);

  // 主进程配置就绪检查守卫
  const settings = configManager.getSettings();
  const llmConfigured =
    settings.mainModelBaseUrl.trim().length > 0 &&
    settings.mainModelApiKey.trim().length > 0 &&
    settings.mainModelName.trim().length > 0;

  if (!llmConfigured) {
    return buildToolResult({
      success: false,
      code: ERR_CONFIG_NOT_READY,
      message: '大模型配置未完成，请在设置中配置主模型（Base URL / API Key / 模型名称）。',
    });
  }

  if (settings.useBuiltinPython) {
    const pythonNotReady = checkPythonReady();
    if (pythonNotReady) {
      return buildToolResult({
        success: false,
        code: ERR_CONFIG_NOT_READY,
        message: pythonNotReady,
      });
    }
  } else {
    const customPath = settings.customPythonPath;
    if (customPath) {
      if (!existsSync(customPath)) {
        return buildToolResult({
          success: false,
          code: ERR_CONFIG_NOT_READY,
          message: `自定义 Python 路径无效: ${customPath}`,
        });
      }
    } else {
      const sysInfo = await pythonManager.detectSystemPython();
      if (!sysInfo.found) {
        return buildToolResult({
          success: false,
          code: ERR_CONFIG_NOT_READY,
          message: '系统 Python 未找到，请在系统 PATH 中安装 Python 或在设置中启用内置 Python。',
        });
      }
    }
  }

  ioPrint(
    '\nPython input:\n',
    '\npython_code:\n',
    code,
    '\nrun_dir:\n',
    resolvedInput.run_dir,
    '\nsave_file_path:\n',
    resolvedInput.save_file_path,
    '\nruntime_encoding:\n',
    inputRuntimeEncoding,
  );

  if (!code) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'python_code 不能为空',
    });
  }

  if (!resolvedRuntimeEncoding) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: `runtime_encoding 仅支持 utf-8，当前值: ${inputRuntimeEncoding}`,
    });
  }

  let runDir: string;
  let scriptPath: string;
  let persistScript: boolean;

  try {
    ({
      runDir,
      scriptPath,
      persistScript,
    } = await resolveExecutionPaths(resolvedInput, context));
  } catch (error) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (!runDir) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'run_dir 不能为空',
    });
  }

  try {
    const runDirStat = await stat(runDir);

    if (!runDirStat.isDirectory()) {
      return buildToolResult({
        success: false,
        code: ERR_INVALID_RUN_DIR,
        message: 'run_dir 不存在或不是目录',
      });
    }
  } catch {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_RUN_DIR,
      message: 'run_dir 不存在或不是目录',
    });
  }

  const scriptDir = path.dirname(scriptPath);

  if (scriptDir && scriptDir !== '.') {
    await mkdir(scriptDir, { recursive: true });
  }

  try {
    await writeFile(scriptPath, code, {
      encoding: 'utf8',
    });
  } catch (error) {
    return buildToolResult({
      success: false,
      code: ERR_WRITE_FILE_ERROR,
      message: `写入 Python 文件失败: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  // 检查 Python 环境就绪状态（仅内置 Python 模式需要）
  if (configManager.getSettings().useBuiltinPython) {
    const pythonNotReady = checkPythonReady();
    if (pythonNotReady) {
      return buildToolResult({
        success: false,
        code: ERR_EXECUTION_ERROR,
        message: pythonNotReady,
      });
    }
  }

  let pythonCommand: PythonCommand;
  try {
    pythonCommand = getPythonCommand();
  } catch (error) {
    return buildToolResult({
      success: false,
      code: ERR_CONFIG_NOT_READY,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const compileResult = await runSpawnCommand(
      pythonCommand,
      ['-m', 'py_compile', scriptPath],
      {
        cwd: runDir,
        timeoutMs: timeoutSeconds * 1000,
        encoding: resolvedRuntimeEncoding,
      },
      context.signal,
    );

    if (compileResult.returncode !== 0) {
      if (!persistScript) {
        await safeRemoveFile(scriptPath);
      }

      await safeRemovePycache(runDir);

      const compileMessage = `Python 编译失败: ${compileResult.stderr || compileResult.stdout || 'Python 编译失败'}`;

      return buildToolResult({
        success: false,
        code: ERR_COMPILE_ERROR,
        message: compileMessage,
      });
    }
  } catch (error) {
    if (!persistScript) {
      await safeRemoveFile(scriptPath);
    }

    await safeRemovePycache(runDir);

    if (error instanceof Error && error.message === 'ABORTED') {
      return buildToolResult({
        success: false,
        code: 'ABORTED',
        message: 'Python 编译已取消',
        data: buildExecutedToolResultData({
          returncode: 130,
          stdout: truncateToolOutput(''),
          stderr: truncateToolOutput('ABORTED'),
          execId,
          responseId,
        }),
      });
    }

    return buildToolResult({
      success: false,
      code: ERR_COMPILE_ERROR,
      message: `Python 编译失败: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const executionScriptPath = scriptPath;

  // S6-2 方向6挂起模式（A6-1/A6-2/A6-3）：suspend=true 时监控类长任务挂起支持。
  // 分支位于普通模式 try/finally 之前：挂起成功路径提前 return 天然跳过 finally 清理
  // （tmp 脚本与 __pycache__ 保留，scriptPath 已暴露，由调用方在任务结束前清理）。
  if (suspend) {
    try {
      const suspended = await runSuspendedSpawnCommand(
        pythonCommand,
        [executionScriptPath],
        {
          cwd: runDir,
          encoding: resolvedRuntimeEncoding,
        },
        context.signal,
      );

      // 启动期内秒退（200ms 内 exit）：走普通模式既有结果路径（不返回已死 pid），并执行清理（进程已死，非挂起成功）
      if (suspended.exited) {
        const success = suspended.returncode === 0;
        const resultMessage = success
          ? 'Python 脚本执行完成'
          : `Python 脚本执行失败，退出码 ${suspended.returncode}`;

        const exitedResult = buildToolResult({
          success,
          code: success ? ERR_OK : ERR_PROCESS_EXITED_NON_ZERO,
          message: resultMessage,
          data: buildExecutedToolResultData({
            returncode: suspended.returncode,
            stdout: truncateToolOutput(suspended.stdout),
            stderr: truncateToolOutput(suspended.stderr),
            execId,
            responseId,
          }),
        });

        if (!persistScript) {
          await safeRemoveFile(scriptPath);
        }
        await safeRemovePycache(runDir);

        ioPrint('\nPython output:\n', JSON.stringify(exitedResult), '\n');
        return exitedResult;
      }

      // 启动期后进程仍活：挂起成功，返回 pid/platform/scriptPath（timeout_seconds 忽略、finally 清理跳过）
      // 【待用户定稿：P-7】挂起清理提示文案（参照 run-shell.ts 挂起 message 句式：含 PID/平台，另附脚本路径与树杀指引）
      const suspendMessage = `\n当前进程(PID: ${suspended.pid})已挂起，脚本路径: ${scriptPath}，当前任务结束前请务必清理（可用 run_shell 执行 taskkill /PID ${suspended.pid} /T /F），当前平台: ${suspended.platform}`;

      const suspendedResult = buildToolResult({
        success: true,
        code: ERR_OK,
        message: suspendMessage,
        data: buildExecutedToolResultData({
          returncode: 0,
          stdout: truncateToolOutput(suspended.stdout),
          stderr: truncateToolOutput(suspended.stderr),
          execId,
          responseId,
          extra: { pid: suspended.pid, platform: suspended.platform, scriptPath },
        }),
      });

      ioPrint('\nPython output:\n', JSON.stringify(suspendedResult), '\n');
      return suspendedResult;
    } catch (error) {
      // 启动期内 abort → 已 kill：ABORTED / returncode 130（协议对齐 run-shell.ts 挂起 abort 路径）
      if (error instanceof Error && error.message === 'ABORTED') {
        const abortedResult = buildToolResult({
          success: false,
          code: 'ABORTED',
          message: 'Python 挂起执行已取消',
          data: buildExecutedToolResultData({
            returncode: 130,
            stdout: truncateToolOutput(''),
            stderr: truncateToolOutput('ABORTED'),
            execId,
            responseId,
          }),
        });

        if (!persistScript) {
          await safeRemoveFile(scriptPath);
        }
        await safeRemovePycache(runDir);

        ioPrint('\nPython output:\n', JSON.stringify(abortedResult), '\n');
        return abortedResult;
      }

      // 启动失败（spawn error 等）：走既有异常路径并清理（进程未存活/未挂起成功）
      const errorResult = buildToolResult({
        success: false,
        code: ERR_EXECUTION_ERROR,
        message: `Python 脚本执行异常: ${error instanceof Error ? error.message : String(error)}`,
      });

      if (!persistScript) {
        await safeRemoveFile(scriptPath);
      }
      await safeRemovePycache(runDir);

      ioPrint('\nPython output:\n', JSON.stringify(errorResult), '\n');
      return errorResult;
    }
  }

  // local模式：跳过server wrapper逻辑，直接执行脚本

  let result: ToolResult;

  try {
    const runResult = await runSpawnCommand(
      pythonCommand,
      [executionScriptPath],
      {
        cwd: runDir,
        timeoutMs: timeoutSeconds * 1000,
        encoding: resolvedRuntimeEncoding,
      },
      context.signal,
    );

    if (runResult.timedOut) {
      const resultMessage = `Python 脚本执行超时: ${timeoutSeconds}s`;

      result = buildToolResult({
        success: false,
        code: ERR_TIMEOUT,
        message: resultMessage,
        data: buildExecutedToolResultData({
          returncode: 124,
          stdout: truncateToolOutput(runResult.stdout),
          stderr: truncateToolOutput(runResult.stderr),
          execId,
          responseId,
        }),
      });
    } else {
      const success = runResult.returncode === 0;
      const resultMessage = success
        ? 'Python 脚本执行完成'
        : `Python 脚本执行失败，退出码 ${runResult.returncode}`;

      result = buildToolResult({
        success,
        code: success ? ERR_OK : ERR_PROCESS_EXITED_NON_ZERO,
        message: resultMessage,
        data: buildExecutedToolResultData({
          returncode: runResult.returncode,
          stdout: truncateToolOutput(runResult.stdout),
          stderr: truncateToolOutput(runResult.stderr),
          execId,
          responseId,
        }),
      });
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'ABORTED') {
      result = buildToolResult({
        success: false,
        code: 'ABORTED',
        message: 'Python 脚本执行已取消',
        data: buildExecutedToolResultData({
          returncode: 130,
          stdout: truncateToolOutput(''),
          stderr: truncateToolOutput('ABORTED'),
          execId,
          responseId,
        }),
      });
    } else {
      result = buildToolResult({
        success: false,
        code: ERR_EXECUTION_ERROR,
        message: `Python 脚本执行异常: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  } finally {
    if (!persistScript) {
      await safeRemoveFile(scriptPath);
    }

    await safeRemovePycache(runDir);
  }

  ioPrint('\nPython output:\n', JSON.stringify(result), '\n');
  return result;
}
