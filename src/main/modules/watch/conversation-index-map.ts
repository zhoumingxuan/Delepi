/**
 * conversation-index-map — 对话编号映射（查询回执附件 ↔ 后续 `--conversation <编号>` 指令）
 *
 * 背景（用户第 5 条要求）：
 * - 查询指令邮件不能只回一串 GUID（用户无法在回信里照抄）；值守服务把「当前对话列表」按现有排序
 *   重新编号 1..N，编号 ↔ GUID 的映射以 JSON 附件回执，后续发消息指令只写编号即可
 * - 指令邮件本身按用户要求「一律无需记录」：映射落的是纯文件缓存，**禁止使用任何数据库表**
 *
 * 数据结构：
 *   { requestId: string; createdAtIso: string; items: Array<{
 *       index: number; conversationId: string; title: string; isRunning: boolean; updatedAt: string }> }
 *
 * 写入（saveConversationIndexMap）：
 *   1) 内存（同进程内后续指令零 IO 命中）
 *   2) <userData>/watch/conversation-index-map/<requestId>.json
 *   3) 同一内容复制为 <userData>/watch/conversation-index-map/latest.json（重启恢复锚点）
 *   4) 保留最近 20 份（按文件 mtime 淘汰最旧；latest.json 不参与计数、不参与淘汰）
 *
 * 读取（getLatestConversationIndexMap）：内存优先；内存为空时读 latest.json（进程重启可恢复）；
 *   文件缺失/JSON 解析失败/结构非法一律返回 null（失败即「无映射」，绝不猜测）
 *
 * 解析（resolveConversationIdByIndex）：编号不在映射内返回 null，调用方必须据此发失败回执并中止
 *
 * 可验证性：本模块不 import electron；userData 基目录由 watch-service 在模块加载时注入
 * （与 mail-bridge 的 baseDir 注入先例一致），因此在无 Electron、无网络的本地环境可直接加载验证。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 单条编号映射 */
export interface ConversationIndexMapItem {
  /** 1 起的连续编号（与回执 HTML 表格「编号」列一致） */
  index: number;
  /** 对话 GUID（只出现在 JSON 附件与本地缓存，不出现在回执 HTML 正文） */
  conversationId: string;
  title: string;
  isRunning: boolean;
  updatedAt: string;
}

/** 一份编号映射（一次查询指令对应一份） */
export interface ConversationIndexMap {
  requestId: string;
  createdAtIso: string;
  items: ConversationIndexMapItem[];
}

/** 编号映射构建入参：会话行的最小投影（避免本模块依赖仓储层类型） */
export interface ConversationIndexSourceRow {
  id: string;
  title: string;
  isRunning: boolean;
  updatedAt: string;
}

/** 本地保留的映射文件份数（不含 latest.json） */
export const CONVERSATION_INDEX_MAP_KEEP_FILES = 20;

/** 最新映射副本文件名（进程重启恢复入口） */
export const CONVERSATION_INDEX_MAP_LATEST_FILE = 'latest.json';

/** userData 基目录提供者（由 watch-service 注入） */
let baseDirProvider: (() => string) | null = null;

/** 内存缓存（同进程内最近一次成功写入的映射） */
let memoryMap: ConversationIndexMap | null = null;

/**
 * 注入 userData 基目录提供者（watch-service 注入 `() => app.getPath('userData')`）。
 * 传 null 可清除注入（主要供本地验证隔离使用）。
 */
export function setConversationIndexMapBaseDirProvider(provider: (() => string) | null): void {
  baseDirProvider = provider;
}

/** 解析映射目录：<userData>/watch/conversation-index-map */
function resolveIndexMapDir(): string {
  if (!baseDirProvider) {
    throw new Error('conversation-index-map 未注入 userData 基目录（setConversationIndexMapBaseDirProvider）');
  }
  const baseDir = baseDirProvider();
  if (!baseDir) {
    throw new Error('conversation-index-map 注入的 userData 基目录为空');
  }
  return path.join(baseDir, 'watch', 'conversation-index-map');
}

/** 文件名净化：requestId 只允许安全字符，其余替换为下划线（防路径穿越） */
function sanitizeFileStem(requestId: string): string {
  const cleaned = requestId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return cleaned || 'unknown-request';
}

/** 浅拷贝（对外返回副本，避免调用方篡改内存态） */
function cloneMap(map: ConversationIndexMap): ConversationIndexMap {
  return {
    requestId: map.requestId,
    createdAtIso: map.createdAtIso,
    items: map.items.map((item) => ({ ...item })),
  };
}

/** 结构校验与归一（非法结构返回 null；单条非法仅跳过该条） */
function normalizeMap(raw: unknown): ConversationIndexMap | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const requestId = typeof obj.requestId === 'string' ? obj.requestId : '';
  const createdAtIso = typeof obj.createdAtIso === 'string' ? obj.createdAtIso : '';
  if (!requestId || !Array.isArray(obj.items)) {
    return null;
  }
  const items: ConversationIndexMapItem[] = [];
  for (const entry of obj.items) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const index = typeof item.index === 'number' ? item.index : Number.NaN;
    const conversationId = typeof item.conversationId === 'string' ? item.conversationId : '';
    if (!Number.isInteger(index) || index < 1 || !conversationId) {
      continue;
    }
    items.push({
      index,
      conversationId,
      title: typeof item.title === 'string' ? item.title : '',
      isRunning: item.isRunning === true,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    });
  }
  return { requestId, createdAtIso, items };
}

/** 淘汰最旧映射文件：仅统计 <requestId>.json，保留最近 20 份（latest.json 不动） */
function pruneIndexMapFiles(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const files: Array<{ fullPath: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json') || name === CONVERSATION_INDEX_MAP_LATEST_FILE) {
      continue;
    }
    const fullPath = path.join(dir, name);
    try {
      files.push({ fullPath, mtimeMs: statSync(fullPath).mtimeMs });
    } catch {
      // 单文件 stat 失败跳过，不影响写入主流程
    }
  }
  files.sort((a, b) => (a.mtimeMs === b.mtimeMs ? a.fullPath.localeCompare(b.fullPath) : a.mtimeMs - b.mtimeMs));
  let excess = files.length - CONVERSATION_INDEX_MAP_KEEP_FILES;
  for (const file of files) {
    if (excess <= 0) {
      break;
    }
    try {
      rmSync(file.fullPath, { force: true });
      excess -= 1;
    } catch {
      // 删除失败不阻断本次写入（下一轮继续尝试淘汰）
    }
  }
}

/**
 * 由会话列表构建一份编号映射（阶段7：`--list` 回执与「重启续期邮件」共用同一构建逻辑）：
 * 按传入顺序（调用方保证= conversations 表的 updated_at DESC 排序）编号 1..N，
 * limit 缺省/非法时不截断。返回结构与 saveConversationIndexMap 入参完全一致。
 */
export function buildConversationIndexMap(
  requestId: string,
  createdAtIso: string,
  rows: ConversationIndexSourceRow[],
  limit?: number,
): ConversationIndexMap {
  const safeLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : rows.length;
  const items: ConversationIndexMapItem[] = rows.slice(0, safeLimit).map((row, index) => ({
    index: index + 1,
    conversationId: row.id,
    title: row.title,
    isRunning: row.isRunning,
    updatedAt: row.updatedAt,
  }));
  return { requestId, createdAtIso, items };
}

/**
 * 保存一份编号映射：内存 + `<requestId>.json` + `latest.json`，并淘汰超出保留份数的旧文件。
 * 写文件失败会抛出异常，由调用方决定是否降级（watch-service 会记 ERROR 日志并继续回执流程）。
 */
export function saveConversationIndexMap(map: ConversationIndexMap): void {
  const dir = resolveIndexMapDir();
  mkdirSync(dir, { recursive: true });

  const normalized: ConversationIndexMap = {
    requestId: map.requestId,
    createdAtIso: map.createdAtIso,
    items: map.items.map((item) => ({ ...item })),
  };
  const json = `${JSON.stringify(normalized, null, 2)}\n`;

  memoryMap = normalized;

  writeFileSync(path.join(dir, `${sanitizeFileStem(normalized.requestId)}.json`), json, 'utf8');
  writeFileSync(path.join(dir, CONVERSATION_INDEX_MAP_LATEST_FILE), json, 'utf8');

  pruneIndexMapFiles(dir);
}

/**
 * 读取最新一份编号映射：内存优先 → latest.json（进程重启恢复）。
 * 文件缺失、读取异常、JSON 非法、结构非法一律返回 null。
 */
export function getLatestConversationIndexMap(): ConversationIndexMap | null {
  if (memoryMap) {
    return cloneMap(memoryMap);
  }

  let latestPath: string;
  try {
    latestPath = path.join(resolveIndexMapDir(), CONVERSATION_INDEX_MAP_LATEST_FILE);
  } catch {
    return null;
  }
  if (!existsSync(latestPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(latestPath, 'utf8')) as unknown;
    const normalized = normalizeMap(parsed);
    if (!normalized) {
      return null;
    }
    memoryMap = normalized;
    return cloneMap(normalized);
  } catch {
    return null;
  }
}

/**
 * 按编号解析对话 GUID：编号不存在 / 无任何映射 / 编号非法 一律返回 null。
 * 严禁猜测、模糊匹配或回退到「列表第 N 条以外的任何推断」。
 */
export function resolveConversationIdByIndex(index: number): string | null {
  if (!Number.isInteger(index) || index < 1) {
    return null;
  }
  const map = getLatestConversationIndexMap();
  if (!map) {
    return null;
  }
  const hit = map.items.find((item) => item.index === index);
  return hit ? hit.conversationId : null;
}
