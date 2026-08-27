/**
 * run_shell：极简单条操作系统命令执行器（用户 2026-08-27 00:03:10 修订版，取代旧版多行脚本方案）。
 * - Input 仅接受单条 `command` 命令字符串，无多行命令/多行脚本支持；
 * - 每次调用 spawn 一个独立 shell 子进程（Windows: powershell.exe -NoProfile -Command <command>；
 *   Linux: /bin/bash -c <command>），命令经命令行参数直传，工作目录经 spawn cwd 传入，进程执行完即退出；
 * - 无常驻/单例 shell 会话、无模块级可变状态、无临时脚本文件；
 * - timeout_seconds 默认 180s（可覆盖），超时 kill 后 returncode=124，abort 后 returncode=130；
 * - suspend 挂起模式：约 200ms 启动期确认子进程存活后立即返回真实子进程 PID（参照 run-with-python.ts L458-615）；
 * - 结果字段与 run_exe 逐字段一致（success/code/message/data{returncode,stdout,stderr,execId,responseId}；挂起成功附加 pid/platform）。
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeOptionalString, type ToolRuntimeContext } from './runtime-context';
import { buildExecutedToolResultData, buildToolResult, truncateToolOutput, type ToolResult } from './result';
import { ensureErrorMessage } from '../utils/index';
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_COMMAND_LENGTH,
  ERR_INVALID_ARGUMENT,
  ERR_COMMAND_TOO_LONG,
  ERR_INVALID_WORK_DIR,
  ERR_TIMEOUT,
  ERR_EXECUTION_ERROR,
  ERR_OK,
  ERR_COMMAND_EXITED_NON_ZERO,
} from '../constants';

type RunShellInput = {
  command?: unknown;
  run_dir?: unknown;
  exec_id?: unknown;
  suspend?: unknown;
  timeout_seconds?: unknown;
};

type ShellPlatform = 'windows' | 'linux' | 'macos';

type SpawnCommandResult = {
  returncode: number; stdout: string; stderr: string;
  timedOut: boolean;
};

type SuspendedSpawnResult = {
  exited: boolean; returncode: number | null;
  stdout: string; stderr: string;
  pid?: number; platform?: NodeJS.Platform;
};

/** 挂起模式启动期确认窗口（ms）：对齐 run-with-python.ts SUSPEND_STARTUP_DELAY_MS=200 */
const SUSPEND_STARTUP_DELAY_MS = 200;

function getShellPlatform(): ShellPlatform {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

/** shell 子进程命令构造：命令经命令行参数直传（spawn 参数风格参照 run-with-python.ts L315-422） */
function buildShellSpawn(platform: ShellPlatform, command: string): { command: string; args: string[] } {
  if (platform === 'windows') {
    return { command: 'powershell.exe', args: ['-NoProfile', '-Command', command] };
  }
  if (platform === 'macos') {
    return { command: '/bin/zsh', args: ['-c', command] };
  }
  return { command: '/bin/bash', args: ['-c', command] };
}

// 迁移 run-exe.ts L156-173
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

/** 指令包裹兜底剥离：单轮识别 markdown 代码块 / PowerShell 调用运算符 / 整体反引号 / 整体同类引号四类包裹并剥离；无法识别时原样返回 */
function stripCommandWrappers(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('```')) {
    const lines = text.split('\n');
    if (lines.length >= 2 && lines[lines.length - 1].trim() === '```') {
      text = lines.slice(1, -1).join('\n').trim();
    }
  }
  if (text.startsWith('&') && text.length > 1) {
    const rest = text.slice(1).trim();
    if (
      rest.length >= 2 &&
      ((rest.startsWith('"') && rest.endsWith('"')) ||
        (rest.startsWith("'") && rest.endsWith("'")))
    ) {
      text = rest.slice(1, -1).trim();
    }
  }
  if (text.length > 1 && text[0] === '`' && text[text.length - 1] === '`') {
    text = text.slice(1, -1).trim();
  } else if (
    text.length > 1 &&
    ((text[0] === '"' && text[text.length - 1] === '"') ||
      (text[0] === "'" && text[text.length - 1] === "'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

// 迁移 run-exe.ts L744-762
async function resolveWorkDir(inputWorkDir: string | null, context: ToolRuntimeContext | undefined): Promise<string | null> {
  const requestedDir = inputWorkDir || normalizeOptionalString(context?.runDir) || null;
  if (!requestedDir) {
    return null;
  }
  const resolvedDir = path.resolve(requestedDir);
  const runDirStat = await stat(resolvedDir);
  if (!runDirStat.isDirectory()) {
    throw new Error('run_dir 不存在或不是目录');
  }
  return resolvedDir;
}

// timeout_seconds 归一化：非法值回退 DEFAULT_TIMEOUT_SECONDS(180)
function toTimeoutSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_SECONDS;
}

/** 子进程输出解码：utf-8 严格试探 → GBK 回退（Windows PowerShell 管道输出默认为控制台代码页） */
function decodeOutput(chunks: Buffer[]): string {
  const buffer = Buffer.concat(chunks);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch {
      return new TextDecoder('utf-8').decode(buffer);
    }
  }
}

/**
 * 正常模式执行（参照 run-with-python.ts L315-422）：
 * spawn 后立即挂 data/error/close 监听；
 * 超时 kill → timedOut（returncode=124）；abort kill → ABORTED（returncode=130）；close 收尾返回。
 */
async function runSpawnCommand(
  platform: ShellPlatform,
  userCommand: string,
  options: { cwd: string | null; timeoutMs: number },
  signal?: AbortSignal,
): Promise<SpawnCommandResult> {
  return new Promise<SpawnCommandResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('ABORTED'));
      return;
    }
    const shell = buildShellSpawn(platform, userCommand);
    const child = spawn(shell.command, shell.args, {
      cwd: options.cwd ?? undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
    const abortHandler = () => {
      if (settled) return;
      aborted = true;
      if (timer) { clearTimeout(timer); timer = null; }
      child.kill();
    };
    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal) signal.removeEventListener('abort', abortHandler);
    };
    // 流式收集
    const collect = (chunks: Buffer[], chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    child.stdout.on('data', (chunk: Buffer | string) => collect(stdoutChunks, chunk));
    child.stderr.on('data', (chunk: Buffer | string) => collect(stderrChunks, chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true; cleanup();
      if (aborted) { reject(new Error('ABORTED')); return; }
      resolve({
        returncode: timedOut ? 124 : code ?? 1,
        stdout: decodeOutput(stdoutChunks),
        stderr: decodeOutput(stderrChunks),
        timedOut,
      });
    });
  });
}

/**
 * 挂起模式执行（参照 run-with-python.ts L458-615）：
 * - spawn 后约 200ms 启动期收集输出，不设超时定时器（timeout_seconds 语义=忽略）；
 * - 启动期内进程已退出（秒退/启动失败）→ 返回 exited=true，交由普通结果路径组装；
 * - 启动期内 abort → kill 并以 ABORTED 结束；
 * - 启动期后进程仍活 → 挂起成功返回真实子进程 PID；此后移除 abort 监听（生命周期由调用方管理）。
 */
async function runSuspendedSpawnCommand(
  platform: ShellPlatform,
  userCommand: string,
  options: { cwd: string | null },
  signal?: AbortSignal,
): Promise<SuspendedSpawnResult> {
  return new Promise<SuspendedSpawnResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('ABORTED'));
      return;
    }
    const shell = buildShellSpawn(platform, userCommand);
    const child = spawn(shell.command, shell.args, {
      cwd: options.cwd ?? undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let aborted = false;
    let settled = false;
    let collecting = true;
    const startupTimer: NodeJS.Timeout = setTimeout(() => {
      if (settled) return;
      settled = true; cleanup();
      if (aborted) { reject(new Error('ABORTED')); return; }
      const pid = child.pid;
      if (typeof pid !== 'number') {
        child.kill();
        reject(new Error('无法获取挂起 Shell 进程 PID'));
        return;
      }
      // 挂起成功：停止收集后续输出（流切换 flowing 丢弃，防父进程内存膨胀）
      collecting = false;
      child.stdout.removeAllListeners('data');
      child.stdout.resume();
      child.stderr.removeAllListeners('data');
      child.stderr.resume();
      resolve({
        exited: false,
        returncode: null,
        stdout: decodeOutput(stdoutChunks),
        stderr: decodeOutput(stderrChunks),
        pid,
        platform: process.platform,
      });
    }, SUSPEND_STARTUP_DELAY_MS);
    const abortHandler = () => {
      if (settled) return;
      aborted = true;
      child.kill();
    };
    const cleanup = () => {
      clearTimeout(startupTimer);
      if (signal) signal.removeEventListener('abort', abortHandler);
    };
    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (collecting) stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (collecting) stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true; cleanup();
      if (aborted) { reject(new Error('ABORTED')); return; }
      // 启动期内秒退：不返回已死 pid，结果交由普通结果路径处理
      resolve({
        exited: true,
        returncode: code ?? 1,
        stdout: decodeOutput(stdoutChunks),
        stderr: decodeOutput(stderrChunks),
      });
    });
  });
}

/**
 * run_shell 主入口：校验 → 工作目录解析 → 普通/挂起分支 → 结果组装
 * （结果字段与 run-exe.ts L764-995 runExe 逐字段一致）。
 */
export async function runShell(input: unknown, context: ToolRuntimeContext): Promise<ToolResult> {
  const resolvedInput = input && typeof input === 'object' ? (input as RunShellInput) : {};
  const responseId = randomUUID();
  const execId = normalizeOptionalString(resolvedInput.exec_id) || randomUUID();

  // 单条 command 校验（无多行命令/多行脚本支持）
  const commandRaw = resolvedInput.command;
  if (typeof commandRaw !== 'string' || !commandRaw.trim()) {
    return buildToolResult({ success: false, code: ERR_INVALID_ARGUMENT, message: 'command 必须为非空字符串（单条命令）' });
  }
  // 包裹兜底：剥离代码块/引号等已知包裹形态，识别不了照原样执行
  const command = stripCommandWrappers(commandRaw.trim());
  if (/[\r\n]/.test(command)) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'command 仅支持单条命令，不支持多行命令/多行脚本；复杂逻辑请改用 run_with_python',
    });
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    return buildToolResult({ success: false, code: ERR_COMMAND_TOO_LONG, message: `命令行超过 ${MAX_COMMAND_LENGTH} 字符` });
  }

  const platform = getShellPlatform();
  const suspend = normalizeOptionalBoolean(resolvedInput.suspend);

  const requestedWorkDir = normalizeOptionalString(resolvedInput.run_dir) || null;
  let workDir: string | null;
  try {
    workDir = await resolveWorkDir(requestedWorkDir, context);
  } catch (error) {
    return buildToolResult({ success: false, code: ERR_INVALID_WORK_DIR, message: `run_dir 非法：${ensureErrorMessage(error)}` });
  }

  const timeoutSeconds = toTimeoutSeconds(resolvedInput.timeout_seconds);

  // 与 run_exe 一致的正常退出结果组装
  const finish = (returncode: number, stdout: string, stderr: string): ToolResult => {
    const success = returncode === 0;
    const resultMessage = success ? '命令执行完成' : `命令执行失败，退出码 ${returncode}`;
    return buildToolResult({
      success,
      code: success ? ERR_OK : ERR_COMMAND_EXITED_NON_ZERO,
      message: resultMessage,
      data: buildExecutedToolResultData({ returncode, stdout: truncateToolOutput(stdout), stderr: truncateToolOutput(stderr), execId, responseId }),
    });
  };
  const abortedResult = (message: string): ToolResult =>
    buildToolResult({
      success: false,
      code: 'ABORTED',
      message,
      data: buildExecutedToolResultData({ returncode: 130, stdout: truncateToolOutput(''), stderr: truncateToolOutput('ABORTED'), execId, responseId }),
    });

  // 挂起模式：约 200ms 启动期确认存活后返回真实子进程 PID
  if (suspend) {
    try {
      const suspended = await runSuspendedSpawnCommand(platform, command, { cwd: workDir }, context.signal);
      if (suspended.exited) {
        return finish(suspended.returncode ?? 1, suspended.stdout, suspended.stderr);
      }
      return buildToolResult({
        success: true,
        code: ERR_OK,
        message: `\n当前进程(PID: ${suspended.pid})已挂起，【若用户无特殊要求则默认当前任务结束前清理】，当前平台: ${suspended.platform}`,
        data: buildExecutedToolResultData({
          returncode: 0,
          stdout: truncateToolOutput(suspended.stdout),
          stderr: truncateToolOutput(suspended.stderr),
          execId,
          responseId,
          extra: { pid: suspended.pid, platform: suspended.platform },
        }),
      });
    } catch (error) {
      const message = ensureErrorMessage(error);
      if (message === 'ABORTED') {
        return abortedResult('挂起命令执行已取消');
      }
      return buildToolResult({ success: false, code: ERR_EXECUTION_ERROR, message: `挂起命令执行异常：${message}` });
    }
  }

  // 普通模式
  try {
    const result = await runSpawnCommand(platform, command, { cwd: workDir, timeoutMs: timeoutSeconds * 1000 }, context.signal);
    if (result.timedOut) {
      const resultMessage = `命令执行超时（${timeoutSeconds}s），已终止进程`;
      return buildToolResult({
        success: false,
        code: ERR_TIMEOUT,
        message: resultMessage,
        data: buildExecutedToolResultData({ returncode: 124, stdout: truncateToolOutput(result.stdout), stderr: truncateToolOutput(result.stderr), execId, responseId }),
      });
    }
    return finish(result.returncode, result.stdout, result.stderr);
  } catch (error) {
    const message = ensureErrorMessage(error);
    if (message === 'ABORTED') {
      return abortedResult('命令执行已取消');
    }
    return buildToolResult({ success: false, code: ERR_EXECUTION_ERROR, message: `命令执行异常：${message}` });
  }
}
