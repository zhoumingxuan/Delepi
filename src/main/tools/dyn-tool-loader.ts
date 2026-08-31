/**
 * 动态工具加载器（方向5 S5-3：工具动态注册机制——新增工具免改代码）
 *
 * 载体：app.getPath('userData')/dyn-tools/<tool_name>/{manifest.json, main.py}
 * 执行协议：临时文件 input.json 传参（规避命令行长度与转义；executor-registry.parseToolArguments
 *   会剥离参数中 context 保留字，故 manifest.parameters 显式拒绝 context 键）
 *   → spawn python main.py <input.json路径>（cwd=工具目录，PYTHONUTF8=1）
 *   → stdout 末行非空 JSON 解析映射 ToolResult{success,code,message,data?}
 * 超时：默认 DEFAULT_TIMEOUT_SECONDS=180 秒，manifest.timeoutSeconds 可覆盖（上限 3600）。
 * 加载：启动扫描（ipc-handlers.registerIpcHandlers 开头 fire-and-forget，失败告警不阻塞）
 *   + tools:dyn-reload IPC 手动重载（S5-4 四层通道）。
 * 内置4工具锁定：动态重名内置由 executor-registry.registerExecutorTool 拒绝。
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

import type { ToolResult } from './result';
import type { ToolRuntimeContext } from './runtime-context';
import { configManager } from '../modules/config/config-manager';
import { pythonManager } from '../modules/python';
import {
  registerExecutorTool,
  unregisterExecutorTool,
  getDynamicExecutorToolNames,
} from './executor-registry';
import { DEFAULT_TIMEOUT_SECONDS } from '../constants';

// ============================================================
// manifest 类型与校验
// ============================================================

export interface DynToolManifest {
  /** 工具名：仅字母/数字/下划线/中划线，必须与所在目录名一致 */
  name: string;
  /** 展示名（进度名三级回退第二级） */
  displayName: string;
  /**
   * 动态工具描述：直接取 manifest.description 字符串（A5-3：内置工具保留求值后字符串，
   * 两形态在合并视图统一为字符串）。
   * P-5（保守方案）：子智能体系统提示词中按工具名硬编码的约束条款保持不泛化，
   * 动态工具的行为约束通过 manifest.description 自身承担。【待用户定稿：P-5泛化决策】
   */
  description: string;
  /** JSON Schema（与内置 parameters 同构：type='object'+properties）；properties 含 context 键被拒绝 */
  parameters: Record<string, unknown>;
  /** 进度名三级回退第一级：manifest.progressName → displayName → name */
  progressName?: string;
  /** 首期禁视觉：requiresVision=true 校验拒绝（视觉工具需图片内容组装，超动态参数模型表达范围） */
  requiresVision?: boolean;
  /** 执行超时秒数；缺省 DEFAULT_TIMEOUT_SECONDS=180 */
  timeoutSeconds?: number;
}

export type DynToolManifestCheck =
  | { ok: true; manifest: DynToolManifest }
  | { ok: false; error: string };

const DYN_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
/** manifest.timeoutSeconds 上限（防误配超长挂起） */
const DYN_TOOL_TIMEOUT_MAX_SECONDS = 3600;

export function validateDynToolManifest(raw: unknown, dirName: string): DynToolManifestCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `manifest 必须是 JSON 对象（目录 ${dirName}）` };
  }
  const manifest = raw as Record<string, unknown>;

  const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
  if (!name || !DYN_TOOL_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error: `manifest.name 非法（仅允许字母/数字/下划线/中划线）:${JSON.stringify(manifest.name)}`,
    };
  }
  if (name !== dirName) {
    return { ok: false, error: `manifest.name(${name}) 与目录名(${dirName}) 不一致（载体约定 userData/dyn-tools/<tool_name>/）` };
  }

  const displayName = typeof manifest.displayName === 'string' ? manifest.displayName.trim() : '';
  if (!displayName) {
    return { ok: false, error: 'manifest.displayName 必须为非空字符串（进度名回退链终点保证）' };
  }

  const description = typeof manifest.description === 'string' ? manifest.description.trim() : '';
  if (!description) {
    return { ok: false, error: 'manifest.description 必须为非空字符串（动态工具描述与行为约束的唯一直接来源）' };
  }

  const parameters = manifest.parameters;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return { ok: false, error: 'manifest.parameters 必须为 JSON Schema 对象' };
  }
  const params = parameters as Record<string, unknown>;
  if (params.type !== 'object') {
    return { ok: false, error: 'manifest.parameters.type 必须为 "object"（与内置工具声明同构）' };
  }
  if (!params.properties || typeof params.properties !== 'object' || Array.isArray(params.properties)) {
    return { ok: false, error: 'manifest.parameters.properties 必须为对象' };
  }
  if (Object.prototype.hasOwnProperty.call(params.properties, 'context')) {
    return {
      ok: false,
      error: 'manifest.parameters.properties 不允许包含保留字 context（executeToolCall 参数解析会剥离该键）',
    };
  }

  let progressName: string | undefined;
  if (manifest.progressName !== undefined) {
    if (typeof manifest.progressName !== 'string' || !manifest.progressName.trim()) {
      return { ok: false, error: 'manifest.progressName 可选，但传入时必须为非空字符串' };
    }
    progressName = manifest.progressName.trim();
  }

  if (manifest.requiresVision === true) {
    return { ok: false, error: '首期不支持视觉类动态工具（requiresVision=true 拒绝注册）' };
  }
  if (manifest.requiresVision !== undefined && typeof manifest.requiresVision !== 'boolean') {
    return { ok: false, error: 'manifest.requiresVision 必须为 boolean' };
  }

  let timeoutSeconds: number | undefined;
  if (manifest.timeoutSeconds !== undefined) {
    if (
      typeof manifest.timeoutSeconds !== 'number' ||
      !Number.isFinite(manifest.timeoutSeconds) ||
      manifest.timeoutSeconds <= 0 ||
      manifest.timeoutSeconds > DYN_TOOL_TIMEOUT_MAX_SECONDS
    ) {
      return {
        ok: false,
        error: `manifest.timeoutSeconds 必须为 (0, ${DYN_TOOL_TIMEOUT_MAX_SECONDS}] 内的数字`,
      };
    }
    timeoutSeconds = Math.floor(manifest.timeoutSeconds);
  }

  return {
    ok: true,
    manifest: {
      name,
      displayName,
      description,
      parameters: params,
      progressName,
      requiresVision: false,
      timeoutSeconds,
    },
  };
}

// ============================================================
// 目录扫描
// ============================================================

export function getDynToolsRootDir(): string {
  return path.join(app.getPath('userData'), 'dyn-tools');
}

export type DynToolScanEntry =
  | {
      dirName: string;
      ok: true;
      manifest: DynToolManifest;
      toolDir: string;
      mainPyPath: string;
    }
  | { dirName: string; ok: false; error: string };

export async function scanDynToolsDir(): Promise<DynToolScanEntry[]> {
  const root = getDynToolsRootDir();
  if (!existsSync(root)) {
    return [];
  }
  const dirents = await readdir(root, { withFileTypes: true });
  const results: DynToolScanEntry[] = [];

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const toolDir = path.join(root, dirent.name);
    const manifestPath = path.join(toolDir, 'manifest.json');
    const mainPyPath = path.join(toolDir, 'main.py');

    if (!existsSync(manifestPath)) {
      results.push({ dirName: dirent.name, ok: false, error: '缺少 manifest.json' });
      continue;
    }
    if (!existsSync(mainPyPath)) {
      results.push({ dirName: dirent.name, ok: false, error: '缺少 main.py' });
      continue;
    }

    try {
      const raw = JSON.parse(await readFile(manifestPath, 'utf-8'));
      const check = validateDynToolManifest(raw, dirent.name);
      if (!check.ok) {
        results.push({ dirName: dirent.name, ok: false, error: check.error });
        continue;
      }
      results.push({
        dirName: dirent.name,
        ok: true,
        manifest: check.manifest,
        toolDir,
        mainPyPath,
      });
    } catch (error) {
      results.push({
        dirName: dirent.name,
        ok: false,
        error: `manifest.json 解析失败：${(error as Error).message}`,
      });
    }
  }

  return results;
}

// ============================================================
// 执行内核（一次性进程模式：只读参照 run-with-python.ts runSpawnCommand，不 import 不依赖）
// ============================================================

type PythonCommand = {
  command: string;
  prefixArgs: string[];
};

/**
 * 解释器选择：与 run-with-python.getPythonCommand 同序（内置 > 自定义 > 系统 python/python3）。
 * 差异：useBuiltinPython=true 但内置路径为空时回退自定义/系统 Python 而非报错——
 * 动态工具不应因内置 Python 状态未就绪而整体不可用（run_with_python 作为核心工具保持严格语义）。
 */
function resolveDynPythonCommand(): PythonCommand {
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

function buildDynToolUtf8Env(): NodeJS.ProcessEnv {
  // Node.js child_process spread required: 子进程需要继承 PATH 等环境变量定位解释器
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
}

export type DynToolExecOptions = {
  mainPyPath: string;
  toolDir: string;
  input: unknown;
  timeoutSeconds: number;
  signal?: AbortSignal;
};

/** 提取 stdout 中最后一个非空行（约定：main.py 末行输出结果 JSON） */
function extractLastNonEmptyLine(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line) {
      return line;
    }
  }
  return '';
}

export async function executeDynToolScript(options: DynToolExecOptions): Promise<ToolResult> {
  const inputPath = path.join(os.tmpdir(), `dyn-tool-input-${randomUUID()}.json`);
  await writeFile(inputPath, JSON.stringify(options.input ?? {}), 'utf-8');

  const cleanupInput = async () => {
    try {
      await rm(inputPath, { force: true });
    } catch {
      // 临时文件清理失败不影响结果返回
    }
  };

  const python = resolveDynPythonCommand();

  return new Promise<ToolResult>((resolve) => {
    if (options.signal?.aborted) {
      void cleanupInput();
      resolve({ success: false, code: 'DYN_TOOL_ABORTED', message: '动态工具执行已被中止（进入前已中止）' });
      return;
    }

    const child = spawn(
      python.command,
      [...python.prefixArgs, options.mainPyPath, inputPath],
      {
        cwd: options.toolDir,
        env: buildDynToolUtf8Env(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutSeconds * 1000);

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

    if (options.signal) {
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
    };

    const finish = (result: ToolResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      void cleanupInput();
      resolve(result);
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.once('error', (error) => {
      finish({
        success: false,
        code: 'DYN_TOOL_SPAWN_ERROR',
        message: `动态工具进程启动失败：${(error as Error).message}（请检查 Python 环境与 main.py）`,
      });
    });

    child.once('close', (code) => {
      if (aborted) {
        finish({ success: false, code: 'DYN_TOOL_ABORTED', message: '动态工具执行已被中止' });
        return;
      }
      if (timedOut) {
        finish({
          success: false,
          code: 'DYN_TOOL_TIMEOUT',
          message: `动态工具执行超时（${options.timeoutSeconds} 秒）已被终止`,
        });
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');

      if (code !== 0) {
        finish({
          success: false,
          code: 'DYN_TOOL_EXITED_NON_ZERO',
          message: `动态工具进程非零退出（code=${code ?? 'null'}）：${stderr.trim().slice(-512) || stdout.trim().slice(-512)}`,
        });
        return;
      }

      const lastLine = extractLastNonEmptyLine(stdout);
      if (!lastLine) {
        finish({
          success: false,
          code: 'DYN_TOOL_OUTPUT_EMPTY',
          message: '动态工具 stdout 为空：main.py 须在 stdout 末行输出结果 JSON',
        });
        return;
      }

      try {
        const parsed = JSON.parse(lastLine) as Record<string, unknown>;
        const success = parsed.success === true;
        finish({
          success,
          code: typeof parsed.code === 'string' && parsed.code
            ? parsed.code
            : (success ? 'DYN_TOOL_OK' : 'DYN_TOOL_FAILED'),
          message: typeof parsed.message === 'string'
            ? parsed.message
            : (success ? '' : '动态工具返回 success=false 且未提供 message'),
          data:
            parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
              ? (parsed.data as Record<string, unknown>)
              : undefined,
        });
      } catch (error) {
        finish({
          success: false,
          code: 'DYN_TOOL_OUTPUT_INVALID',
          message: `动态工具 stdout 末行不是合法 JSON：${(error as Error).message}；末行内容：${lastLine.slice(0, 256)}`,
        });
      }
    });
  });
}

// ============================================================
// 注册编排（扫描 → 校验 → registerExecutorTool）
// ============================================================

type DynToolRegistrationRecord = {
  manifest: DynToolManifest;
  toolDir: string;
  mainPyPath: string;
};

/** 已注册动态工具记录（listDynamicTools 数据源；随注册/注销同步维护） */
const registeredRecords = new Map<string, DynToolRegistrationRecord>();

function buildDynToolRegistrationItem(
  manifest: DynToolManifest,
  toolDir: string,
  mainPyPath: string,
): {
  config: { name: string; displayName: string; buildDescription: string };
  parameters: Record<string, unknown>;
  progressName?: string;
  execute: (input: unknown, context: Partial<ToolRuntimeContext>) => Promise<ToolResult>;
} {
  return {
    config: {
      name: manifest.name,
      displayName: manifest.displayName,
      buildDescription: manifest.description,
    },
    parameters: manifest.parameters,
    progressName: manifest.progressName,
    execute: (input, context) =>
      executeDynToolScript({
        mainPyPath,
        toolDir,
        input,
        timeoutSeconds: manifest.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
        signal: context?.signal,
      }),
  };
}

export type DynToolsLoadResult = {
  registered: string[];
  failed: Array<{ name: string; error: string }>;
  warnings: string[];
};

/** 扫描并注册全部动态工具；单个失败仅告警不阻塞（A5-2 启动扫描语义） */
export async function loadDynamicTools(): Promise<DynToolsLoadResult> {
  const result: DynToolsLoadResult = { registered: [], failed: [], warnings: [] };

  let entries: DynToolScanEntry[];
  try {
    entries = await scanDynToolsDir();
  } catch (error) {
    const message = `dyn-tools 目录扫描失败：${(error as Error).message}`;
    result.warnings.push(message);
    console.warn(`[dyn-tool-loader] ${message}`);
    return result;
  }

  for (const entry of entries) {
    if (!entry.ok) {
      result.failed.push({ name: entry.dirName, error: entry.error });
      console.warn(`[dyn-tool-loader] 目录 ${entry.dirName} 跳过注册：${entry.error}`);
      continue;
    }

    const registration = registerExecutorTool(
      buildDynToolRegistrationItem(entry.manifest, entry.toolDir, entry.mainPyPath),
    );
    if (!registration.success) {
      result.failed.push({ name: entry.dirName, error: registration.error ?? '未知原因' });
      console.warn(`[dyn-tool-loader] 目录 ${entry.dirName} 注册失败：${registration.error}`);
      continue;
    }

    registeredRecords.set(entry.manifest.name, {
      manifest: entry.manifest,
      toolDir: entry.toolDir,
      mainPyPath: entry.mainPyPath,
    });
    result.registered.push(entry.manifest.name);
  }

  if (result.registered.length > 0) {
    console.info(`[dyn-tool-loader] 动态工具注册完成：${result.registered.join(', ')}`);
  }
  if (result.failed.length > 0) {
    console.warn(`[dyn-tool-loader] ${result.failed.length} 个动态工具目录注册失败（不阻塞启动）`);
  }

  return result;
}

/** 手动重载（tools:dyn-reload IPC）：先注销全部已注册动态工具，再重新扫描注册（幂等） */
export async function reloadDynamicTools(): Promise<DynToolsLoadResult> {
  for (const name of getDynamicExecutorToolNames()) {
    unregisterExecutorTool(name);
  }
  registeredRecords.clear();
  return loadDynamicTools();
}

export type DynToolInfo = {
  name: string;
  displayName: string;
  description: string;
  progressName?: string;
  timeoutSeconds: number;
};

/** 列出当前已注册动态工具（tools:dyn-list IPC 数据源） */
export function listDynamicTools(): DynToolInfo[] {
  return [...registeredRecords.values()].map((record) => ({
    name: record.manifest.name,
    displayName: record.manifest.displayName,
    description: record.manifest.description,
    progressName: record.manifest.progressName,
    timeoutSeconds: record.manifest.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
  }));
}
