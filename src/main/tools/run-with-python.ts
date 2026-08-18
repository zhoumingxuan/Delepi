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
  type ToolResult,
} from './result';
import {
  ioPrint,
  truncateOutput,
} from '../utils/index';
import {
  MAX_OUTPUT_LENGTH,
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
};

type SpawnCommandResult = {
  returncode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
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

function buildTruncationMessage(result: Pick<
  SpawnCommandResult,
  'stdoutTruncated' | 'stderrTruncated'
>): string {
  const channels = [
    result.stdoutTruncated ? 'stdout' : '',
    result.stderrTruncated ? 'stderr' : '',
  ];

  return channels.length
    ? `${channels.join('、')} 输出超过 ${MAX_OUTPUT_LENGTH} 字符，已截断。`
    : '';
}

function toTimeoutSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  return DEFAULT_TIMEOUT_SECONDS;
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

  if (status.state === PythonState.INSTALLING_DEPS) {
    const pythonPath = pythonManager.getPythonPath();
    if (!pythonPath) {
      return 'Python 环境正在安装依赖包，请稍后重试。';
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

      const stdout = truncateOutput(
        decodeOutput(stdoutChunks, options.encoding),
        'stdout',
      );
      const stderr = truncateOutput(
        decodeOutput(stderrChunks, options.encoding),
        'stderr',
      );

      resolve({
        returncode: timedOut ? 124 : code ?? 1,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
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

      const truncationMessage = buildTruncationMessage(compileResult);
      const compileMessage = `Python 编译失败: ${compileResult.stderr || compileResult.stdout || 'Python 编译失败'}`;

      return buildToolResult({
        success: false,
        code: ERR_COMPILE_ERROR,
        message: truncationMessage
          ? `${compileMessage}\n${truncationMessage}`
          : compileMessage,
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
          stdout: '',
          stderr: 'ABORTED',
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
      const truncationMessage = buildTruncationMessage(runResult);
      const resultMessage = `Python 脚本执行超时: ${timeoutSeconds}s`;

      result = buildToolResult({
        success: false,
        code: ERR_TIMEOUT,
        message: truncationMessage
          ? `${resultMessage}\n${truncationMessage}`
          : resultMessage,
        data: buildExecutedToolResultData({
          returncode: 124,
          stdout: runResult.stdout,
          stderr: runResult.stderr,
          execId,
          responseId,
        }),
      });
    } else {
      const success = runResult.returncode === 0;
      const truncationMessage = buildTruncationMessage(runResult);
      const resultMessage = success
        ? 'Python 脚本执行完成'
        : `Python 脚本执行失败，退出码 ${runResult.returncode}`;

      result = buildToolResult({
        success,
        code: success ? ERR_OK : ERR_PROCESS_EXITED_NON_ZERO,
        message: truncationMessage
          ? `${resultMessage}\n${truncationMessage}`
          : resultMessage,
        data: buildExecutedToolResultData({
          returncode: runResult.returncode,
          stdout: runResult.stdout,
          stderr: runResult.stderr,
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
          stdout: '',
          stderr: 'ABORTED',
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
