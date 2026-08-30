/**
 * 经验库（script-tools）协议层
 *
 * 职责：protocol.yaml 类型定义（MCP Tool 对象 + 本地扩展字段，v2.0 R3）、YAML 读取解析（js-yaml）、协议校验器（4.2/4.3 全规则）、
 * 目录扫描（合法集合 + 超限自动剔除治理，R2；3.5 查重含 name==目录名一致性）。
 *
 * 遵循 dyn-tool-loader.ts L228-230 “只读参照，不 import 不依赖”哲学（D6）：
 * 本文件独立实现扫描/解析/校验逻辑，不 import dyn-tool-loader 任何内容。
 */

import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

import {
  MAX_SCRIPT_TOOLS,
  SCRIPT_TOOL_ENTRY_FILE_NAME,
  SCRIPT_TOOL_PROTOCOL_FILE_NAME,
} from '../constants';
import { SCRIPTS_TOOLS_DIR } from '../constants/agent';

// ============================================================
// 错误码（19 项错误码表；执行侧超时/中止/输出类错误码由 script-tool.ts 使用）
// ============================================================

export const SCRIPT_TOOL_CODES = {
  DIR_MISSING: 'SCRIPT_TOOL_DIR_MISSING',
  DIR_LIMIT: 'SCRIPT_TOOL_DIR_LIMIT',
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  PROTOCOL_MISSING: 'PROTOCOL_MISSING',
  ENTRY_MISSING: 'ENTRY_MISSING',
  PROTOCOL_INVALID: 'PROTOCOL_INVALID',
  PROTOCOL_CONTEXT_RESERVED: 'PROTOCOL_CONTEXT_RESERVED',
  SLUG_CONFLICT: 'SLUG_CONFLICT',
  DIR_NAME_DUPLICATED: 'DIR_NAME_DUPLICATED',
  PARAMS_INVALID: 'PARAMS_INVALID',
  INPUT_WRITE_ERROR: 'INPUT_WRITE_ERROR',
  SPAWN_ERROR: 'SCRIPT_TOOL_SPAWN_ERROR',
  TIMEOUT: 'SCRIPT_TOOL_TIMEOUT',
  EXITED_NON_ZERO: 'SCRIPT_TOOL_EXITED_NON_ZERO',
  ABORTED: 'SCRIPT_TOOL_ABORTED',
  OUTPUT_EMPTY: 'SCRIPT_TOOL_OUTPUT_EMPTY',
  OUTPUT_INVALID: 'SCRIPT_TOOL_OUTPUT_INVALID',
  OK: 'SCRIPT_TOOL_OK',
  FAILED: 'SCRIPT_TOOL_FAILED',
  DIR_NOT_WRITABLE: 'SCRIPT_TOOL_DIR_NOT_WRITABLE',
} as const;

// ============================================================
// 协议类型定义（4.2 字段表）
// ============================================================

export interface ScriptToolProtocol {
  /** MCP 兼容工具名（=所在工具目录名；定位键=目录名，v2.0 R3/D2） */
  name: string;
  /** 中文展示名（title；仅汉字 1-6 字，纯展示字段，不要求等于目录名） */
  title: string;
  /** 一句话能力说明（单行，≤200 字符） */
  description: string;
  /** 目标工具入参 JSON Schema（MCP inputSchema；顶层 type='object'；properties 顶层禁 context） */
  inputSchema: Record<string, unknown>;
  /** 单次调用超时秒数（协议缺省 180，校验时归一化） */
  timeoutSeconds: number;
  /** 调用期间进度文案中的工具名（缺省用 title） */
  progressName?: string;
  /** 适用条件（可选；传入时非空、单行、≤100 字符；能力边界完全解耦声明，R6/D5） */
  applicableConditions?: string;
  /** 声明性依赖（仅展示不安装；应已存在于内置 Python 预置依赖或系统环境） */
  pythonDeps?: string[];
}

export type ScriptToolProtocolCheck =
  | { ok: true; protocol: ScriptToolProtocol }
  | { ok: false; code: string; error: string };

/** MCP 兼容工具名规范：1-64 位字母/数字/下划线/中划线（生态通行约定，见方案 D2 证据边界） */
const MCP_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
/** 中文展示名规范（title）：仅汉字，1~6 字 */
const CHINESE_TITLE_PATTERN = /^[\u4e00-\u9fff]{1,6}$/;

/** timeout_seconds 上限（对齐 dyn-tool-loader DYN_TOOL_TIMEOUT_MAX_SECONDS 语义） */
export const SCRIPT_TOOL_TIMEOUT_MAX_SECONDS = 3600;

/** timeout_seconds 缺省值 */
export const SCRIPT_TOOL_TIMEOUT_DEFAULT_SECONDS = 180;

/** description 最大长度 */
const SCRIPT_TOOL_DESCRIPTION_MAX_LENGTH = 200;

/** progress_name 最大长度 */
const SCRIPT_TOOL_PROGRESS_NAME_MAX_LENGTH = 12;

/** applicable_conditions 最大长度（R6/D5：适用条件单行 ≤100 字符） */
const SCRIPT_TOOL_APPLICABILITY_MAX_LENGTH = 100;

/** 严格模式：允许的协议字段全集（未知字段一律 PROTOCOL_INVALID，杜绝 timeout_sec 类手误） */
const SCRIPT_TOOL_ALLOWED_FIELDS = new Set([
  'name',
  'title',
  'description',
  'inputSchema',
  'timeout_seconds',
  'progress_name',
  'applicable_conditions',
  'python_deps',
]);

// ============================================================
// 协议校验器（4.3 全规则 + 3.5 查重）
// ============================================================

export function validateScriptToolProtocol(raw: unknown, dirName: string): ScriptToolProtocolCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
      error: `protocol.yaml 必须是 YAML 映射对象（目录 ${dirName}）`,
    };
  }
  const doc = raw as Record<string, unknown>;

  // 严格模式：未知字段拒绝
  const unknownFields = Object.keys(doc).filter((key) => !SCRIPT_TOOL_ALLOWED_FIELDS.has(key));
  if (unknownFields.length > 0) {
    return {
      ok: false,
      code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
      error: `protocol.yaml 含未知字段：${unknownFields.join(', ')}（合法字段：${[...SCRIPT_TOOL_ALLOWED_FIELDS].join('/')}）`,
    };
  }

  // name：MCP 兼容名（1-64 位字母/数字/下划线/中划线）；必须等于所在目录名（不一致/非法 → SLUG_CONFLICT，语义保留）
  const name = typeof doc.name === 'string' ? doc.name.trim() : '';
  if (!MCP_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      code: SCRIPT_TOOL_CODES.SLUG_CONFLICT,
      error: `protocol.yaml name 必须为 1-64 位字母/数字/下划线/中划线（MCP 兼容名）：${JSON.stringify(doc.name)}`,
    };
  }
  if (name !== dirName) {
    return {
      ok: false,
      code: SCRIPT_TOOL_CODES.SLUG_CONFLICT,
      error: `name(${name}) 与所在目录名(${dirName}) 不一致（定位键=目录名，name 为同值自校验标识）`,
    };
  }

  // title：中文展示名（仅汉字 1-6 字；纯展示字段，不要求等于目录名）
  const title = typeof doc.title === 'string' ? doc.title.trim() : '';
  if (!CHINESE_TITLE_PATTERN.test(title)) {
    return {
      ok: false,
      code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
      error: `protocol.yaml title 必须为 1-6 个汉字：${JSON.stringify(doc.title)}`,
    };
  }

  // description：非空、单行、≤200 字符
  const description = typeof doc.description === 'string' ? doc.description.trim() : '';
  if (!description) {
    return {
      ok: false,
      code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
      error: 'protocol.yaml description 必须为非空字符串（一句话能力说明）',
    };
  }
  if (/[\r\n]/.test(description)) {
    return {
      ok: false,
      code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
      error: 'protocol.yaml description 必须为单行（禁止换行）',
    };
  }
  if (description.length > SCRIPT_TOOL_DESCRIPTION_MAX_LENGTH) {
    return {
      ok: false,
      code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
      error: `protocol.yaml description 超过 ${SCRIPT_TOOL_DESCRIPTION_MAX_LENGTH} 字符（当前 ${description.length}）`,
    };
  }

  // inputSchema：MCP inputSchema（JSON Schema 对象）；顶层 type='object'；properties 顶层禁保留字 context
  const inputSchema = doc.inputSchema;
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return {
      ok: false,
      code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
      error: 'protocol.yaml inputSchema 必须为 JSON Schema 对象',
    };
  }
  const params = inputSchema as Record<string, unknown>;
  if (params.type !== 'object') {
    return {
      ok: false,
      code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
      error: 'protocol.yaml inputSchema.type 必须为 "object"',
    };
  }
  const properties = params.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return {
      ok: false,
      code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
      error: 'protocol.yaml inputSchema.properties 必须为对象',
    };
  }
  if (Object.prototype.hasOwnProperty.call(properties, 'context')) {
    return {
      ok: false,
      code: SCRIPT_TOOL_CODES.PROTOCOL_CONTEXT_RESERVED,
      error: 'protocol.yaml inputSchema.properties 顶层不允许包含保留字 context（executor-registry.parseToolArguments 会剥离参数顶层 context，executor-registry.ts L140）',
    };
  }

  // timeout_seconds：可选，(0, 3600] 内数字；缺省 180
  let timeoutSeconds = SCRIPT_TOOL_TIMEOUT_DEFAULT_SECONDS;
  if (doc.timeout_seconds !== undefined) {
    if (
      typeof doc.timeout_seconds !== 'number' ||
      !Number.isFinite(doc.timeout_seconds) ||
      doc.timeout_seconds <= 0 ||
      doc.timeout_seconds > SCRIPT_TOOL_TIMEOUT_MAX_SECONDS
    ) {
      return {
        ok: false,
        code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
        error: `protocol.yaml timeout_seconds 必须为 (0, ${SCRIPT_TOOL_TIMEOUT_MAX_SECONDS}] 内的数字`,
      };
    }
    timeoutSeconds = Math.floor(doc.timeout_seconds);
  }

  // progress_name：可选，非空字符串，≤12 字
  let progressName: string | undefined;
  if (doc.progress_name !== undefined) {
    if (typeof doc.progress_name !== 'string' || !doc.progress_name.trim()) {
      return {
        ok: false,
        code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
        error: 'protocol.yaml progress_name 可选，但传入时必须为非空字符串',
      };
    }
    const trimmedProgressName = doc.progress_name.trim();
    if (trimmedProgressName.length > SCRIPT_TOOL_PROGRESS_NAME_MAX_LENGTH) {
      return {
        ok: false,
        code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
        error: `protocol.yaml progress_name 超过 ${SCRIPT_TOOL_PROGRESS_NAME_MAX_LENGTH} 字（当前 ${trimmedProgressName.length}）`,
      };
    }
    progressName = trimmedProgressName;
  }

  // applicable_conditions：可选；传入时非空、单行、≤100 字符（适用条件与工具能力边界一一对应，R6/D5）
  let applicableConditions: string | undefined;
  if (doc.applicable_conditions !== undefined) {
    if (typeof doc.applicable_conditions !== 'string' || !doc.applicable_conditions.trim()) {
      return {
        ok: false,
        code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
        error: 'protocol.yaml applicable_conditions 可选，但传入时必须为非空字符串',
      };
    }
    const trimmedCond = doc.applicable_conditions.trim();
    if (/[\r\n]/.test(trimmedCond)) {
      return {
        ok: false,
        code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
        error: 'protocol.yaml applicable_conditions 必须为单行（禁止换行）',
      };
    }
    if (trimmedCond.length > SCRIPT_TOOL_APPLICABILITY_MAX_LENGTH) {
      return {
        ok: false,
        code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
        error: `protocol.yaml applicable_conditions 超过 ${SCRIPT_TOOL_APPLICABILITY_MAX_LENGTH} 字符（当前 ${trimmedCond.length}）`,
      };
    }
    applicableConditions = trimmedCond;
  }

  // python_deps：可选，元素为非空字符串（pip 包名形态；仅声明不安装）
  let pythonDeps: string[] | undefined;
  if (doc.python_deps !== undefined) {
    if (!Array.isArray(doc.python_deps)) {
      return {
        ok: false,
        code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
        error: 'protocol.yaml python_deps 必须为字符串数组',
      };
    }
    const deps: string[] = [];
    for (const dep of doc.python_deps) {
      if (typeof dep !== 'string' || !dep.trim()) {
        return {
          ok: false,
          code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
          error: `protocol.yaml python_deps 元素必须为非空字符串：${JSON.stringify(dep)}`,
        };
      }
      deps.push(dep.trim());
    }
    pythonDeps = deps;
  }

  return {
    ok: true,
    protocol: {
      name,
      title,
      description,
      inputSchema: params,
      timeoutSeconds,
      progressName,
      applicableConditions,
      pythonDeps,
    },
  };
}

/** 读取并解析协议文本（YAML 损坏 → PROTOCOL_INVALID，message 附解析错误） */
export function parseScriptToolProtocolText(text: string, dirName: string): ScriptToolProtocolCheck {
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (error) {
    return {
      ok: false,
      code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
      error: `protocol.yaml 解析失败：${(error as Error).message}`,
    };
  }
  return validateScriptToolProtocol(raw, dirName);
}

// ============================================================
// 目录扫描（合法集合 + 逐目录错误；坏目录不阻断其他工具）
// ============================================================

export type ScriptToolScanEntry =
  | {
      dirName: string;
      ok: true;
      protocol: ScriptToolProtocol;
      toolDir: string;
      protocolPath: string;
      mainPyPath: string;
    }
  | { dirName: string; ok: false; code: string; error: string };

/**
 * R2 容量治理（唯一收口点）：合法工具数超过 MAX_SCRIPT_TOOLS 时，按创建时间最旧优先剔除。
 * 确定性：birthtimeMs 升序（不可得按 0=视作最旧优先治理），同值按目录名字典序；
 * 物理删除尽力而为（rm force 幂等，失败仅告警），逻辑排除保底——返回集合恒 ≤ 上限。
 */
async function evictOldestScriptTools(
  okEntries: Array<Extract<ScriptToolScanEntry, { ok: true }>>,
): Promise<Set<string>> {
  const excess = okEntries.length - MAX_SCRIPT_TOOLS;
  if (excess <= 0) {
    return new Set();
  }
  const timed = await Promise.all(
    okEntries.map(async (entry) => {
      try {
        const st = await stat(entry.toolDir);
        return { dirName: entry.dirName, toolDir: entry.toolDir, t: st.birthtimeMs || st.mtimeMs || 0 };
      } catch {
        return { dirName: entry.dirName, toolDir: entry.toolDir, t: 0 };
      }
    }),
  );
  timed.sort((a, b) => a.t - b.t || a.dirName.localeCompare(b.dirName));
  const oldest = timed.slice(0, excess);
  for (const item of oldest) {
    try {
      await rm(item.toolDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[script-tools] 自动剔除失败（已逻辑排除）：${item.dirName}`, error);
    }
  }
  return new Set(oldest.map((item) => item.dirName));
}

export async function scanScriptToolsDir(): Promise<ScriptToolScanEntry[]> {
  const root = SCRIPTS_TOOLS_DIR;
  if (!existsSync(root)) {
    return [];
  }

  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch {
    // 目录不可读（如权限问题）：视作空库返回，调用方按 DIR_MISSING/空库语义处理
    return [];
  }

  const results: ScriptToolScanEntry[] = [];
  // 防御性目录名查重（文件系统天然保证唯一；触发即 DIR_NAME_DUPLICATED）
  const dirNameCount = new Map<string, number>();

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) {
      continue;
    }
    dirNameCount.set(dirent.name, (dirNameCount.get(dirent.name) ?? 0) + 1);
    const toolDir = path.join(root, dirent.name);
    const protocolPath = path.join(toolDir, SCRIPT_TOOL_PROTOCOL_FILE_NAME);
    const mainPyPath = path.join(toolDir, SCRIPT_TOOL_ENTRY_FILE_NAME);

    if (!existsSync(protocolPath)) {
      results.push({ dirName: dirent.name, ok: false, code: SCRIPT_TOOL_CODES.PROTOCOL_MISSING, error: '缺少 protocol.yaml' });
      continue;
    }
    if (!existsSync(mainPyPath)) {
      results.push({ dirName: dirent.name, ok: false, code: SCRIPT_TOOL_CODES.ENTRY_MISSING, error: '缺少 main.py' });
      continue;
    }

    try {
      const text = await readFile(protocolPath, 'utf-8');
      const check = parseScriptToolProtocolText(text, dirent.name);
      if (!check.ok) {
        results.push({ dirName: dirent.name, ok: false, code: check.code, error: check.error });
        continue;
      }
      results.push({
        dirName: dirent.name,
        ok: true,
        protocol: check.protocol,
        toolDir,
        protocolPath,
        mainPyPath,
      });
    } catch (error) {
      results.push({
        dirName: dirent.name,
        ok: false,
        code: SCRIPT_TOOL_CODES.PROTOCOL_INVALID,
        error: `protocol.yaml 读取失败：${(error as Error).message}`,
      });
    }
  }

  // 跨目录查重（3.5）：目录名重复（防御性）；name 重复（name==dirName 强制下与目录重复等价，防御性兜底）
  for (const [dirName, count] of dirNameCount) {
    if (count > 1) {
      for (const entry of results) {
        if (entry.dirName === dirName && entry.ok) {
          results.splice(results.indexOf(entry), 1, {
            dirName,
            ok: false,
            code: SCRIPT_TOOL_CODES.DIR_NAME_DUPLICATED,
            error: `目录名重复：${dirName}（出现 ${count} 次）`,
          });
        }
      }
    }
  }
  const nameOwners = new Map<string, string[]>();
  for (const entry of results) {
    if (!entry.ok) {
      continue;
    }
    const owners = nameOwners.get(entry.protocol.name) ?? [];
    owners.push(entry.dirName);
    nameOwners.set(entry.protocol.name, owners);
  }
  for (const [name, owners] of nameOwners) {
    if (owners.length <= 1) {
      continue;
    }
    for (const entry of results) {
      if (entry.ok && entry.protocol.name === name) {
        results.splice(results.indexOf(entry), 1, {
          dirName: entry.dirName,
          ok: false,
          code: SCRIPT_TOOL_CODES.SLUG_CONFLICT,
          error: `协议 name(${name}) 重复：目录 ${owners.join('、')}`,
        });
      }
    }
  }

  // R2：合法工具数超限时剔除创建时间最旧者（查看协议/调用定位/委派组装/清单块共用本扫描，快照一致）
  const okEntries = results.filter((entry) => entry.ok);
  if (okEntries.length > MAX_SCRIPT_TOOLS) {
    const evicted = await evictOldestScriptTools(okEntries);
    for (let i = results.length - 1; i >= 0; i -= 1) {
      if (evicted.has(results[i].dirName)) {
        results.splice(i, 1);
      }
    }
  }

  return results;
}
