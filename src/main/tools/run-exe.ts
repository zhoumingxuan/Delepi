import { randomUUID } from 'node:crypto';
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import {
  normalizeOptionalString,
  type ToolRuntimeContext,
} from './runtime-context';
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
  DEFAULT_TIMEOUT_SECONDS,
  MAX_COMMAND_LENGTH,
  MAX_OUTPUT_LENGTH,
  ERR_INVALID_ARGUMENT,
  ERR_COMMAND_TOO_LONG,
  ERR_COMMAND_REJECTED,
  ERR_INVALID_WORK_DIR,
  ERR_TIMEOUT,
  ERR_EXECUTION_ERROR,
  ERR_OK,
  ERR_COMMAND_EXITED_NON_ZERO,
} from '../constants';
import { pythonManager } from '../modules/python';
import { configManager } from '../modules/config/config-manager';

type RunExeInput = {
  cmd_lines?: unknown;
  run_dir?: unknown;
  work_dir?: unknown;
  exec_id?: unknown;
  suspend?: unknown;
};

type ShellPlatform = 'windows' | 'linux';

type ShellCommand = {
  command: string;
  args: string[];
  platform: ShellPlatform;
};

type ShellWorker = {
  process: ChildProcessWithoutNullStreams;
  stdin: NodeJS.WritableStream;
  stdoutQueue: string[];
  stderrQueue: string[];
  stdoutRemainder: string;
  stderrRemainder: string;
  platform: ShellPlatform;
};

type WorkerRunResult = {
  returncode: number;
  stdout: string;
  stderr: string;
};


type WorkerSuspendedResult = {
  pid: number;
  platform: ShellPlatform;
  stdout: string;
  stderr: string;
};

const WINDOWS_DENY_PATTERNS = [
  /\bnpm\s+run\s+(dev|start|serve|watch)\b/i,
  /\byarn\s+(dev|start|serve)\b/i,
  /\bpnpm\s+(dev|start|serve|watch)\b/i,
  /\bnext\s+dev\b/i,
  /\bvite\s+dev\b/i,
  /\bwebpack\s+serve\b/i,
  /\bping\s+-t\b/i,
  /\btail\s+-f\b/i,
  /\bget-content\b.*\b-wait\b/i,
  /\bwatch\b/i,
  /\bpause\b/i,
  /\bread-host\b/i,
  /\bmore\b/i,
  /\bless\b/i,
  /\bssh\b/i,
];

const LINUX_DENY_PATTERNS = [
  /\bnpm\s+run\s+(dev|start|serve|watch)\b/i,
  /\byarn\s+(dev|start|serve|watch)\b/i,
  /\bpnpm\s+(dev|start|serve|watch)\b/i,
  /\bnext\s+dev\b/i,
  /\bvite\s+dev\b/i,
  /\bwebpack\s+serve\b/i,
  /\bping\b(?!.*\s-c\s+\d+)/i,
  /\btail\s+-f\b/i,
  /\bwatch\b/i,
  /\bread\b/i,
  /\bmore\b/i,
  /\bless\b/i,
  /\bman\b/i,
  /\btop\b/i,
  /\bhtop\b/i,
  /\bvim\b/i,
  /\bvi\b/i,
  /\bnano\b/i,
  /\bssh\b/i,
];

const PACKAGE_INSTALL_LINE_PATTERNS = [
  /^\s*(?:pip3?|pip3?\.exe)\s+install(?:\s+.+)?\s*$/i,
  /^\s*(?:python(?:\d+(?:\.\d+)?)?|python(?:\d+(?:\.\d+)?)?\.exe|py|py\.exe)\s+-m\s+pip\s+install(?:\s+.+)?\s*$/i,
  /^\s*(?:npm|npm\.cmd|npm\.exe)\s+(?:install|i)(?:\s+.+)?\s*$/i,
];
const PACKAGE_INSTALL_COMMAND_PATTERNS = [
  /(?:^|[;&|])\s*(?:pip3?|pip3?\.exe)\s+install\b/i,
  /(?:^|[;&|])\s*(?:python(?:\d+(?:\.\d+)?)?|python(?:\d+(?:\.\d+)?)?\.exe|py|py\.exe)\s+-m\s+pip\s+install\b/i,
  /(?:^|[;&|])\s*(?:npm|npm\.cmd|npm\.exe)\s+(?:install|i)\b/i,
];

let shellWorker: ShellWorker | null = null;
let workerLock: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withWorkerLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = workerLock;
  let release!: () => void;
  workerLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  return previous
    .then(task)
    .finally(() => {
      release();
    });
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
function stripScriptComments(script: string): string {
  return script
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .join('\n');
}

function getShellPlatform(): ShellPlatform {
  return process.platform === 'win32' ? 'windows' : 'linux';
}

function detectPatternRisk(
  script: string,
  patterns: RegExp[],
  messagePrefix: string,
): string | null {
  const normalizedScript = stripScriptComments(script)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  for (const pattern of patterns) {
    if (pattern.test(normalizedScript)) {
      return `${messagePrefix}：${pattern.source}`;
    }
  }

  return null;
}

function detectHangRisk(script: string, platform: ShellPlatform): string | null {
  return detectPatternRisk(
    script,
    platform === 'windows' ? WINDOWS_DENY_PATTERNS : LINUX_DENY_PATTERNS,
    '检测到可能导致任务挂起/常驻的命令模式，已拒绝执行',
  );
}

function getCommandLines(script: string): string[] {
  return script
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function containsShellOperator(line: string): boolean {
  return ['&&', '||', ';', '|', '>', '<', '`', '$('].some((token) =>
    line.includes(token),
  );
}

function isPackageInstallLine(line: string): boolean {
  return (
    !containsShellOperator(line) &&
    PACKAGE_INSTALL_LINE_PATTERNS.some((pattern) => pattern.test(line))
  );
}

function detectPackageInstallSyntaxRisk(script: string): string | null {
  const riskyLine = getCommandLines(script).find(
    (line) =>
      PACKAGE_INSTALL_COMMAND_PATTERNS.some((pattern) => pattern.test(line)) &&
      !isPackageInstallLine(line),
  );

  return riskyLine ? 'install 命令必须单独成行执行' : null;
}

function detectPythonInvocation(script: string, platform: ShellPlatform): boolean {
  if (platform === 'windows') {
    // Match python, python.exe, py.exe but not pythonw, pythonw.exe
    return /\bpython(?:w)?(?:\.exe)?\b/i.test(script) || /\bpy(?:\.exe)?\b/i.test(script);
  }
  // Linux/macOS: match python, python3, /usr/bin/python, etc.
  return /\bpython3?\b/i.test(script);
}

function appendStreamChunks(
  worker: ShellWorker,
  channel: 'stdout' | 'stderr',
  chunk: Buffer | string,
): void {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
  const remainderKey = channel === 'stdout' ? 'stdoutRemainder' : 'stderrRemainder';
  const queueKey = channel === 'stdout' ? 'stdoutQueue' : 'stderrQueue';
  let buffer = worker[remainderKey] + text;

  while (true) {
    const lfIndex = buffer.indexOf('\n');

    if (lfIndex === -1) {
      break;
    }

    const line = buffer.slice(0, lfIndex + 1);
    worker[queueKey].push(line);
    buffer = buffer.slice(lfIndex + 1);
  }

  worker[remainderKey] = buffer;
}

function drainQueue(queue: string[]): string[] {
  if (queue.length === 0) {
    return [];
  }

  return queue.splice(0, queue.length);
}

function getShellCommand(platform: ShellPlatform): ShellCommand {
  if (platform === 'windows') {
    return {
      command: 'powershell',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-NoExit',
        '-Command',
        '-',
      ],
      platform,
    };
  }

  return {
    command: 'bash',
    args: ['--noprofile', '--norc'],
    platform,
  };
}

async function createWorker(): Promise<ShellWorker> {
  const platform = getShellPlatform();
  const shellCommand = getShellCommand(platform);

  const worker = await new Promise<ShellWorker>((resolve, reject) => {
    const child = spawn(shellCommand.command, shellCommand.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: platform !== 'windows',
    });

    const onError = (error: Error) => {
      reject(error);
    };

    child.once('error', onError);

    setTimeout(() => {
      child.removeListener('error', onError);

      if (!child.stdin || !child.stdout || !child.stderr) {
        reject(new Error('shell worker 启动失败，stdin/stdout/stderr 不可用'));
        return;
      }

      const nextWorker: ShellWorker = {
        process: child,
        stdin: child.stdin,
        stdoutQueue: [],
        stderrQueue: [],
        stdoutRemainder: '',
        stderrRemainder: '',
        platform: shellCommand.platform,
      };

      child.stdout.on('data', (chunk) => {
        appendStreamChunks(nextWorker, 'stdout', chunk);
      });

      child.stderr.on('data', (chunk) => {
        appendStreamChunks(nextWorker, 'stderr', chunk);
      });

      resolve(nextWorker);
    }, 30);
  });

  if (platform === 'windows') {
    worker.stdin.write(
      [
        'chcp.com 65001 > $null',
        "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
        "$OutputEncoding = [System.Text.UTF8Encoding]::new()",
        "$ProgressPreference='SilentlyContinue'",
        '',
      ].join('\n'),
    );
  } else {
    worker.stdin.write(
      [
        'export LANG=C.UTF-8',
        'export LC_ALL=C.UTF-8',
        '',
      ].join('\n'),
    );
  }

  return worker;
}

function terminateWorker(): void {
  const currentWorker = shellWorker;
  shellWorker = null;

  if (!currentWorker) {
    return;
  }

  const { process: child } = currentWorker;

  try {
    currentWorker.stdin.end();
  } catch {
    // Ignore stdin close failures.
  }

  if (child.exitCode !== null || child.killed) {
    return;
  }

  if (currentWorker.platform === 'windows') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      try {
        child.kill();
      } catch {
        // Ignore kill failures.
      }
    }

    return;
  }

  const childPid = child.pid;

  if (typeof childPid !== 'number') {
    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore kill failures.
    }

    return;
  }

  try {
    process.kill(-childPid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore kill failures.
    }
  }
}

async function ensureWorker(): Promise<ShellWorker> {
  if (!shellWorker) {
    shellWorker = await createWorker();
    return shellWorker;
  }

  if (shellWorker.process.exitCode !== null || shellWorker.process.killed) {
    terminateWorker();
    shellWorker = await createWorker();
  }

  return shellWorker;
}

/**
 * M1 修复：useBuiltinPython=true 且内置解释器物理存在时，
 * 返回把内置 Python 目录前置到 $env:Path 的 PowerShell 注入行；
 * 其余情况（含任何异常）返回空串，run_exe 保持通用工具语义，
 * 不因 Python 环境未就绪而失败。注入仅影响 PowerShell worker 进程会话
 * （进程级环境变量、子进程继承、不触碰 Machine/User 范围）；
 * 幂等哨兵防止多次调用造成 PATH 重复膨胀。
 */
function buildBuiltinPythonPathLine(): string {
  try {
    if (!configManager.getSettings().useBuiltinPython) {
      return '';
    }

    const builtinDir = pythonManager.getPythonDir();

    if (!builtinDir || !existsSync(path.join(builtinDir, 'python.exe'))) {
      return '';
    }

    const escapedDir = builtinDir.replace(/'/g, "''");

    return `if (-not $__delepi_builtin_python_prepend_done) { $__delepi_builtin_python_prepend_done = $true; $env:Path = '${escapedDir};' + $env:Path }`;
  } catch {
    return '';
  }
}

function buildWindowsWrappedScript(
  script: string,
  workDir: string | null,
  token: string,
): string {
  const rcPrefix = `__AGENT_RC__:${token}:`;
  const endMarker = `__AGENT_END__:${token}`;
  const scriptBase64 = Buffer.from(script, 'utf8').toString('base64');
  const builtinPythonPathLine = buildBuiltinPythonPathLine();
  const commandEncodingLines = [
    'chcp.com 65001 > $null',
    "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "$env:PYTHONIOENCODING = 'utf-8'",
    "$env:PYTHONUTF8 = '1'",
    "$PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8'",
    "$PSDefaultParameterValues['Select-String:Encoding'] = 'utf8'",
    "$PSDefaultParameterValues['Import-Csv:Encoding'] = 'utf8'",
    "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'",
    "$PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'",
    "$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'",
    "$PSDefaultParameterValues['Export-Csv:Encoding'] = 'utf8'",
  ].join('\n');

  const setLocationCommand = workDir
    ? [
        `$__agent_work_dir_b64 = '${Buffer.from(workDir, 'utf8').toString('base64')}'`,
        '$__agent_work_dir = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($__agent_work_dir_b64))',
        'Set-Location -LiteralPath $__agent_work_dir',
      ].join('\n')
    : '';

  return [
    "$ErrorActionPreference = 'Continue'",
    '$global:LASTEXITCODE = 0',
    commandEncodingLines,
    builtinPythonPathLine,
    setLocationCommand,
    `$__agent_script_b64 = '${scriptBase64}'`,
    '$__agent_script = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($__agent_script_b64))',
    'Invoke-Expression $__agent_script',
    '$__ok = $?',
    '$__rc = if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { [int]$LASTEXITCODE } elseif (-not $__ok) { 1 } else { 0 }',
    `Write-Output "${rcPrefix}$__rc"`,
    `Write-Output "${endMarker}"`,
  ]
    .join('\n') + '\n';
}

function buildLinuxWrappedScript(
  script: string,
  workDir: string | null,
  token: string,
): string {
  const rcPrefix = `__AGENT_RC__:${token}:`;
  const endMarker = `__AGENT_END__:${token}`;
  const scriptDelimiter = `__AGENT_SCRIPT_${token}__`;
  const workDirDelimiter = `__AGENT_WORKDIR_${token}__`;
  const lines = [
    'set +e',
    // Set Python UTF-8 encoding if Python is detected
    detectPythonInvocation(script, 'linux') ? "export PYTHONIOENCODING=utf-8" : '',
  ];

  if (workDir) {
    lines.push(
      `__agent_work_dir=$(cat <<'${workDirDelimiter}'`,
      workDir,
      `${workDirDelimiter}`,
      ')',
      'cd -- "$__agent_work_dir"',
    );
  }

  lines.push(
    `__agent_script=$(cat <<'${scriptDelimiter}'`,
    script,
    `${scriptDelimiter}`,
    ')',
    'eval "$__agent_script"',
    '__rc=$?',
    `printf '%s\\n' "${rcPrefix}$__rc"`,
    `printf '%s\\n' "${endMarker}"`,
    '',
  );

  return lines.join('\n');
}

async function runScriptInWorker(
  script: string,
  workDir: string | null,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<WorkerRunResult> {
  return withWorkerLock(async () => {
    if (signal?.aborted) {
      throw new Error('ABORTED');
    }

    let worker = await ensureWorker();

    drainQueue(worker.stdoutQueue);
    drainQueue(worker.stderrQueue);

    const token = randomUUID().replace(/-/g, '');
    const rcPrefix = `__AGENT_RC__:${token}:`;
    const endMarker = `__AGENT_END__:${token}`;
    const wrappedScript = worker.platform === 'windows'
      ? buildWindowsWrappedScript(script, workDir, token)
      : buildLinuxWrappedScript(script, workDir, token);

    try {
      worker.stdin.write(wrappedScript);
    } catch {
      terminateWorker();
      worker = await ensureWorker();
      drainQueue(worker.stdoutQueue);
      drainQueue(worker.stderrQueue);
      worker.stdin.write(wrappedScript);
    }

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    let returncode: number | null = null;
    let endSeen = false;
    const deadline = Date.now() + timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        terminateWorker();
        throw new Error('ABORTED');
      }

      const drainedStdout = drainQueue(worker.stdoutQueue);

      for (const line of drainedStdout) {
        const stripped = line.trim();

        if (stripped === endMarker) {
          endSeen = true;
          continue;
        }

        if (stripped.startsWith(rcPrefix)) {
          const rcText = stripped.slice(rcPrefix.length).trim();
          const parsed = Number.parseInt(rcText, 10);
          returncode = Number.isFinite(parsed) ? parsed : 1;
          continue;
        }

        stdoutLines.push(line);
      }

      stderrLines.push(...drainQueue(worker.stderrQueue));

      if (endSeen) {
        break;
      }

      await sleep(20);
    }

    if (!endSeen) {
      terminateWorker();
      throw new Error('shell worker 执行超时');
    }

    stderrLines.push(...drainQueue(worker.stderrQueue));

    return {
      returncode: returncode ?? (stderrLines.length > 0 ? 1 : 0),
      stdout: stdoutLines.join(''),
      stderr: stderrLines.join(''),
    };
  });
}



async function launchSuspendedInWorker(
  script: string,
  workDir: string | null,
  signal?: AbortSignal,
): Promise<WorkerSuspendedResult> {
  // 挂起模式：写入 wrapped script 后立即返回，不等待 endMarker，不调用 terminateWorker。
  // wrapped script 内容与正常路径相同（含 __AGENT_RC__ 和 __AGENT_END__ 标记），
  // 但本次不消费这些标记；下一次普通 runScriptInWorker 调用会在写入新脚本前 drain queue 丢弃旧标记。
  return withWorkerLock(async () => {
    if (signal?.aborted) {
      throw new Error('ABORTED');
    }

    let worker = await ensureWorker();

    drainQueue(worker.stdoutQueue);
    drainQueue(worker.stderrQueue);

    const token = randomUUID().replace(/-/g, '');
    const wrappedScript = worker.platform === 'windows'
      ? buildWindowsWrappedScript(script, workDir, token)
      : buildLinuxWrappedScript(script, workDir, token);

    try {
      worker.stdin.write(wrappedScript);
    } catch {
      // 与 runScriptInWorker 保持一致：stdin 写入失败时重建 worker 后重试一次
      terminateWorker();
      worker = await ensureWorker();
      drainQueue(worker.stdoutQueue);
      drainQueue(worker.stderrQueue);
      worker.stdin.write(wrappedScript);
    }

    // 等待脚本启动一小段时间，捕获初始输出（如果有）
    const startupDelayMs = 200;
    const deadline = Date.now() + startupDelayMs;
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        terminateWorker();
        throw new Error('ABORTED');
      }

      const drainedStdout = drainQueue(worker.stdoutQueue);
      stdoutLines.push(...drainedStdout);
      stderrLines.push(...drainQueue(worker.stderrQueue));
      await sleep(20);
    }

    const childPid = worker.process.pid;

    if (typeof childPid !== 'number') {
      throw new Error('无法获取 shell worker 子进程 PID');
    }

    return {
      pid: childPid,
      platform: worker.platform,
      stdout: stdoutLines.join(''),
      stderr: stderrLines.join(''),
    };
  });
}
function buildTruncationMessage(
  stdoutTruncated: boolean,
  stderrTruncated: boolean,
): string {
  const channels = [
    stdoutTruncated ? 'stdout' : '',
    stderrTruncated ? 'stderr' : '',
  ];

  return channels.length
    ? `${channels.join('、')} 输出超过 ${MAX_OUTPUT_LENGTH} 字符，已截断。`
    : '';
}

async function resolveWorkDir(
  inputWorkDir: string | null,
  context: ToolRuntimeContext | undefined,
): Promise<string | null> {
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

export async function runExe(
  input: unknown,
  context: ToolRuntimeContext,
): Promise<ToolResult> {
  const resolvedInput =
    input && typeof input === 'object' ? (input as RunExeInput) : {};
  const responseId = randomUUID();
  const execId = normalizeOptionalString(resolvedInput.exec_id) || randomUUID();
  const cmdLines = resolvedInput.cmd_lines;

  if (!Array.isArray(cmdLines) || cmdLines.length === 0) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'cmd_lines 不能为空',
    });
  }

  if (!cmdLines.every((item) => typeof item === 'string')) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'cmd_lines 必须全部是字符串',
    });
  }

  const platform = getShellPlatform();
  const script = cmdLines.join(platform === 'windows' ? '\r\n' : '\n');
  const requestedWorkDir =
    normalizeOptionalString(resolvedInput.run_dir) ||
    normalizeOptionalString(resolvedInput.work_dir) ||
    null;

  ioPrint('Cmd:', script, '\n');

  if (script.length > MAX_COMMAND_LENGTH) {
    return buildToolResult({
      success: false,
      code: ERR_COMMAND_TOO_LONG,
      message: `命令行超过 ${MAX_COMMAND_LENGTH} 字符`,
    });
  }

  const suspend = normalizeOptionalBoolean(resolvedInput.suspend);
  const hangRisk = suspend ? null : detectHangRisk(script, platform);

  if (hangRisk) {
    return buildToolResult({
      success: false,
      code: ERR_COMMAND_REJECTED,
      message: `命令被拒绝，存在挂起或常驻风险：${hangRisk}`,
    });
  }

  // local模式：保留install命令安全检查
  {

    const packageInstallSyntaxRisk = detectPackageInstallSyntaxRisk(script);

    if (packageInstallSyntaxRisk) {
      return buildToolResult({
        success: false,
        code: ERR_COMMAND_REJECTED,
        message: packageInstallSyntaxRisk,
      });
    }
  }

  let workDir: string | null;

  try {
    workDir = await resolveWorkDir(requestedWorkDir, context);
  } catch (error) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_WORK_DIR,
      message: `run_dir 非法：${error instanceof Error ? error.message : String(error)}`,
    });
  }



  // 挂起模式：写入 wrapped script 后立即返回，不等待 endMarker、不调用 terminateWorker
  if (suspend) {
    try {
      const suspended = await launchSuspendedInWorker(script, workDir, context.signal);
      const stdout = truncateOutput(suspended.stdout, 'stdout');
      const stderr = truncateOutput(suspended.stderr, 'stderr');
      const truncationMessage = buildTruncationMessage(
        stdout.truncated,
        stderr.truncated,
      );
      const suspendMessage = `\n当前进程(PID: ${suspended.pid})已挂起，当前任务结束前请务必清理，当前平台: ${suspended.platform}`;
      const finalMessage = truncationMessage
        ? `${suspendMessage}\n${truncationMessage}`
        : suspendMessage;

      return buildToolResult({
        success: true,
        code: ERR_OK,
        message: finalMessage,
        data: {
          ...buildExecutedToolResultData({
            returncode: 0,
            stdout: stdout.text,
            stderr: stderr.text,
            execId,
            responseId,
          }),
          pid: suspended.pid,
          platform: suspended.platform,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message === 'ABORTED') {
        return buildToolResult({
          success: false,
          code: 'ABORTED',
          message: '挂起命令执行已取消',
          data: {
            ...buildExecutedToolResultData({
              returncode: 130,
              stdout: '',
              stderr: 'ABORTED',
              execId,
              responseId,
            }),
          },
        });
      }

      return buildToolResult({
        success: false,
        code: ERR_EXECUTION_ERROR,
        message: `挂起命令执行异常：${message}`,
      });
    }
  }

  try {
    const result = await runScriptInWorker(
      script,
      workDir,
      DEFAULT_TIMEOUT_SECONDS,
      context.signal,
    );
    const stdout = truncateOutput(result.stdout, 'stdout');
    const stderr = truncateOutput(result.stderr, 'stderr');
    const success = result.returncode === 0;
    const truncationMessage = buildTruncationMessage(
      stdout.truncated,
      stderr.truncated,
    );
    const resultMessage = success
      ? '命令执行完成'
      : `命令执行失败，退出码 ${result.returncode}`;

    ioPrint('Output:\n', stdout.text, '\n');
    ioPrint('Error:\n', stderr.text, '\n');

    return buildToolResult({
      success,
      code: success ? ERR_OK : ERR_COMMAND_EXITED_NON_ZERO,
      message: truncationMessage
        ? `${resultMessage}\n${truncationMessage}`
        : resultMessage,
      data: buildExecutedToolResultData({
        returncode: result.returncode,
        stdout: stdout.text,
        stderr: stderr.text,
        execId,
        responseId,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message === 'ABORTED') {
      return buildToolResult({
        success: false,
        code: 'ABORTED',
        message: '命令执行已取消',
        data: buildExecutedToolResultData({
          returncode: 130,
          stdout: '',
          stderr: 'ABORTED',
          execId,
          responseId,
        }),
      });
    }

    if (message.includes('执行超时')) {
      return buildToolResult({
        success: false,
        code: ERR_TIMEOUT,
        message: '命令执行超时',
        data: buildExecutedToolResultData({
          returncode: 124,
          stdout: '',
          stderr: '执行超时。[TIMEOUT] 请检查命令行，当前不支持挂起或常驻命令。',
          execId,
          responseId,
        }),
      });
    }

    return buildToolResult({
      success: false,
      code: ERR_EXECUTION_ERROR,
      message: `命令执行异常：${message}`,
    });
  }
}
