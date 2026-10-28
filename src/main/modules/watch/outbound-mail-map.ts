/**
 * outbound-mail-map — 出站邮件映射（BUG3 修复：send_email 出站邮件 ↔ 原对话）
 *
 * 背景（用户第 8 条 / BUG3 修复语义）：
 * - 用户直接回复智能体经 send_email 发出的邮件时，收信侧需要把该回复关联回原对话
 *   （等同在当前对话输入该消息）；前提是存在「出站邮件 Message-ID → conversationId」
 *   的可反查映射。本模块即该映射的登记与解析实现（仿 conversation-index-map 先例）。
 * - 登记侧：send-email.ts 发送成功后登记（**不依赖值守指令上下文**——本地对话发起的
 *   run 同样登记，否则本地对话的邮件回复无法关联回原对话）。
 * - 消费侧：watch-service.processWatchMail 在 non_command 判定前，用回复邮件的
 *   In-Reply-To 头命中本映射 → 提取用户手写正文后注入原对话。
 *
 * 数据结构（latest.json，单文件全量）：
 *   { version: 1; entries: Array<{
 *       messageId: string;       // 出站邮件 Message-ID（SMTP 声明值，含尖括号）
 *       conversationId: string;  // 发起 run 的对话 GUID
 *       sentTo: string;          // 收件人（观测用）
 *       subject: string;         // 主题（观测用）
 *       sentAtIso: string;       // 发送时间（淘汰与观测用） }> }
 *
 * 写入（registerOutboundMail）：内存 Map + <userData>/watch/outbound-mail-map/latest.json；
 *   条目超出容量上限（200）按插入顺序淘汰最旧。文件写入失败仅保留内存映射并返回 false
 *   （登记是增强能力而非发送前置条件，绝不影响 send_email 主流程）。
 *
 * 读取（resolveOutboundConversationByMessageId）：内存优先 → latest.json（进程重启可恢复）；
 *   Message-ID 匹配做归一化（去首尾尖括号/空白、转小写），兼容「<id>」与「id」两种形态
 *   （In-Reply-To 头惯例带尖括号，出站声明值同带尖括号）。
 *   文件缺失 / JSON 解析失败 / 结构非法一律返回 null（失败即「无映射」，绝不猜测——
 *   与编号映射同策略：未命中由调用方回落 non_command 静默忽略，防误注入）。
 *
 * 可验证性：本模块不 import electron；userData 基目录由 watch-service 在模块加载时注入
 * （与 conversation-index-map 的 baseDir 注入先例一致），无 Electron 本地环境可直接加载验证。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 单条出站映射 */
export interface OutboundMailMapEntry {
  /** 出站邮件 Message-ID（SMTP 声明值，如 `<1730000000000.1a2b3c@delepi.watch>`） */
  messageId: string;
  /** 发起 run 的对话 GUID */
  conversationId: string;
  /** 收件人（观测用） */
  sentTo: string;
  /** 主题（观测用） */
  subject: string;
  /** 发送时间（ISO 8601；淘汰排序与观测用） */
  sentAtIso: string;
}

/** 映射文件整体结构 */
interface OutboundMailMapFile {
  version: number;
  entries: OutboundMailMapEntry[];
}

/** 内存容量上限（按插入顺序淘汰最旧；主流程单日出站回执量级远小于此值） */
export const OUTBOUND_MAIL_MAP_LIMIT = 200;

/** 映射文件名（单文件全量；与编号映射的 latest.json 同名不同目录，重启恢复入口） */
const OUTBOUND_MAIL_MAP_FILE = 'latest.json';

/** 文件结构版本（结构演进时递增；不匹配的旧文件按无映射处理） */
const OUTBOUND_MAIL_MAP_VERSION = 1;

/** userData 基目录提供者（由 watch-service 注入，与 conversation-index-map 先例一致） */
let baseDirProvider: (() => string) | null = null;

/** 内存缓存（messageId 归一化键 → 条目；Map 迭代顺序 = 插入顺序，用于淘汰最旧） */
const memoryEntries = new Map<string, OutboundMailMapEntry>();

/** Message-ID 归一化：去首尾尖括号与空白、转小写（兼容 `<id>` / `id` 两种形态） */
function normalizeMessageId(messageId: string): string {
  return String(messageId ?? '').trim().replace(/^<+|>+$/g, '').trim().toLowerCase();
}

/** 注入 userData 基目录提供者（watch-service 注入 `() => app.getPath('userData')`；传 null 可清除） */
export function setOutboundMailMapBaseDirProvider(provider: (() => string) | null): void {
  baseDirProvider = provider;
}

/** 解析映射文件路径：<userData>/watch/outbound-mail-map/latest.json（未注入基目录返回 null） */
function resolveMapFilePath(): string | null {
  if (!baseDirProvider) {
    return null;
  }
  const baseDir = baseDirProvider();
  if (!baseDir) {
    return null;
  }
  return path.join(baseDir, 'watch', 'outbound-mail-map', OUTBOUND_MAIL_MAP_FILE);
}

/** 文件内容归一校验（非法结构返回 null；单条非法仅跳过该条——与编号映射同策略） */
function normalizeMapFile(raw: unknown): OutboundMailMapFile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== OUTBOUND_MAIL_MAP_VERSION || !Array.isArray(obj.entries)) {
    return null;
  }
  const entries: OutboundMailMapEntry[] = [];
  for (const item of obj.entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const messageId = typeof entry.messageId === 'string' ? entry.messageId : '';
    const conversationId = typeof entry.conversationId === 'string' ? entry.conversationId : '';
    if (!normalizeMessageId(messageId) || !conversationId) {
      continue;
    }
    entries.push({
      messageId,
      conversationId,
      sentTo: typeof entry.sentTo === 'string' ? entry.sentTo : '',
      subject: typeof entry.subject === 'string' ? entry.subject : '',
      sentAtIso: typeof entry.sentAtIso === 'string' ? entry.sentAtIso : '',
    });
  }
  return { version: OUTBOUND_MAIL_MAP_VERSION, entries };
}

/** 内存为空时从 latest.json 恢复历史条目（进程重启续命）；失败静默（无映射语义由调用方兜底） */
function ensureMemoryLoadedFromDisk(): void {
  if (memoryEntries.size > 0) {
    return;
  }
  const filePath = resolveMapFilePath();
  if (!filePath || !existsSync(filePath)) {
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    const normalized = normalizeMapFile(parsed);
    if (!normalized) {
      return;
    }
    for (const entry of normalized.entries) {
      memoryEntries.set(normalizeMessageId(entry.messageId), entry);
      pruneOldestIfNeeded();
    }
  } catch {
    // 文件损坏视同无历史映射：内存态从零开始（不影响后续新登记）
  }
}

/** 超出容量上限时按插入顺序淘汰最旧（Map 迭代顺序 = 插入顺序） */
function pruneOldestIfNeeded(): void {
  while (memoryEntries.size > OUTBOUND_MAIL_MAP_LIMIT) {
    const oldest = memoryEntries.keys().next();
    if (oldest.done) {
      break;
    }
    memoryEntries.delete(oldest.value);
  }
}

/**
 * 登记一条出站映射（send-email.ts 发送成功后调用；不依赖值守指令上下文）。
 * 返回 true=内存+文件均写入成功；false=仅内存成功或整体失败（文件失败不影响发送主流程）。
 */
export function registerOutboundMail(entry: OutboundMailMapEntry): boolean {
  const key = normalizeMessageId(entry.messageId);
  if (!key || !entry.conversationId) {
    return false;
  }
  // 先合并磁盘历史条目再插入：防止进程内首条登记把磁盘上的历史映射整份覆盖掉
  ensureMemoryLoadedFromDisk();
  // 同一 Message-ID 重复登记以最新为准（理论不可达：声明值含时间戳+随机数，防御性处理）
  memoryEntries.delete(key);
  memoryEntries.set(key, { ...entry, messageId: entry.messageId.trim() });
  pruneOldestIfNeeded();

  const filePath = resolveMapFilePath();
  if (!filePath) {
    return false;
  }
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const payload: OutboundMailMapFile = {
      version: OUTBOUND_MAIL_MAP_VERSION,
      entries: Array.from(memoryEntries.values()),
    };
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    // 文件写入失败：保留内存映射（进程生命周期内仍可命中），不抛错不影响发送主流程
    return false;
  }
}

/**
 * 按回复邮件的 In-Reply-To 头反查原对话（watch-service.processWatchMail 消费）。
 * 归一化后未命中返回 null（无映射语义：调用方回落 non_command 静默忽略，绝不猜测）。
 */
export function resolveOutboundConversationByMessageId(messageId: string): OutboundMailMapEntry | null {
  const key = normalizeMessageId(messageId);
  if (!key) {
    return null;
  }
  ensureMemoryLoadedFromDisk();
  const hit = memoryEntries.get(key);
  return hit ? { ...hit } : null;
}
