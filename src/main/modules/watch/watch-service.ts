/**
 * watch-service — 值守模式服务（阶段7：Node 收信桥 + provider 端点 + 三类指令 + 跳转联动 + 重启续期）
 *
 * 职责：
 * - 凭据自检：mailSelfTest（IMAP 登录 + EXAMINE INBOX + SMTP 登录）不变；失败回落关闭仅复位
 *   运行态与 lastError（watchEnabled 唯一语义=用户意图，回落不写回该键，跨重启保留）。
 *   阶段7 起收信桥为纯 Node 实现（imap-client），
 *   端点由 mail-provider 按「邮箱类型」解析后注入，收信/发信共用同一份端点
 * - 时间增量（用户第 8 条）：不再使用数据库 UID 水位，改为纯内存时间游标 sinceTimeMs。
 *   开启/恢复时 sinceTimeMs = 启动时刻（首开不处理历史积压）；每轮以
 *   mailImapPollSince(sinceIso=游标) 取候选（IMAP SEARCH SINCE 游标-1天，最新至多 50 封），
 *   再按 INTERNALDATE（空则回退 Date 头，仍为空视为需处理）>= 游标毫秒 过滤，
 *   时间升序、单轮最多 20 封；本轮结束后游标推进为「本轮开始时间戳」
 * - 指令/非指令区分（用户第 6 条）：① X-Delepi-Role 头 ② [Delepi回执] 主题前缀
 *   ③ From 头缺失/解析失败 → 跳过（状态沿用 sender_rejected，不再按发件人身份拒绝）
 *   ④ detectCommandMarkers；非指令邮件静默忽略且不发送任何回执（与旧行为的关键差异）
 *   以上 ①~④ 四类一律不推送前端跳转事件（阶段7 目标5②，判定表见 watch-navigation）
 * - 去重（纯内存）：processedMessageIds（上限 2000，按插入顺序淘汰最旧）挡重复 FETCH；
 *   processedRequestIds（上限 500）挡重复 request_id（不重复执行、不重发缓存回执）
 * - 编号映射（用户第 5 条）：--list 回执按 1..N 重新编号，编号↔GUID 映射以 JSON 附件回执
 *   并落 <userData>/watch/conversation-index-map（内存 + 每份文件 + latest.json）；
 *   --conversation N 严格按最新映射解析，缺失/越界即失败回执，绝不猜测或模糊匹配
 * - 回执发送：Node SMTP（smtp-client.sendSmtpMail，HTML 正文 + 可选附件 Buffer），
 *   重试序列 [0s, 2s, 5s, 15s]，auth 阶段立即放弃，X-Delepi-Role: agent 恒加，
 *   In-Reply-To/References = 指令邮件实际 Message-ID，X-Delepi-Command-Id 回带
 * - 单轨回执（BUG2 修复后语义）：send_message 的任务回执优先由主智能体经 send_email 发出；
 *   服务端直发仅两类：①「注入前协议层失败」（编号不存在/会话不存在/会话运行中/主模型未配置）
 *   ②执行期失败兜底（ERR_WATCH_EXEC_ABORTED/ERR_WATCH_EXEC_FAILED 且模型未发出回执时，
 *   receiptSentByAgent 防重发；模型已发过则不重复直发）
 * - 三类指令（阶段7 目标4）：list_conversations（查询）/ send_message（向已有对话发消息，需编号或
 *   UUID）/ new_conversation（只带 --message 时新建对话并在其中执行）
 * - 指令邮件一律不落库（用户第 7 条）：本模块不 import 任何仓储，不使用任何数据库表
 * - 轮询调度：递归 setTimeout + inFlight 互斥（主进程禁 setInterval），间隔每轮重读；
 *   连接失败指数退避 min(间隔×2^n, 600s)，连续失败 ≥5 次回落关闭
 * - 注入异步化（BUG1 修复）：send_message/new_conversation 注入改 fire-and-forget——
 *   不阻塞轮询循环与同批后续邮件处理；run 终态经回调登记（读 run 实例私有的指令上下文、
 *   登记结果、触发兜底回执判定）；list_conversations 保持同轮同步快速直发（现状语义）
 * - 出站回复关联（BUG3 修复）：send_email 出站邮件经 outbound-mail-map 登记
 *   （Message-ID → conversationId，不依赖指令上下文）；processWatchMail 在非指令判定前，
 *   In-Reply-To 命中映射的回复邮件提取用户手写正文后注入原对话（等同在当前对话输入）
 */

import { app, BrowserWindow } from 'electron';
import { Buffer } from 'node:buffer';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { IPC_WATCH } from '@shared/ipc-channels';
import { configManager } from '../config/config-manager';
import {
  describeMailEndpoints,
  resolveMailEndpoints,
  validateMailEndpoints,
  type MailProviderEndpoints,
} from '../mail/mail-provider';
import { saveSetting } from '../../db';
import {
  createConversation,
  getConversationById,
  listConversations,
} from '../../db/repositories/conversation.repo';
import {
  filterMailsAtOrAfterCursor,
  mailImapPollSince,
  mailSelfTest,
  setActiveMailEndpoints,
  sortMailsByTimeAscending,
  type FetchedWatchMail,
  type MailBridgeContext,
  type MailBridgeFailure,
} from './mail-bridge';
import {
  detectCommandMarkers,
  generateRequestId,
  parseWatchCommand,
  type ListConversationsCommand,
  type NewConversationCommand,
  type SendMessageCommand,
} from './command-parser';
import {
  buildConversationIndexMap,
  saveConversationIndexMap,
  resolveConversationIdByIndex,
  setConversationIndexMapBaseDirProvider,
  type ConversationIndexMapItem,
} from './conversation-index-map';
import {
  resolveOutboundConversationByMessageId,
  setOutboundMailMapBaseDirProvider,
} from './outbound-mail-map';
import {
  buildCommandNavigationPayload,
  type WatchCommandNavigationPayload,
} from './watch-navigation';
import { sendUserMessageIntoConversation } from '../chat/conversation-send-service';
import { setWatchRuntimeRunning, type WatchCommandContext } from './watch-runtime-flag';
import { normalizeWatchSettings, type NormalizedWatchSettings } from './watch-settings';
import { maskAuthCode, sendSmtpMail, type SmtpAttachmentInput, type SmtpHeaderInput } from '../mail/smtp-client';

/** 编号映射模块不 import electron：userData 基目录在模块加载时注入（与 mail-bridge 的 baseDir 注入先例一致） */
setConversationIndexMapBaseDirProvider(() => getBridgeBaseDir());

/** 出站邮件映射模块同策略（BUG3）：不 import electron，userData 基目录同样在模块加载时注入 */
setOutboundMailMapBaseDirProvider(() => getBridgeBaseDir());

/** 值守服务运行状态（closed=关闭 starting=自检中 running=运行中 suspended=异常暂停） */
export type WatchRuntimeStatus = 'closed' | 'starting' | 'running' | 'suspended';

export interface WatchStartResult {
  ok: boolean;
  status: WatchRuntimeStatus;
  code?: string;
  message?: string;
}

export interface WatchStopResult {
  ok: boolean;
  status: WatchRuntimeStatus;
}

export interface WatchLastError {
  code: string;
  message: string;
  at: string;
}

/** 时间增量游标（取代旧 UID 水位；界面展示「增量游标 <本地时间>」） */
export interface WatchCursor {
  mailbox: string;
  sinceTime: string;
  updatedAt: string;
}

export interface WatchStatusResult {
  status: WatchRuntimeStatus;
  enabled: boolean;
  lastError: WatchLastError | null;
  /** 旧 UID 水位字段：为保证 IPC 契约向后兼容而保留，恒为 null（阶段5 起不再使用） */
  watermark: { mailbox: string; uidvalidity: number; lastUid: number; updatedAt: string } | null;
  /** 时间增量游标（无基线时为 null） */
  cursor: WatchCursor | null;
  nextPollAt: string | null;
  /** 本次运行已处理（执行指令）的封数（纯内存计数） */
  processedCount: number;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 单轮最多处理邮件数（游标保证不丢，下一轮继续） */
const MAX_MAILS_PER_POLL = 20;

/** 首轮轮询延迟（watch:start 成功后等窗口就绪） */
const FIRST_POLL_DELAY_MS = 5_000;

/** 游标推进重叠窗口下限（毫秒）：IMAP 索引存在数十秒级延迟（阶段6 实测约 40s），游标只推进到
 * 「本轮开始时刻 - 重叠窗口」，窗口内的邮件由后续轮次重复取回（processedMessageIds 去重），
 * 确保「宁可重复不漏信」。实际窗口取 max(本下限, 轮询间隔 + 60s 索引余量)。 */
const POLL_CURSOR_OVERLAP_MS = 180_000;

/** 连续失败退避上限（毫秒） */
const BACKOFF_MAX_MS = 600_000;

/** 连续失败回落关闭阈值 */
const MAX_CONSECUTIVE_FAILURES = 5;

/** 服务直发回执重试间隔（首次立即，随后 2s/5s/15s） */
const RECEIPT_RETRY_DELAYS_MS = [0, 2_000, 5_000, 15_000];

/** 单次回执 SMTP 发送超时（毫秒） */
const RECEIPT_SMTP_TIMEOUT_MS = 90_000;

/** 已处理 Message-ID 集合容量上限（按插入顺序淘汰最旧） */
const PROCESSED_MESSAGE_IDS_LIMIT = 2_000;

/** 已处理 request_id 集合容量上限（按插入顺序淘汰最旧） */
const PROCESSED_REQUEST_IDS_LIMIT = 500;

/** 内存状态记录数组容量上限 */
const MEMORY_RECORDS_LIMIT = 500;

/** 邮箱格式校验 */
const WATCH_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** 回执主题前缀（同时是回执环过滤特征） */
const RECEIPT_SUBJECT_PREFIX = '[Delepi回执]';

/** 重启续期邮件/编号映射的最大条数（与 --list 上限 50 对齐：编号稳定且邮件体积可控） */
const RESUME_INDEX_MAP_LIMIT = 50;

// ---------------------------------------------------------------------------
// 日志：格式与 ipc-handlers.writeMainLog 完全一致（[ISO] [LEVEL] [stage] message :: detail），
// 写入同一 userData/logs/main.log。内联实现保持依赖单向（ipc-handlers → watch-service）。
// ---------------------------------------------------------------------------

function writeWatchLog(level: 'INFO' | 'WARN' | 'ERROR', stage: string, messageText: string, err?: unknown): void {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    mkdirSync(logDir, { recursive: true });
    const ts = new Date().toISOString();
    let detail = '';
    if (err instanceof Error) {
      detail = `${err.message}${err.stack ? `\n${err.stack}` : ''}`;
    } else if (err !== undefined) {
      const maybeErr = err as { message?: unknown; stack?: unknown };
      if (maybeErr !== null && typeof maybeErr.message === 'string') {
        detail = `${maybeErr.message}${typeof maybeErr.stack === 'string' ? `\n${maybeErr.stack}` : ''}`;
      } else {
        detail = String(err);
      }
    }
    appendFileSync(
      path.join(logDir, 'main.log'),
      `[${ts}] [${level}] [${stage}] ${messageText}${detail ? ` :: ${detail}` : ''}\n`,
      'utf8',
    );
  } catch {
    // 忽略：日志写入失败不影响应用主流程（与 writeMainLog 同策略）
  }
}

/** 邮箱脱敏展示（a***@qq.com） */
function maskMailbox(mailbox: string): string {
  if (!mailbox || !mailbox.includes('@')) {
    return '***';
  }
  const [local, domain] = mailbox.split('@');
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ISO 时间 → 本地 YYYY-MM-DD HH:mm:ss（回执与日志展示用） */
function formatLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 毫秒时间戳 → 本地 YYYY-MM-DD HH:mm:ss */
function formatLocalDateTimeFromMs(ms: number): string {
  return formatLocalDateTime(new Date(ms).toISOString());
}

// ---------------------------------------------------------------------------
// 模块状态（纯内存态；不写任何数据库表）
// ---------------------------------------------------------------------------

let runtimeStatus: WatchRuntimeStatus = 'closed';
/** start 事务世代号：stopWatch / stopWatchService / 新一次 performStart 均递增；
 * 在途 start 事务在 await 恢复点校验世代，不匹配即作废——终态写入权由世代仲裁，互斥由状态机结构保证 */
let startGeneration = 0;
let recoveryStarted = false;
let pollTimerHandle: ReturnType<typeof setTimeout> | null = null;
let pollInFlight = false;
let consecutiveFailures = 0;
let lastError: WatchLastError | null = null;
let nextPollAt: number | null = null;
/** 值守运行态变更通知：驱动 MAIN_TOOLS 等运行态投影刷新；由 ipc-handlers 注册 refreshMainTools */
let runtimeStateChangeNotifier: (() => void) | null = null;

/** 时间游标（毫秒）：0 表示尚未建立基线 */
let sinceTimeMs = 0;

/** 本次运行的基线（毫秒，对齐整秒）：游标推进不得回退到基线之前（首开不处理历史积压） */
let baselineTimeMs = 0;

/** 游标来源邮箱与展示用 ISO 文本 */
let cursorMailbox = '';
let cursorSinceIso = '';
let cursorUpdatedAtIso = '';

/** 邮件级去重（收件箱实际 Message-ID） */
const processedMessageIds = new Set<string>();

/** 业务级去重（request_id） */
const processedRequestIds = new Set<string>();

/** 本次运行已处理（执行指令）封数 */
let processedCount = 0;

/** 内存状态记录（可审计的最近处理轨迹，上限 500） */
interface WatchMemoryRecord {
  atIso: string;
  uid: number;
  messageId: string;
  status: string;
  requestId: string;
  subject: string;
}

const memoryRecords: WatchMemoryRecord[] = [];

/** 读取归一化后的值守配置（本模块内 normalizeWatchSettings 唯一调用出口） */
function readNormalizedWatchSettings(): NormalizedWatchSettings {
  return normalizeWatchSettings(configManager.getSettings());
}

/**
 * watchEnabled 写回（settings 表 + configManager 运行时两步，对齐 config:save 先例）。
 * 唯一语义=用户意图，仅两个用户动作出口调用：performStart 自检通过（true）与 stopWatch（false）；
 * 运行态回落（makeStartFailure / fallbackCloseRuntime）不触碰本键。
 * 本函数为纯意图写，不触发运行态通知——通知（notifyRuntimeStateChange）由各终态转移点在
 * 运行态标志（runtimeStatus / setWatchRuntimeRunning）落位之后统一触发，保证投影刷新
 * （MAIN_TOOLS 等）读到的是已定局的运行态，消除"通知先于标志落位"的陈旧投影窗口。
 */
function persistWatchEnabled(enabled: boolean): void {
  saveSetting('watchEnabled', enabled);
  configManager.setSetting('watchEnabled', enabled);
}

/** 运行态变更通知（每次终态转移统一触发；驱动工具清单等投影刷新） */
function notifyRuntimeStateChange(): void {
  try {
    runtimeStateChangeNotifier?.();
  } catch (err) {
    writeWatchLog('WARN', 'watch.state', '值守运行态变更通知回调执行失败', err);
  }
}

/**
 * 注入值守运行态变更通知（ipc-handlers 注册时传入 refreshMainTools）。
 * watch-service 不直接依赖 main-agent/prompt，避免反向耦合。
 */
export function setWatchRuntimeStateChangeNotifier(notifier: (() => void) | null): void {
  runtimeStateChangeNotifier = notifier;
}

/**
 * 当前生效邮箱端点（阶段7 目标3：**收信与发信的唯一端点来源**）。
 * 每次调用都重新读 settings（provider 类型或自定义 host/port/加密方式改动后即时生效），
 * 并写入 mail-bridge 的生效端点注册表（同时同步 smtp-client 的默认加密方式，
 * 使改动白名单之外的 send_email 工具自动跟随邮箱类型）。
 */
function resolveCurrentMailEndpoints(): MailProviderEndpoints {
  const endpoints = resolveMailEndpoints(configManager.getSettings());
  setActiveMailEndpoints(endpoints);
  return endpoints;
}

/** 邮件桥调用上下文（端点已按 provider 解析） */
function getMailBridgeContext(): MailBridgeContext {
  return { endpoints: resolveCurrentMailEndpoints() };
}

function getBridgeBaseDir(): string {
  return app.getPath('userData');
}

// ---------------------------------------------------------------------------
// 纯内存态维护
// ---------------------------------------------------------------------------

/** 复位纯内存态（开启/恢复时调用：以启动时刻为新基线，不继承上次运行的去重集合） */
function resetMemoryState(): void {
  sinceTimeMs = 0;
  baselineTimeMs = 0;
  cursorMailbox = '';
  cursorSinceIso = '';
  cursorUpdatedAtIso = '';
  processedMessageIds.clear();
  processedRequestIds.clear();
  processedCount = 0;
  memoryRecords.length = 0;
}

/** 写入去重集合：超限按插入顺序淘汰最旧（Set 迭代顺序 = 插入顺序） */
function rememberProcessedId(target: Set<string>, id: string, limit: number): void {
  if (!id) {
    return;
  }
  target.add(id);
  while (target.size > limit) {
    const oldest = target.values().next();
    if (oldest.done) {
      break;
    }
    target.delete(oldest.value);
  }
}

/** 追加内存状态记录（上限 500，超限淘汰最旧） */
function pushMemoryRecord(record: WatchMemoryRecord): void {
  memoryRecords.push(record);
  while (memoryRecords.length > MEMORY_RECORDS_LIMIT) {
    memoryRecords.shift();
  }
}

/** 按 request_id 回溯最近一条内存记录（重复请求时用于日志说明） */
function findMemoryRecordByRequestId(requestId: string): WatchMemoryRecord | null {
  for (let i = memoryRecords.length - 1; i >= 0; i -= 1) {
    if (memoryRecords[i].requestId === requestId) {
      return memoryRecords[i];
    }
  }
  return null;
}

/** 更新游标展示态（毫秒游标 → ISO 文本 + 更新时间） */
function updateCursorView(mailbox: string, sinceMs: number): void {
  cursorMailbox = mailbox;
  cursorSinceIso = new Date(sinceMs).toISOString();
  cursorUpdatedAtIso = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// HTML 回执构建（表格化 + 禁止出现完整 GUID）
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const RECEIPT_STYLE = [
  'body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:14px;color:#222;line-height:1.65;margin:0;padding:16px}',
  'h2{font-size:18px;margin:0 0 10px}',
  'h3{font-size:15px;margin:22px 0 8px}',
  'ul.meta{padding-left:18px;margin:0 0 14px}',
  'table{border-collapse:collapse;width:100%;margin:10px 0}',
  'th,td{border:1px solid #d0d0d0;padding:6px 8px;text-align:left;vertical-align:top}',
  'th{background:#f5f5f5;font-weight:600}',
  'td.num{text-align:right;width:56px;font-variant-numeric:tabular-nums}',
  'pre{background:#f6f8fa;border:1px solid #d0d7de;border-radius:4px;padding:10px;white-space:pre-wrap;word-break:break-word;margin:8px 0}',
  '.tip{color:#666;font-size:12px;margin:6px 0}',
  '.fail{color:#b42318;font-weight:600}',
].join('');

function wrapHtmlDocument(titleText: string, innerHtml: string): string {
  return [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8">',
    `<title>${escapeHtml(titleText)}</title>`,
    `<style>${RECEIPT_STYLE}</style>`,
    '</head><body>',
    innerHtml,
    '</body></html>',
  ].join('\n');
}

interface ReceiptHeaderInfo {
  commandLabel: string;
  requestId: string;
  startedAtIso: string;
  finishedAtIso: string;
  resultLabel: '成功' | '失败';
}

function buildReceiptHeadHtml(info: ReceiptHeaderInfo, extraItems: string[] = []): string {
  const items = [
    `指令类型：${escapeHtml(info.commandLabel)}`,
    `请求号：${escapeHtml(info.requestId || '（未提供）')}`,
    `开始时间：${escapeHtml(formatLocalDateTime(info.startedAtIso))}`,
    `结束时间：${escapeHtml(formatLocalDateTime(info.finishedAtIso))}`,
    `结果：${info.resultLabel}`,
    ...extraItems,
    '回执通道：service_direct（值守服务直发）',
  ];
  return [
    '<h2>Delepi 值守回执</h2>',
    '<ul class="meta">',
    ...items.map((text) => `<li>${text}</li>`),
    '</ul>',
  ].join('\n');
}

/** 查询回执：编号/标题/状态/最近更新 四列（禁止出现完整 GUID） */
function buildListConversationsReceiptHtml(
  command: ListConversationsCommand,
  items: ConversationIndexMapItem[],
  total: number,
  startedAtIso: string,
  finishedAtIso: string,
  attachmentFileName: string,
): string {
  const tableRows = items.length > 0
    ? items.map((item) => [
      '<tr>',
      `<td class="num">${item.index}</td>`,
      `<td>${escapeHtml(item.title || '（无标题）')}</td>`,
      `<td>${item.isRunning ? '运行中' : '空闲'}</td>`,
      `<td>${escapeHtml(formatLocalDateTime(item.updatedAt))}</td>`,
      '</tr>',
    ].join(''))
    : ['<tr><td colspan="4">当前没有对话</td></tr>'].join('');

  const head = buildReceiptHeadHtml(
    {
      commandLabel: 'list_conversations（查询对话列表）',
      requestId: command.requestId,
      startedAtIso,
      finishedAtIso,
      resultLabel: '成功',
    },
    [
      `返回条数：${items.length}（共 ${total} 条，本次上限 ${command.limit}）`,
      `附件：${escapeHtml(attachmentFileName)}（编号与对话 GUID 的完整对照）`,
    ],
  );

  return wrapHtmlDocument('Delepi 值守回执 · 对话列表', [
    head,
    '<h3>当前对话列表（按最近更新排序，编号可直接用于发消息）</h3>',
    '<table>',
    '<thead><tr><th>编号</th><th>标题</th><th>状态</th><th>最近更新</th></tr></thead>',
    `<tbody>${tableRows}</tbody>`,
    '</table>',
    '<p class="tip">正文只显示编号，不显示完整对话 GUID；编号与 GUID 的对照见附件。</p>',
    '<h3>怎么向指定对话发消息</h3>',
    '<p>直接回复本邮件，把示例中的编号替换成上表的任意编号，消息内容写在 --message 之后：</p>',
    '<pre>--conversation 3 --message 要发送的内容</pre>',
    '<p>也可以分多行写（--message 之后的所有行都会原样作为消息内容，直到下一个以 -- 开头的参数行）：</p>',
    '<pre>--conversation 3\n--message 第一行内容\n第二行内容</pre>',
    '<p class="tip">可选：单独加一行 --request 自定义请求号（不写则系统自动生成）；'
      + '发消息指令请务必使用「最新一封列表回执」里的编号，编号会随对话列表变化。</p>',
  ].join('\n'));
}

/** 失败回执（HTML） */
function buildFailureReceiptHtml(params: {
  commandLabel: string;
  requestId: string;
  code: string;
  message: string;
  startedAtIso: string;
  finishedAtIso: string;
  advice: string;
}): string {
  const head = buildReceiptHeadHtml(
    {
      commandLabel: params.commandLabel,
      requestId: params.requestId,
      startedAtIso: params.startedAtIso,
      finishedAtIso: params.finishedAtIso,
      resultLabel: '失败',
    },
    [],
  );
  return wrapHtmlDocument('Delepi 值守回执 · 失败', [
    head,
    '<h3 class="fail">处理未完成</h3>',
    '<table>',
    '<tbody>',
    `<tr><th>错误码</th><td>${escapeHtml(params.code)}</td></tr>`,
    `<tr><th>原因</th><td>${escapeHtml(params.message)}</td></tr>`,
    `<tr><th>处理建议</th><td>${escapeHtml(params.advice)}</td></tr>`,
    '</tbody>',
    '</table>',
    '<h3>可用的指令写法</h3>',
    '<pre>--list</pre>',
    '<pre>--conversation 3 --message 要发送的内容</pre>',
  ].join('\n'));
}

/** 解析失败错误码 → 回执主题后缀 */
function failureSubjectSuffix(code: string): string {
  switch (code) {
    case 'ERR_WATCH_NO_COMMAND_BLOCK':
      return '指令块缺失';
    case 'ERR_WATCH_COMMAND_UNKNOWN':
      return '未知指令';
    case 'ERR_WATCH_FIELD_MISSING':
      return '字段缺失';
    case 'ERR_WATCH_FIELD_INVALID':
      return '字段非法';
    case 'ERR_WATCH_BODY_TOO_LARGE':
      return '正文超长';
    case 'ERR_WATCH_CONVERSATION_INDEX_NOT_FOUND':
      return '编号不存在';
    case 'ERR_WATCH_CONVERSATION_NOT_FOUND':
      return '会话不存在';
    case 'ERR_WATCH_CONVERSATION_RUNNING':
      return '会话运行中';
    case 'ERR_WATCH_MAIN_MODEL_NOT_CONFIGURED':
      return '主模型未配置';
    case 'ERR_WATCH_EXEC_ABORTED':
      return '执行超时中止';
    case 'ERR_WATCH_EXEC_FAILED':
      return '执行异常';
    default:
      return '内部错误';
  }
}

// ---------------------------------------------------------------------------
// 回执发送（Node SMTP：HTML 正文 + 可选附件；重试 [0,2,5,15]s，auth 立即放弃）
// ---------------------------------------------------------------------------

interface ReceiptSendParams {
  to: string;
  subject: string;
  html: string;
  /** 指令邮件在收件箱中的实际 Message-ID（腾讯会改写声明值，只能用实际值） */
  inReplyTo: string;
  requestId: string | null;
  attachments?: SmtpAttachmentInput[];
}

type ReceiptSendOutcome = { ok: true; declaredMessageId: string } | { ok: false; detail: string };

async function sendWatchReceiptWithRetry(params: ReceiptSendParams): Promise<ReceiptSendOutcome> {
  // 回执发送凭据与端点在函数入口同一同步段成对读取，重试全程使用同一份；
  // 收件人缺省回落发送时刻值守邮箱（显式收件人由调用方解析传入）。
  const sendTimeSettings = readNormalizedWatchSettings();
  const mailbox = sendTimeSettings.watchMailboxAddress;
  const authCode = sendTimeSettings.watchMailboxAuthCode;
  const to = params.to || mailbox;
  const endpoints = resolveCurrentMailEndpoints();
  let lastDetail = '';

  for (let attempt = 0; attempt < RECEIPT_RETRY_DELAYS_MS.length; attempt += 1) {
    if (RECEIPT_RETRY_DELAYS_MS[attempt] > 0) {
      await sleep(RECEIPT_RETRY_DELAYS_MS[attempt]);
    }

    const headers: SmtpHeaderInput[] = [{ name: 'X-Delepi-Role', value: 'agent' }];
    if (params.inReplyTo) {
      headers.push({ name: 'In-Reply-To', value: params.inReplyTo });
      headers.push({ name: 'References', value: params.inReplyTo });
    }
    if (params.requestId) {
      headers.push({ name: 'X-Delepi-Command-Id', value: params.requestId });
    }

    try {
      const outcome = await sendSmtpMail({
        host: endpoints.smtp.host,
        port: endpoints.smtp.port,
        encryption: endpoints.smtp.encryption,
        mailbox,
        authCode,
        to,
        subject: params.subject,
        html: params.html,
        headers,
        attachments: params.attachments,
        timeoutMs: RECEIPT_SMTP_TIMEOUT_MS,
      });

      if (outcome.ok) {
        return { ok: true, declaredMessageId: outcome.declaredMessageId };
      }

      lastDetail = `[${outcome.stage}] ${maskAuthCode(outcome.error, authCode)}`;
      writeWatchLog(
        'WARN',
        'watch.receipt',
        `回执发送第 ${attempt + 1}/${RECEIPT_RETRY_DELAYS_MS.length} 次尝试失败（stage=${outcome.stage}）`,
        lastDetail,
      );
      if (outcome.stage === 'auth') {
        // 认证失败：重试无意义，立即放弃（与 mail-bridge stage=auth 同策略）
        writeWatchLog('ERROR', 'watch.receipt', '回执发送认证失败：立即放弃重试，请检查值守邮箱授权码');
        return { ok: false, detail: lastDetail };
      }
    } catch (err) {
      lastDetail = maskAuthCode(err instanceof Error ? err.message : String(err), authCode);
      writeWatchLog('WARN', 'watch.receipt', `回执发送第 ${attempt + 1}/${RECEIPT_RETRY_DELAYS_MS.length} 次异常`, lastDetail);
    }
  }

  return { ok: false, detail: lastDetail };
}

/** 失败回执发送封装（统一主题/头/日志） */
async function sendFailureReceipt(params: {
  settings: NormalizedWatchSettings;
  requestId: string | null;
  commandLabel: string;
  code: string;
  message: string;
  advice: string;
  startedAtIso: string;
  inReplyTo: string;
  uid: number;
}): Promise<{ ok: boolean; detail: string }> {
  const finishedAtIso = new Date().toISOString();
  const html = buildFailureReceiptHtml({
    commandLabel: params.commandLabel,
    requestId: params.requestId ?? '',
    code: params.code,
    message: params.message,
    startedAtIso: params.startedAtIso,
    finishedAtIso,
    advice: params.advice,
  });
  const subjectPrefix = params.requestId ? `${params.requestId} ` : '';
  const outcome = await sendWatchReceiptWithRetry({
    to: params.settings.watchReceiptRecipient || params.settings.watchMailboxAddress,
    subject: `${RECEIPT_SUBJECT_PREFIX} ${subjectPrefix}失败｜${failureSubjectSuffix(params.code)}`,
    html,
    inReplyTo: params.inReplyTo,
    requestId: params.requestId,
  });
  if (outcome.ok) {
    writeWatchLog(
      'INFO',
      'watch.receipt',
      `uid=${params.uid} requestId=${params.requestId ?? '-'} errorCode=${params.code} receiptChannel=service_direct`,
    );
    return { ok: true, detail: '' };
  }
  writeWatchLog(
    'ERROR',
    'watch.receipt',
    `uid=${params.uid} requestId=${params.requestId ?? '-'} errorCode=ERR_WATCH_SEND_FAILED 回执发送失败（重试 3 次后放弃）`,
    outcome.detail,
  );
  return { ok: false, detail: outcome.detail };
}

// ---------------------------------------------------------------------------
// 开启流程（watch:start 与自动恢复共用）
// ---------------------------------------------------------------------------

/**
 * 开启失败回落：仅复位运行态与 lastError（不写 watchEnabled——用户"意图=开"跨重启保留，
 * 下次启动 startWatchService 仍会自动恢复重试）。
 * 调用方保证世代有效（await 之后的调用点均已做世代校验）。
 */
function makeStartFailure(stage: string, code: string, message: string, detail?: string): WatchStartResult {
  runtimeStatus = 'closed';
  setWatchRuntimeRunning(false);
  lastError = { code, message, at: new Date().toISOString() };
  notifyRuntimeStateChange();
  writeWatchLog('ERROR', stage, `值守开启失败已回落关闭（watchEnabled 用户意图保留）：${code} ${message}${detail ? ` :: ${detail}` : ''}`);
  return { ok: false, status: 'closed', code, message };
}

async function performStart(fromResume: boolean): Promise<WatchStartResult> {
  const stage = fromResume ? 'watch.resume' : 'watch.start';
  if (runtimeStatus !== 'closed') {
    return { ok: false, status: runtimeStatus, code: 'ERR_WATCH_ALREADY_ACTIVE', message: '值守服务已在运行中' };
  }
  // start 事务世代化：入口捕获本事务世代；stopWatch / stopWatchService / 新一次 performStart
  // 均递增世代，使自检在途（最长 45s）期间被关闭（或被新开启取代）的 start 事务在 await 恢复点
  // 失去全部终态写入权——后到者使先到者作废，互斥由状态机结构保证。
  const generation = ++startGeneration;

  const settings = readNormalizedWatchSettings();

  // ---- 前置本地校验 ----
  if (!WATCH_EMAIL_RE.test(settings.watchMailboxAddress)) {
    return makeStartFailure(stage, 'ERR_WATCH_FIELD_MISSING', '值守邮箱未配置或格式不正确');
  }
  if (settings.watchMailboxAuthCode.length < 8 || settings.watchMailboxAuthCode.length > 64) {
    return makeStartFailure(stage, 'ERR_WATCH_FIELD_MISSING', '邮箱授权码未配置（须为 8-64 字符）');
  }

  // ---- 端点解析与校验（阶段7：邮箱类型/自定义端点在开启前就要确定性判定）----
  const endpoints = resolveCurrentMailEndpoints();
  const endpointCheck = validateMailEndpoints(endpoints);
  if (!endpointCheck.ok) {
    return makeStartFailure(stage, endpointCheck.code, endpointCheck.message);
  }

  runtimeStatus = 'starting';
  writeWatchLog(
    'INFO',
    stage,
    `${fromResume ? '自动恢复' : '开启值守'}：开始凭据自检（${describeMailEndpoints(endpoints)} 登录）mailbox=${maskMailbox(settings.watchMailboxAddress)}`,
  );

  // ---- 真实自检（IMAP 登录 + EXAMINE INBOX + SMTP 登录）----
  const selfTest = await mailSelfTest(
    { mailbox: settings.watchMailboxAddress, authCode: settings.watchMailboxAuthCode },
    { endpoints },
  );
  // await 恢复点世代校验：自检在途期间若发生 stop（watch:stop / 退出清理）或新的 start，
  // startGeneration 已被递增，本事务作废：不写任何状态（服务不复活、watchEnabled 不被覆盖）。
  // 此处至终态写入之间为同步段（无 await），不存在新的交错窗口；置 starting 之前的前置校验
  // 失败路径全程同步段，同样无交错可能（其 makeStartFailure 调用无需世代校验）。
  if (generation !== startGeneration || runtimeStatus !== 'starting') {
    writeWatchLog(
      'INFO',
      stage,
      `开启事务已作废（自检在途期间值守被关闭或被新开启取代）：generation=${generation}/${startGeneration} runtimeStatus=${runtimeStatus}，放弃全部终态写入`,
    );
    return { ok: false, status: runtimeStatus, code: 'ERR_WATCH_START_CANCELLED', message: '开启请求已被关闭操作取消（自检在途期间值守被关闭），服务未进入运行态' };
  }
  if (!selfTest.ok) {
    return makeStartFailure(stage, selfTest.code, selfTest.message, selfTest.detail);
  }

  // ---- 时间游标基线：以启动时刻为基线，不处理历史积压 ----
  resetMemoryState();
  // 缺陷②修复（阶段6 实测）：IMAP INTERNALDATE 只有秒级精度，若基线取毫秒则「同一秒内但晚于基线毫秒」
  // 到达的邮件会被 filterMailsAtOrAfterCursor 永久跳过（漏信）。基线对齐到整秒，宁可重复由去重集合兜底。
  baselineTimeMs = Math.floor(Date.now() / 1000) * 1000;
  sinceTimeMs = baselineTimeMs;
  updateCursorView(settings.watchMailboxAddress, sinceTimeMs);

  // ---- 写回 true（世代已在上方校验通过，本同步段写入权确定）----
  persistWatchEnabled(true);

  runtimeStatus = 'running';
  setWatchRuntimeRunning(true); // send_email 执行层拦截数据源（watch-runtime-flag）
  consecutiveFailures = 0;
  lastError = null;
  // 运行态标志落位后统一通知（声明层装配判定源=isWatchRuntimeRunning）：refreshMainTools
  // 此刻读到 true，send_email 进入 MAIN_TOOLS——自动恢复路径（startWatchService，无 IPC 后置刷新）
  // 同样即时生效；watch:start 路径 ipc 后置 refreshMainTools 与此幂等冗余（无害）。
  notifyRuntimeStateChange();
  writeWatchLog(
    'INFO',
    stage,
    `自检通过：mailbox=${maskMailbox(settings.watchMailboxAddress)} uidvalidity=${selfTest.data.uidvalidity} 时间游标基线=${formatLocalDateTimeFromMs(sinceTimeMs)}（首开不处理历史积压）`,
  );

  // ---- 启动递归定时器（首轮延迟 5 秒）----
  scheduleNextPoll(FIRST_POLL_DELAY_MS);

  // ---- 阶段7 目标5①：客户端重启且值守开关为开 → 重建编号映射并发送续期邮件 ----
  // 仅在自动恢复路径（fromResume=true，等价「客户端重启」）触发；手动开启不重复发信。
  if (fromResume) {
    void publishResumeIndexMapMail(settings).catch((err) => {
      writeWatchLog('ERROR', 'watch.resume', '重启续期邮件处理异常（值守继续运行，不影响轮询）', err);
    });
  }

  return { ok: true, status: 'running' };
}

// ---------------------------------------------------------------------------
// 轮询调度（递归 setTimeout + inFlight 互斥；禁 setInterval）
// ---------------------------------------------------------------------------

function scheduleNextPoll(delayOverrideMs?: number): void {
  if (runtimeStatus !== 'running') {
    return;
  }
  if (pollTimerHandle) {
    clearTimeout(pollTimerHandle);
    pollTimerHandle = null;
  }
  const intervalMs = readNormalizedWatchSettings().watchPollIntervalMinutes * 60_000;
  let delayMs = intervalMs;
  if (delayOverrideMs !== undefined) {
    delayMs = delayOverrideMs;
  } else if (consecutiveFailures > 0) {
    // 指数退避：min(间隔×2^n, 600s)
    delayMs = Math.min(intervalMs * 2 ** consecutiveFailures, BACKOFF_MAX_MS);
  }
  nextPollAt = Date.now() + delayMs;
  pollTimerHandle = setTimeout(() => {
    pollTimerHandle = null;
    void runPollCycle();
  }, delayMs);
}

async function runPollCycle(): Promise<void> {
  try {
    await runPollOnce();
  } catch (err) {
    writeWatchLog('ERROR', 'watch.poll', '轮询异常（未分类，按连续失败计数）', err);
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      fallbackCloseRuntime('ERR_WATCH_INTERNAL', `轮询连续异常 ${consecutiveFailures} 次达到阈值，值守已回落关闭`);
    }
  } finally {
    if (runtimeStatus === 'running') {
      scheduleNextPoll();
    }
  }
}

interface PollCounters {
  fetched: number;
  accepted: number;
  noncommand: number;
  executed: number;
}

interface PollOnceOutcome extends PollCounters {
  ok: boolean;
  errorCode?: string;
  /** 本轮开始时的游标（毫秒） */
  cursorBefore?: number;
  /** 本轮结束后的游标（毫秒，= 本轮开始时间戳） */
  cursorAfter?: number;
}

/** 轮询失败处理：认证类致命错误立即回落关闭；网络/超时类退避，连续 ≥5 次回落关闭 */
function handlePollFailure(counters: PollCounters, failure: MailBridgeFailure): PollOnceOutcome {
  if (failure.stage === 'auth') {
    fallbackCloseRuntime(failure.code, `${failure.message} :: ${failure.detail}`);
    return { ok: false, ...counters, errorCode: failure.code };
  }
  consecutiveFailures += 1;
  writeWatchLog(
    'WARN',
    'watch.poll',
    `连接失败（第 ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} 次，stage=${failure.stage}）：${failure.message} :: ${failure.detail}`,
  );
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    fallbackCloseRuntime(
      'ERR_WATCH_NETWORK',
      `连续失败 ${consecutiveFailures} 次达到阈值（指数退避已至上限），值守已回落关闭；请检查网络后重新开启`,
    );
  }
  return { ok: false, ...counters, errorCode: failure.code };
}

/**
 * 运行期致命错误回落关闭：清定时器、复位运行态、运行态通知刷新、ERROR 日志。
 * 不写 watchEnabled（用户"意图=开"跨重启保留，重启后 startWatchService 自动恢复重试）；
 * UI 开关本就绑 runtimeStatus（watch:status 轮询 5s），回落关闭经轮询即呈现，
 * lastError 同步可供界面 Alert 提示。
 */
function fallbackCloseRuntime(code: string, reason: string): void {
  if (pollTimerHandle) {
    clearTimeout(pollTimerHandle);
    pollTimerHandle = null;
  }
  nextPollAt = null;
  runtimeStatus = 'closed';
  setWatchRuntimeRunning(false);
  notifyRuntimeStateChange();
  lastError = { code, message: reason, at: new Date().toISOString() };
  writeWatchLog('ERROR', 'watch.state', `值守运行期回落关闭（watchEnabled 用户意图保留）：${code} ${reason}`);
}

async function runPollOnce(): Promise<PollOnceOutcome> {
  const counters: PollCounters = { fetched: 0, accepted: 0, noncommand: 0, executed: 0 };
  if (pollInFlight) {
    writeWatchLog('WARN', 'watch.poll', '轮询跳过：上一轮仍在途（inFlight 互斥）');
    return { ok: true, ...counters };
  }
  if (runtimeStatus !== 'running' || sinceTimeMs <= 0) {
    writeWatchLog('WARN', 'watch.poll', `轮询跳过：运行态=${runtimeStatus} 游标=${sinceTimeMs}`);
    return { ok: true, ...counters };
  }

  pollInFlight = true;
  const pollStartedMs = Date.now();
  const cursorBefore = sinceTimeMs;
  try {
    const settings = readNormalizedWatchSettings();
    const bridge = getMailBridgeContext();
    const outcome = await mailImapPollSince(
      {
        mailbox: settings.watchMailboxAddress,
        authCode: settings.watchMailboxAuthCode,
        sinceIso: new Date(cursorBefore).toISOString(),
      },
      bridge,
    );
    if (!outcome.ok) {
      return handlePollFailure(counters, outcome);
    }

    // 时间增量过滤（INTERNALDATE 优先，空则回退 Date 头，仍为空视为需处理）→ 时间升序 → 单轮上限
    const roundMails = sortMailsByTimeAscending(filterMailsAtOrAfterCursor(outcome.data.mails, cursorBefore))
      .slice(0, MAX_MAILS_PER_POLL);
    counters.fetched = roundMails.length;

    for (const mail of roundMails) {
      if (runtimeStatus !== 'running' || !pollInFlight) {
        writeWatchLog(
          'WARN',
          'watch.poll',
          `本轮提前中止（uid=${mail.uid} 未处理）：runtimeStatus=${runtimeStatus} inFlight=${pollInFlight}`,
        );
        break;
      }
      await handleWatchMail(mail, settings, counters);
    }

    consecutiveFailures = 0;
    // 游标推进为本轮开始时间戳：本轮期间到达的邮件留待下一轮（去重集合兜底，不丢不重）
    // 缺陷②修复（同上）：游标对齐到整秒，且只推进到「本轮开始时刻 - 重叠窗口」，
    // 覆盖 IMAP 索引延迟造成的「已投递但暂不可见」情形；下限为本轮运行基线（首开不处理历史积压）。
    const overlapMs = Math.max(POLL_CURSOR_OVERLAP_MS, settings.watchPollIntervalMinutes * 60_000 + 60_000);
    const advancedMs = Math.max(baselineTimeMs, pollStartedMs - overlapMs);
    sinceTimeMs = Math.floor(advancedMs / 1000) * 1000;
    updateCursorView(settings.watchMailboxAddress, sinceTimeMs);

    writeWatchLog(
      'INFO',
      'watch.poll',
      `mailbox=${maskMailbox(settings.watchMailboxAddress)} candidate=${outcome.data.mails.length} `
        + `cursorBefore=${formatLocalDateTimeFromMs(cursorBefore)} cursorAfter=${formatLocalDateTimeFromMs(sinceTimeMs)} `
        + `fetched=${counters.fetched} accepted=${counters.accepted} noncommand=${counters.noncommand} `
        + `executed=${counters.executed} durationMs=${Date.now() - pollStartedMs}`,
    );

    return { ok: true, ...counters, cursorBefore, cursorAfter: sinceTimeMs };
  } finally {
    pollInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// 单封邮件处理（识别 → 非指令判定 → 去重 → 解析 → 执行/回执）
// ---------------------------------------------------------------------------

interface MailHandlingResult {
  /** role_filtered / subject_filtered / sender_rejected / non_command / duplicate_mail /
   *  duplicate_request / parse_failed / executing / executed / execution_failed / receipt_failed
   *  （executing=BUG1 注入已受理、run 异步执行中；终态由 fire-and-forget 回调另行登记） */
  status: string;
  requestId: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  detail?: string;
}

function previewSubject(subject: string): string {
  const clean = (subject || '').replace(/\s+/g, ' ').trim();
  return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean || '（无主题）';
}

/** 每封邮件必须写一行日志：uid + status + requestId（可空）+ subject 预览 */
function logMailHandling(mail: FetchedWatchMail, result: MailHandlingResult): void {
  const detailText = result.detail ? ` detail=${result.detail}` : '';
  writeWatchLog(
    result.level,
    'watch.poll',
    `uid=${mail.uid} status=${result.status} requestId=${result.requestId || '-'} subject=${previewSubject(mail.subject)}${detailText}`,
  );
}

/** 解析失败场景尽力提取 request_id（用于失败回执主题/头回带；提取失败返回 null） */
function extractLooseRequestId(bodyText: string): string | null {
  const jsonMatch = /"request_id"\s*:\s*"([A-Za-z0-9_-]{1,64})"/.exec(bodyText);
  if (jsonMatch) {
    return jsonMatch[1];
  }
  const cliMatch = /^[ \t]*--request[ \t]+([A-Za-z0-9_-]{1,64})[ \t]*$/im.exec(bodyText);
  return cliMatch ? cliMatch[1] : null;
}

async function handleWatchMail(
  mail: FetchedWatchMail,
  settings: NormalizedWatchSettings,
  counters: PollCounters,
): Promise<void> {
  let result: MailHandlingResult;
  try {
    result = await processWatchMail(mail, settings, counters);
  } catch (err) {
    // 单封异常不得中断整轮：记录后跳过（游标继续推进，下一轮由去重集合兜底）
    writeWatchLog('ERROR', 'watch.poll', `uid=${mail.uid} 单封处理异常（已跳过，游标继续推进）`, err);
    result = {
      status: 'internal_error',
      requestId: '',
      level: 'ERROR',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  pushMemoryRecord({
    atIso: new Date().toISOString(),
    uid: mail.uid,
    messageId: mail.messageId,
    status: result.status,
    requestId: result.requestId,
    subject: mail.subject,
  });
  logMailHandling(mail, result);
}

async function processWatchMail(
  mail: FetchedWatchMail,
  settings: NormalizedWatchSettings,
  counters: PollCounters,
): Promise<MailHandlingResult> {
  // 腾讯必改写 Message-ID：去重/In-Reply-To 一律使用取回实际值；空值以 UID 造确定性键
  const messageId = mail.messageId || `<no-message-id-uid-${mail.uid}@delepi.watch>`;

  // ① 回执环特征一：X-Delepi-Role 头
  if (mail.delepiRole) {
    return { status: 'role_filtered', requestId: '', level: 'WARN', detail: `X-Delepi-Role=${mail.delepiRole}` };
  }

  // ② 回执环特征二：主题前缀（BUG2 并列候选修复：客户端回复未改写主题、主题仍以回执前缀开头时，
  //    原实现会静默拦截——增加二次判定：正文命中指令标记、或 In-Reply-To 命中出站邮件映射
  //    （BUG3 回复关联），且 From 非空且≠值守邮箱自身的邮件放行至后续处理；值守邮箱自身的
  //    出站回执仍被拦截（防自环；①的 X-Delepi-Role 头为第一道保险））
  if (mail.subject.startsWith(RECEIPT_SUBJECT_PREFIX)) {
    const selfMailbox = (settings.watchMailboxAddress || '').trim().toLowerCase();
    const fromSelf = Boolean(mail.fromAddress) && mail.fromAddress.trim().toLowerCase() === selfMailbox;
    const outboundHit = mail.inReplyTo ? resolveOutboundConversationByMessageId(mail.inReplyTo) : null;
    if (fromSelf || (!detectCommandMarkers(mail.bodyText) && !outboundHit)) {
      return { status: 'subject_filtered', requestId: '', level: 'WARN', detail: '主题前缀 [Delepi回执]' };
    }
    writeWatchLog(
      'INFO',
      'watch.poll',
      `uid=${mail.uid} 主题命中回执前缀但正文含指令标记/命中出站映射且非值守邮箱自身，放行至后续处理（BUG2 二次判定）`,
    );
  }

  // ③ From 头缺失防御：为空或解析失败即跳过（不可判定来源）
  if (!mail.fromAddress) {
    return { status: 'sender_rejected', requestId: '', level: 'WARN', detail: 'From 头为空或解析失败' };
  }

  // ③.5 出站回复关联（BUG3 修复）：In-Reply-To 命中出站邮件映射 → 提取用户手写正文注入
  //     原对话（等同在当前对话输入该消息）；未命中映射则继续 ④ 指令判定（非指令正文
  //     维持 non_command 静默忽略，防误注入）
  if (mail.inReplyTo) {
    const outboundHit = resolveOutboundConversationByMessageId(mail.inReplyTo);
    if (outboundHit) {
      return executeReplyMappedInjection(mail, settings, counters, messageId, outboundHit.conversationId);
    }
  }

  // ④ 指令 / 非指令区分：非指令静默忽略，且不发送任何回执（与旧行为的关键差异）
  if (!detectCommandMarkers(mail.bodyText)) {
    counters.noncommand += 1;
    return { status: 'non_command', requestId: '', level: 'INFO', detail: '非指令邮件，静默忽略（不回执）' };
  }
  counters.accepted += 1;

  // ⑤ 邮件级去重（同一封邮件重复出现在候选集里不重复执行）
  if (processedMessageIds.has(messageId)) {
    return { status: 'duplicate_mail', requestId: '', level: 'WARN', detail: `messageId 已处理` };
  }
  rememberProcessedId(processedMessageIds, messageId, PROCESSED_MESSAGE_IDS_LIMIT);

  // ⑥ 解析指令
  const startedAtIso = new Date().toISOString();
  const parse = parseWatchCommand(mail.bodyText);
  if (!parse.ok) {
    const looseRequestId = extractLooseRequestId(mail.bodyText);
    const receipt = await sendFailureReceipt({
      settings,
      requestId: looseRequestId,
      commandLabel: '（解析期失败）',
      code: parse.code,
      message: parse.message,
      advice: '请按命令行协议修正指令正文后，换用新的请求号重发（示例：--list 或 --conversation 3 --message 内容）',
      startedAtIso,
      inReplyTo: messageId,
      uid: mail.uid,
    });
    return {
      status: 'parse_failed',
      requestId: looseRequestId ?? '',
      level: receipt.ok ? 'WARN' : 'ERROR',
      detail: `${parse.code}${receipt.ok ? ' 已发送失败回执' : ' 失败回执发送失败'}`,
    };
  }
  if (parse.warnings.length > 0) {
    writeWatchLog(
      'WARN',
      'watch.command',
      `uid=${mail.uid} 指令解析告警 ${parse.warnings.length} 条（不影响执行）`,
      parse.warnings.join('; '),
    );
  }

  const command = parse.command;

  // ⑦ 业务级去重：request_id 已处理 → 不重复执行、不重发缓存回执
  if (processedRequestIds.has(command.requestId)) {
    const previous = findMemoryRecordByRequestId(command.requestId);
    return {
      status: 'duplicate_request',
      requestId: command.requestId,
      level: 'WARN',
      detail: `未重复执行、未重发回执（previousStatus=${previous?.status ?? '-'} previousAt=${previous?.atIso ?? '-'}）`,
    };
  }
  rememberProcessedId(processedRequestIds, command.requestId, PROCESSED_REQUEST_IDS_LIMIT);

  // ⑧ 执行（三类指令：查询 / 已有对话发消息 / 新建对话并发消息）
  counters.executed += 1;
  processedCount += 1;
  if (command.type === 'list_conversations') {
    return executeListCommand(command, settings, startedAtIso, messageId, mail.uid);
  }
  if (command.type === 'new_conversation') {
    return executeNewConversationCommand(
      command,
      settings,
      startedAtIso,
      messageId,
      mail.fromAddress,
      mail.uid,
      mail.subject,
    );
  }
  return executeSendCommand(command, settings, startedAtIso, messageId, mail.fromAddress, mail.uid, mail.subject);
}

/** 查询指令执行：取全量 → 按现有排序取前 limit → 1..N 重编号 → 映射落盘 → HTML + JSON 附件回执 */
async function executeListCommand(
  command: ListConversationsCommand,
  settings: NormalizedWatchSettings,
  startedAtIso: string,
  messageId: string,
  uid: number,
): Promise<MailHandlingResult> {
  const allRows = listConversations();
  const rows = allRows.slice(0, command.limit);
  const items: ConversationIndexMapItem[] = rows.map((row, index) => ({
    index: index + 1,
    conversationId: row.id,
    title: row.title,
    isRunning: row.isRunning,
    updatedAt: row.updatedAt,
  }));

  const finishedAtIso = new Date().toISOString();
  const attachmentFileName = `delepi-conversations-${command.requestId}.json`;
  const attachmentPayload = `${JSON.stringify({ requestId: command.requestId, createdAt: finishedAtIso, items }, null, 2)}\n`;
  const html = buildListConversationsReceiptHtml(
    command,
    items,
    allRows.length,
    startedAtIso,
    finishedAtIso,
    attachmentFileName,
  );

  const sendOutcome = await sendWatchReceiptWithRetry({
    to: settings.watchReceiptRecipient || settings.watchMailboxAddress,
    subject: `${RECEIPT_SUBJECT_PREFIX} ${command.requestId} 成功｜对话列表（1-${items.length}）`,
    html,
    inReplyTo: messageId,
    requestId: command.requestId,
    attachments: [
      {
        fileName: attachmentFileName,
        content: Buffer.from(attachmentPayload, 'utf8'),
        contentType: 'application/json; charset=UTF-8',
      },
    ],
  });

  if (!sendOutcome.ok) {
    writeWatchLog(
      'ERROR',
      'watch.receipt',
      `uid=${uid} requestId=${command.requestId} command=list_conversations errorCode=ERR_WATCH_SEND_FAILED 回执发送失败（重试 3 次后放弃），本条未写入编号映射`,
      sendOutcome.detail,
    );
    return {
      status: 'receipt_failed',
      requestId: command.requestId,
      level: 'ERROR',
      detail: `list_conversations 已生成 ${items.length} 条但回执发送失败`,
    };
  }

  // 只有回执真正送达才落映射：避免用户没收到编号却覆盖 latest.json，导致后续编号指令打错会话
  try {
    saveConversationIndexMap({ requestId: command.requestId, createdAtIso: finishedAtIso, items });
    writeWatchLog(
      'INFO',
      'watch.receipt',
      `uid=${uid} requestId=${command.requestId} command=list_conversations receiptChannel=service_direct rows=${items.length}/${allRows.length} `
        + `attachment=${attachmentFileName} 编号映射已写入（内存 + 文件 + latest.json）`,
    );
    return {
      status: 'executed',
      requestId: command.requestId,
      level: 'INFO',
      detail: `list_conversations rows=${items.length}/${allRows.length} 回执已直发（HTML + JSON 附件）`,
    };
  } catch (err) {
    writeWatchLog(
      'ERROR',
      'watch.receipt',
      `uid=${uid} requestId=${command.requestId} 编号映射写入失败（回执已送达，编号指令将因缺映射而失败）`,
      err,
    );
    return {
      status: 'executed',
      requestId: command.requestId,
      level: 'ERROR',
      detail: `list_conversations 回执已发送但编号映射写入失败 rows=${items.length}`,
    };
  }
}

/** 推送「指令已接受 → 请切到目标会话」事件（阶段7 目标5②） */
function emitCommandNavigation(payload: WatchCommandNavigationPayload): void {
  try {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_WATCH.COMMAND_NAVIGATE, payload);
      }
    }
    writeWatchLog(
      'INFO',
      'watch.navigate',
      `requestId=${payload.requestId} command=${payload.commandType} conversationId=${payload.conversationId} `
        + `windows=${windows.length} 已推送会话跳转事件`,
    );
  } catch (err) {
    // 推送失败不影响指令执行（跳转是界面增强，不是执行前置条件）
    writeWatchLog('WARN', 'watch.navigate', '指令跳转事件推送失败（不影响指令执行）', err);
  }
}

/**
 * 注入执行参数（injectAndClassifyRun 与 BUG3 出站映射命中分支共用）
 */
interface InjectRunParams {
  conversationId: string;
  requestId: string;
  message: string;
  commandLabel: string;
  settings: NormalizedWatchSettings;
  messageId: string;
  fromAddress: string;
  uid: number;
  startedAtIso: string;
  logContext: string;
  /** 邮件主题（终态内存记录与日志用） */
  subject: string;
}

/**
 * fire-and-forget 注入执行体：构造 run 实例私有的指令上下文后不 await 注入终态立即返回——
 * 不阻塞轮询循环与同批后续邮件处理；run 终态经 finalizeInjectRunOutcome 回调登记（读 run
 * 实例持有的上下文、登记结果、触发兜底回执判定）；.catch 全覆盖（含进程退出前在途链路），
 * 保证不产生未处理 Promise 拒绝。
 * 上下文所有者=run 实例（对齐 RuntimeSettingsSnapshot 先例）——对象由本闭包独占创建，
 * 随 sendUserMessageIntoConversation → runMainAgent → executeSendEmailTool 调用链传递，send-email
 * 在同一对象上直接标记回执观测字段；同会话第二条注入各自持有独立对象，互不覆盖、无误删；run
 * 终态后随实例消亡，无全局表可污染。闸门失败（会话运行中）时对象从未被任何 run 消费，天然无副作用。
 */
function launchInjectRunInBackground(params: InjectRunParams): void {
  const commandContext: WatchCommandContext = {
    requestId: params.requestId,
    commandMessageId: params.messageId,
    from: params.fromAddress,
    receiptRecipient: params.settings.watchReceiptRecipient || params.settings.watchMailboxAddress,
    receiptSentByAgent: false,
    receiptSentTo: '',
    receiptSentMessageId: '',
    receiptAttachmentCount: 0,
  };

  void sendUserMessageIntoConversation(params.conversationId, params.message, { watchCommandContext: commandContext })
    .then((sendOutcome) => finalizeInjectRunOutcome(params, commandContext, sendOutcome))
    .catch((err: unknown) => {
      // 防御性兜底：sendUserMessageIntoConversation 与 finalize 均已内部收敛，此处仍全覆盖；
      // 上下文为闭包私有对象，无需（也无从）清除任何共享状态
      writeWatchLog(
        'ERROR',
        'watch.command',
        `uid=${params.uid} requestId=${params.requestId} ${params.logContext} 注入链路未捕获异常（防御兜底，run 私有指令上下文随闭包废弃）`,
        err,
      );
    });
}

/**
 * 注入 run 终态回调（BUG1/BUG2）：读清指令上下文、登记终态结果、兜底回执判定。
 * - 成功：登记 executed（receiptChannel 观测语义保留）
 * - 注入前协议层失败（会话运行中/主模型未配置）：直发失败回执（原语义移至异步回调）
 * - 执行期失败（ERR_WATCH_EXEC_ABORTED 含 30 分钟硬超时 / ERR_WATCH_EXEC_FAILED，BUG2 修复）：
 *   模型未发出回执（receiptSentByAgent !== true）→ 服务端兜底直发失败回执（主题保持
 *   [Delepi回执] 前缀防环、内容含失败码）；模型已发过回执则不重复直发（防重发）
 * commandContext 为 launchInjectRunInBackground 创建的 run 私有对象（闭包直传），
 * receiptSentByAgent 由 send-email 在同一对象上置位——防重发判定不依赖任何全局表。
 */
async function finalizeInjectRunOutcome(
  params: InjectRunParams,
  commandContext: WatchCommandContext,
  sendOutcome: Awaited<ReturnType<typeof sendUserMessageIntoConversation>>,
): Promise<void> {

  if (sendOutcome.ok) {
    const agentReceiptSent = commandContext.receiptSentByAgent === true;
    writeWatchLog(
      'INFO',
      'watch.command',
      `uid=${params.uid} requestId=${params.requestId} ${params.logContext} 注入执行成功 `
        + `receiptChannel=${agentReceiptSent ? 'agent_send_email' : 'none（模型未回执，成功路径无服务端兜底）'} `
        + `contentChars=${sendOutcome.content.length} durationMs=${sendOutcome.durationMs} inReplyTo=${params.messageId}`,
    );
    pushMemoryRecord({
      atIso: new Date().toISOString(),
      uid: params.uid,
      messageId: params.messageId,
      status: 'executed',
      requestId: params.requestId,
      subject: params.subject,
    });
    return;
  }

  if (
    sendOutcome.code === 'ERR_WATCH_CONVERSATION_RUNNING'
    || sendOutcome.code === 'ERR_WATCH_MAIN_MODEL_NOT_CONFIGURED'
  ) {
    // 注入前失败：主智能体未被唤醒，无主轨可兜底 → 协议层失败直发失败回执
    const receipt = await sendFailureReceipt({
      settings: params.settings,
      requestId: params.requestId,
      commandLabel: params.commandLabel,
      code: sendOutcome.code,
      message: sendOutcome.message,
      advice: '请在目标对话空闲 / 主模型配置完成后，换用新的请求号重发同一指令',
      startedAtIso: params.startedAtIso,
      inReplyTo: params.messageId,
      uid: params.uid,
    });
    writeWatchLog(
      'ERROR',
      'watch.command',
      `uid=${params.uid} requestId=${params.requestId} ${params.logContext} 注入前失败（${sendOutcome.code}${receipt.ok ? '；已发送失败回执' : '；失败回执发送失败'}）`,
      sendOutcome.message,
    );
    pushMemoryRecord({
      atIso: new Date().toISOString(),
      uid: params.uid,
      messageId: params.messageId,
      status: 'execution_failed',
      requestId: params.requestId,
      subject: params.subject,
    });
    return;
  }

  // 执行期失败（run 已启动：异常/中止/30 分钟硬超时）——BUG2 修复：兜底回执判定
  const agentReceiptSent = commandContext.receiptSentByAgent === true;
  if (agentReceiptSent) {
    // 模型已发过回执：不重复直发，仅记日志（防重发）
    writeWatchLog(
      'ERROR',
      'watch.command',
      `uid=${params.uid} requestId=${params.requestId} ${params.logContext} 执行期失败（${sendOutcome.code}）但主智能体已发出回执（receiptSentByAgent=true），服务端不重复直发`,
      sendOutcome.message,
    );
  } else {
    // 模型未发出回执：服务端兜底直发失败回执（主题保持 [Delepi回执] 前缀防环、内容含失败码）
    const receipt = await sendFailureReceipt({
      settings: params.settings,
      requestId: params.requestId,
      commandLabel: params.commandLabel,
      code: sendOutcome.code,
      message: `${sendOutcome.message}（主智能体未发出回执，本回执由值守服务兜底直发）`,
      advice: '指令消息已注入目标对话，但本轮执行未完成（含 30 分钟硬超时中止可能）；可在客户端查看对话进度，或换用新的请求号重发。',
      startedAtIso: params.startedAtIso,
      inReplyTo: params.messageId,
      uid: params.uid,
    });
    writeWatchLog(
      'ERROR',
      'watch.command',
      `uid=${params.uid} requestId=${params.requestId} ${params.logContext} 执行期失败（${sendOutcome.code}，模型未回执）→ 服务端兜底直发失败回执${receipt.ok ? '成功' : '失败'}`,
      sendOutcome.message,
    );
  }
  pushMemoryRecord({
    atIso: new Date().toISOString(),
    uid: params.uid,
    messageId: params.messageId,
    status: 'execution_failed',
    requestId: params.requestId,
    subject: params.subject,
  });
}

/**
 * 注入消息并立即返回受理结果（send_message 与 new_conversation 共用；单轨语义集中在此）。
 * BUG1 修复：不 await 注入终态（fire-and-forget），轮询循环与同批后续邮件处理不被阻塞；
 * run 终态由 finalizeInjectRunOutcome 异步登记；list_conversations 不走本函数（保持同轮
 * 同步快速直发，现状语义）。
 */
async function injectAndClassifyRun(params: InjectRunParams): Promise<MailHandlingResult> {
  launchInjectRunInBackground(params);
  return {
    status: 'executing',
    requestId: params.requestId,
    level: 'INFO',
    detail: `${params.commandLabel} 注入已受理（fire-and-forget，run 终态后异步登记）`,
  };
}

/** BUG3：主流客户端引用块标记（分隔行 / 「在xxx写道：」 / Outlook 头块）——保守匹配，
 * 宁可少剥离不可误删用户正文；行首「>」引用前缀在 extractHandwrittenReplyBody 内逐行判定 */
const REPLY_QUOTE_SEPARATOR_RE = /^\s*-{2,}\s*(原始邮件|回复邮件|转发邮件|Original Message|Forwarded message|Forwarded Message)\s*-{2,}\s*$/i;
const REPLY_QUOTE_ATTRIBUTION_RE = /^.{0,120}?(写道|wrote)\s*[:：]\s*$/i;
const REPLY_OUTLOOK_HEADER_RE = /^\s*(发件人|From)\s*[:：]/i;

/**
 * BUG3：从回复邮件正文提取用户手写内容（保守策略）。
 * 顺序：① 剥离引用块（首个引用标记行之前的全部内容；无引用标记则全文）；
 * ② 剥离后的手写部分可解析出 --message 指令（parseWatchCommand 成功且类型带 message）
 * → 取指令消息值（用户按指令格式回复）；否则返回剥离后的手写全文。
 * 剥离后为空（用户纯引用无手写内容）返回空串，由调用方静默跳过。
 */
function extractHandwrittenReplyBody(bodyText: string): string {
  const body = typeof bodyText === 'string' ? bodyText : '';
  if (!body.trim()) {
    return '';
  }

  // ① 剥离引用块：首个引用标记行（分隔行/署名行/Outlook 头块/行首 > 前缀）之前的内容
  let handwritten = body.trim();
  const lines = body.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (
      REPLY_QUOTE_SEPARATOR_RE.test(line)
      || REPLY_QUOTE_ATTRIBUTION_RE.test(line)
      || REPLY_OUTLOOK_HEADER_RE.test(line)
      || /^\s*>/.test(line)
    ) {
      handwritten = lines.slice(0, i).join('\n').trim();
      break;
    }
  }

  // ② 手写部分含 --message 指令 → 取指令消息值（引用块中的示例行已在 ① 被剥离，不干扰）
  const parse = parseWatchCommand(handwritten);
  if (parse.ok && (parse.command.type === 'new_conversation' || parse.command.type === 'send_message')) {
    return parse.command.message;
  }
  return handwritten;
}

/**
 * BUG3：出站映射命中的回复邮件 → 注入原对话（等同在当前对话输入该消息）。
 * - 正文含 --message 指令时取其值；否则剥离引用取全文；空正文静默跳过（不注入不回执）
 * - 目标会话已删除：静默跳过（本分支无指令请求语义，不产生回执噪音）
 * - 随 run 传递指令上下文（run 私有对象，requestId 自动生成）：后续 run 中模型调用 send_email
 *   可回带 In-Reply-To=本回复邮件 Message-ID（邮件线程闭环；新出站邮件同样登记映射，用户再回复仍可命中）
 * - 注入走 fire-and-forget（与 BUG1 注入类指令同策略，不阻塞轮询循环）
 */
async function executeReplyMappedInjection(
  mail: FetchedWatchMail,
  settings: NormalizedWatchSettings,
  counters: PollCounters,
  messageId: string,
  conversationId: string,
): Promise<MailHandlingResult> {
  // 邮件级去重（与 ⑤ 同集合：同封回复邮件重复取回不重复注入）
  if (processedMessageIds.has(messageId)) {
    return { status: 'duplicate_mail', requestId: '', level: 'WARN', detail: 'messageId 已处理（出站映射分支）' };
  }
  rememberProcessedId(processedMessageIds, messageId, PROCESSED_MESSAGE_IDS_LIMIT);

  // 目标会话存在校验（映射登记后对话可能已被删除——静默跳过，无指令请求语义不发回执）
  const targetConversation = getConversationById(conversationId);
  if (!targetConversation) {
    counters.noncommand += 1;
    writeWatchLog(
      'WARN',
      'watch.command',
      `uid=${mail.uid} 出站映射命中但目标对话已删除 conversationId=${conversationId}，静默跳过（不注入不回执）`,
    );
    return { status: 'non_command', requestId: '', level: 'WARN', detail: '出站映射命中但目标对话已删除，静默跳过' };
  }

  // 提取用户手写正文：正文含 --message 指令时取其值；否则剥离引用取全文
  const message = extractHandwrittenReplyBody(mail.bodyText);
  if (!message) {
    counters.noncommand += 1;
    writeWatchLog(
      'WARN',
      'watch.command',
      `uid=${mail.uid} 出站映射命中但剥离引用后正文为空（用户纯引用无手写内容），静默跳过（不注入）`,
    );
    return { status: 'non_command', requestId: '', level: 'INFO', detail: '出站映射命中但正文为空，静默跳过' };
  }

  const startedAtIso = new Date().toISOString();
  const requestId = generateRequestId();
  writeWatchLog(
    'INFO',
    'watch.command',
    `uid=${mail.uid} requestId=${requestId} command=reply_mapped 解析成功 conversationId=${conversationId} `
      + `messageChars=${message.length}（等同在当前对话输入该消息，零加工注入）`,
  );

  // 推送跳转事件（前端切到原对话；commandType 复用 send_message 语义=向已有对话发消息）
  emitCommandNavigation(buildCommandNavigationPayload({
    conversationId,
    conversationTitle: targetConversation.title,
    commandType: 'send_message',
    requestId,
    subject: mail.subject,
    receivedAtIso: startedAtIso,
  }));

  counters.accepted += 1;
  counters.executed += 1;
  processedCount += 1;

  launchInjectRunInBackground({
    conversationId,
    requestId,
    message,
    commandLabel: 'reply_mapped（回复智能体邮件→注入原对话）',
    settings,
    messageId,
    fromAddress: mail.fromAddress,
    uid: mail.uid,
    startedAtIso,
    logContext: 'command=reply_mapped',
    subject: mail.subject,
  });

  return {
    status: 'executing',
    requestId,
    level: 'INFO',
    detail: `出站映射命中，注入原对话 message=${message.length}字符（fire-and-forget，run 终态后异步登记）`,
  };
}

/**
 * 发消息指令执行：编号/UUID 严格解析 → 推送跳转事件 → 注入 → run 终态。
 * 编号缺失/越界、会话已删除一律失败回执且**不推送跳转**（没有目标会话可切）。
 */
async function executeSendCommand(
  command: SendMessageCommand,
  settings: NormalizedWatchSettings,
  startedAtIso: string,
  messageId: string,
  fromAddress: string,
  uid: number,
  subject: string,
): Promise<MailHandlingResult> {
  const ref = command.conversationRef;

  // 编号模式：严格按最新映射表解析；缺失/越界立即失败回执并中止（不猜测、不模糊匹配）
  let conversationId: string | null = null;
  if (ref.kind === 'id') {
    conversationId = ref.id;
  } else {
    conversationId = resolveConversationIdByIndex(ref.index);
  }

  if (!conversationId) {
    const reason = ref.kind === 'index'
      ? `编号 ${ref.index} 不在最新编号映射中（编号会随对话列表变化）`
      : `conversation-id ${ref.id} 无法解析为本地对话`;
    const receipt = await sendFailureReceipt({
      settings,
      requestId: command.requestId,
      commandLabel: 'send_message（按编号发送）',
      code: 'ERR_WATCH_CONVERSATION_INDEX_NOT_FOUND',
      message: `${reason}；请先发送 --list 查询对话列表获取最新编号`,
      advice: '回复本邮件发送一行 --list，收到最新列表回执（附件为编号对照）后，再用 --conversation <编号> --message <内容> 重发',
      startedAtIso,
      inReplyTo: messageId,
      uid,
    });
    return {
      status: 'execution_failed',
      requestId: command.requestId,
      level: 'ERROR',
      detail: `${reason}${receipt.ok ? '；已发送失败回执' : '；失败回执发送失败'}`,
    };
  }

  // 会话存在校验（映射可能来自更早的列表快照，对话可能已被删除）
  const targetConversation = getConversationById(conversationId);
  if (!targetConversation) {
    const receipt = await sendFailureReceipt({
      settings,
      requestId: command.requestId,
      commandLabel: 'send_message',
      code: 'ERR_WATCH_CONVERSATION_NOT_FOUND',
      message: '目标对话已不存在；请先发送 --list 查询对话列表获取最新编号',
      advice: '回复 --list 获取最新编号后重发',
      startedAtIso,
      inReplyTo: messageId,
      uid,
    });
    return {
      status: 'execution_failed',
      requestId: command.requestId,
      level: 'ERROR',
      detail: `目标对话不存在${receipt.ok ? '；已发送失败回执' : '；失败回执发送失败'}`,
    };
  }

  writeWatchLog(
    'INFO',
    'watch.command',
    `uid=${uid} requestId=${command.requestId} command=send_message 解析成功 `
      + `ref=${ref.kind === 'index' ? `index:${ref.index}` : 'id'} conversationId=${conversationId} `
      + `messageChars=${command.message.length}（消息原文零加工注入）`,
  );

  // 阶段7 目标5②：解析成功且目标会话确定 → 推送跳转（四类过滤邮件在 ①~④ 步已返回，永不至此）
  emitCommandNavigation(buildCommandNavigationPayload({
    conversationId,
    conversationTitle: targetConversation.title,
    commandType: 'send_message',
    requestId: command.requestId,
    subject,
    receivedAtIso: startedAtIso,
  }));

  return injectAndClassifyRun({
    conversationId,
    requestId: command.requestId,
    message: command.message,
    commandLabel: 'send_message',
    settings,
    messageId,
    fromAddress,
    uid,
    startedAtIso,
    logContext: 'command=send_message',
    subject,
  });
}

/**
 * 新建对话指令执行（阶段7 目标4②）：createConversation() 新建会话 → 推送跳转（前端切到新会话）
 * → 在新会话内注入消息。新会话无模型方案绑定，注入时按 resolver 懒绑定当前激活方案。
 */
async function executeNewConversationCommand(
  command: NewConversationCommand,
  settings: NormalizedWatchSettings,
  startedAtIso: string,
  messageId: string,
  fromAddress: string,
  uid: number,
  subject: string,
): Promise<MailHandlingResult> {
  const created = createConversation();
  writeWatchLog(
    'INFO',
    'watch.command',
    `uid=${uid} requestId=${command.requestId} command=new_conversation 已新建对话 conversationId=${created.id} `
      + `messageChars=${command.message.length}（消息原文零加工注入）`,
  );

  emitCommandNavigation(buildCommandNavigationPayload({
    conversationId: created.id,
    conversationTitle: created.title,
    commandType: 'new_conversation',
    requestId: command.requestId,
    subject,
    receivedAtIso: startedAtIso,
  }));

  return injectAndClassifyRun({
    conversationId: created.id,
    requestId: command.requestId,
    message: command.message,
    commandLabel: 'new_conversation',
    settings,
    messageId,
    fromAddress,
    uid,
    startedAtIso,
    logContext: 'command=new_conversation',
    subject,
  });
}

// ---------------------------------------------------------------------------
// 阶段7 目标5①：重启续期（重建编号映射 + 发送带 JSON 附件的新邮件）
// ---------------------------------------------------------------------------

/** 续期邮件正文（HTML）：只做说明与表格提示，**不写以 -- 行首的示例行**，避免用户整段引用回复时误触指令 */
function buildResumeIndexMapHtml(params: {
  requestId: string;
  createdAtIso: string;
  items: ConversationIndexMapItem[];
  total: number;
  attachmentFileName: string;
}): string {
  const tableRows = params.items.length > 0
    ? params.items.map((item) => [
      '<tr>',
      `<td class="num">${item.index}</td>`,
      `<td>${escapeHtml(item.title || '（无标题）')}</td>`,
      `<td>${item.isRunning ? '运行中' : '空闲'}</td>`,
      `<td>${escapeHtml(formatLocalDateTime(item.updatedAt))}</td>`,
      '</tr>',
    ].join(''))
    : ['<tr><td colspan="4">当前没有对话</td></tr>'].join('');

  const head = buildReceiptHeadHtml(
    {
      commandLabel: 'resume_index_map（值守重启续期）',
      requestId: params.requestId,
      startedAtIso: params.createdAtIso,
      finishedAtIso: params.createdAtIso,
      resultLabel: '成功',
    },
    [
      `返回条数：${params.items.length}（共 ${params.total} 条）`,
      `附件：${escapeHtml(params.attachmentFileName)}（编号与对话 GUID 的完整对照）`,
    ],
  );

  return wrapHtmlDocument('Delepi 值守续期 · 对话编号映射', [
    head,
    '<h3>为什么收到这封邮件</h3>',
    '<p>Delepi 刚刚重启，值守开关仍处于开启状态。重启后编号映射已按当前对话列表重建并写入本地缓存，'
      + '本邮件把这份映射作为附件发给你，方便你继续按编号发指令。</p>',
    '<h3>当前对话列表（编号可直接用于发消息）</h3>',
    '<table>',
    '<thead><tr><th>编号</th><th>标题</th><th>状态</th><th>最近更新</th></tr></thead>',
    `<tbody>${tableRows}</tbody>`,
    '</table>',
    '<p class="tip">正文只显示编号，不显示完整对话 GUID；编号与 GUID 的对照见 JSON 附件。</p>',
    '<h3>怎么用</h3>',
    '<p>回复本邮件，把下面这行写进正文（编号换成上表任意编号，内容换成你要发的消息）：</p>',
    '<p><code>conversation 编号 + message 内容</code> 对应的实际写法为：行首两个连字符加 conversation、空格、编号，'
      + '再接两个连字符加 message 与内容（示例见历史 --list 回执）。</p>',
    '<p class="tip">若只想新建一个对话并在其中执行消息，正文里只写 message 参数即可（不需要编号）。</p>',
  ].join('\n'));
}

/**
 * 续期邮件草稿（纯函数构造，便于受控断言「附件=缓存 JSON」「主题/正文形态」）：
 * - 主题：`[Delepi回执] <RESUME-...> 值守重启续期｜对话编号映射（1-N）`（复用回执前缀，双保险防回执环）
 * - 附件：`delepi-conversations-<RESUME-...>.json`，内容=与 latest.json 完全一致的映射 JSON（含 GUID）
 */
export interface ResumeIndexMapMailDraft {
  requestId: string;
  subject: string;
  html: string;
  attachmentFileName: string;
  attachmentContent: string;
}

/** 构造续期邮件草稿（requestId 由调用方给定；items 顺序即编号顺序） */
export function buildResumeIndexMapMailDraft(params: {
  requestId: string;
  createdAtIso: string;
  items: ConversationIndexMapItem[];
  total: number;
}): ResumeIndexMapMailDraft {
  const attachmentFileName = `delepi-conversations-${params.requestId}.json`;
  const attachmentContent = `${JSON.stringify(
    { requestId: params.requestId, createdAtIso: params.createdAtIso, items: params.items },
    null,
    2,
  )}\n`;
  const html = buildResumeIndexMapHtml({
    requestId: params.requestId,
    createdAtIso: params.createdAtIso,
    items: params.items,
    total: params.total,
    attachmentFileName,
  });
  return {
    requestId: params.requestId,
    subject: `${RECEIPT_SUBJECT_PREFIX} ${params.requestId} 值守重启续期｜对话编号映射（1-${params.items.length}）`,
    html,
    attachmentFileName,
    attachmentContent,
  };
}

/**
 * 重启续期：按当前对话列表重建编号映射（写入缓存 JSON + latest.json），并发送带该 JSON 附件的新邮件。
 * - 触发条件：客户端重启且 watchEnabled=true（由 performStart(fromResume=true) 调用）
 * - 失败行为：映射写入失败/邮件发送失败都只记 ERROR 日志，**不阻断值守运行**（轮询照常）
 */
export async function publishResumeIndexMapMail(settings: NormalizedWatchSettings): Promise<void> {
  const createdAtIso = new Date().toISOString();
  const requestId = buildResumeRequestId();
  let items: ConversationIndexMapItem[] = [];
  let total = 0;
  try {
    const allRows = listConversations();
    total = allRows.length;
    const map = buildConversationIndexMap(requestId, createdAtIso, allRows, RESUME_INDEX_MAP_LIMIT);
    items = map.items;
    saveConversationIndexMap(map);
    writeWatchLog(
      'INFO',
      'watch.resume',
      `requestId=${requestId} 重启编号映射已重建并写入缓存（rows=${items.length}/${total}，latest.json 已更新）`,
    );
  } catch (err) {
    writeWatchLog('ERROR', 'watch.resume', '重启编号映射重建/写入失败（续期邮件跳过）', err);
    return;
  }

  const draft = buildResumeIndexMapMailDraft({ requestId, createdAtIso, items, total });
  const outcome = await sendWatchReceiptWithRetry({
    to: settings.watchReceiptRecipient || settings.watchMailboxAddress,
    subject: draft.subject,
    html: draft.html,
    inReplyTo: '',
    requestId,
    attachments: [
      {
        fileName: draft.attachmentFileName,
        content: Buffer.from(draft.attachmentContent, 'utf8'),
        contentType: 'application/json; charset=UTF-8',
      },
    ],
  });

  if (outcome.ok) {
    writeWatchLog(
      'INFO',
      'watch.resume',
      `requestId=${requestId} 重启续期邮件已发送 receiptChannel=service_direct rows=${items.length} `
        + `attachment=${draft.attachmentFileName}`,
    );
    return;
  }
  writeWatchLog(
    'ERROR',
    'watch.resume',
    `requestId=${requestId} 重启续期邮件发送失败（编号映射已在本地生效，用户需先发 --list 获取编号）`,
    outcome.detail,
  );
}

/** 续期请求号：RESUME-<yyyyMMddHHmmss>-<4 位大写字母数字>（字符集满足 REQUEST_ID_RE） */
function buildResumeRequestId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 4; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `RESUME-${stamp}-${suffix}`;
}

// ---------------------------------------------------------------------------
// 对外接口（watch:start / watch:stop / watch:status）
// ---------------------------------------------------------------------------

/** 开启值守：本地校验 → 真实自检（IMAP+SMTP）→ 时间游标基线 → 写回 true → 启动轮询 */
export async function startWatch(): Promise<WatchStartResult> {
  return performStart(false);
}

/** 关闭值守：清定时器、写回 watchEnabled=false、状态置 closed（幂等）；作废在途 start 事务 */
export async function stopWatch(): Promise<WatchStopResult> {
  startGeneration += 1;
  if (pollTimerHandle) {
    clearTimeout(pollTimerHandle);
    pollTimerHandle = null;
  }
  nextPollAt = null;
  runtimeStatus = 'closed';
  setWatchRuntimeRunning(false);
  persistWatchEnabled(false);
  // 运行态标志复位与意图落库完成后统一通知（send_email 移出 MAIN_TOOLS，声明层与执行层同拍）
  notifyRuntimeStateChange();
  writeWatchLog('INFO', 'watch.stop', '值守服务已关闭（watch:stop：清定时器、写回 watchEnabled=false、通知刷新工具清单）');
  return { ok: true, status: 'closed' };
}

/** 查询值守运行状态（界面开关状态反馈与错误提示数据源） */
export function getWatchStatus(): WatchStatusResult {
  const settings = readNormalizedWatchSettings();
  return {
    status: runtimeStatus,
    enabled: settings.watchEnabled,
    lastError,
    watermark: null,
    cursor: cursorSinceIso
      ? { mailbox: cursorMailbox, sinceTime: cursorSinceIso, updatedAt: cursorUpdatedAtIso }
      : null,
    nextPollAt: nextPollAt !== null ? new Date(nextPollAt).toISOString() : null,
    processedCount,
  };
}

/**
 * 手动执行一轮轮询（诊断/受控测试直调；不接入 IPC）。
 * 复用与定时轮询完全相同的 runPollOnce（含 inFlight 互斥）。
 */
export async function pollWatchOnceForDiagnosis(): Promise<{ accepted: boolean; reason?: string; outcome?: PollOnceOutcome }> {
  if (runtimeStatus !== 'running') {
    return { accepted: false, reason: 'WATCH_NOT_RUNNING' };
  }
  if (pollInFlight) {
    return { accepted: false, reason: 'POLL_IN_FLIGHT' };
  }
  const outcome = await runPollOnce();
  return { accepted: true, outcome };
}

// ---------------------------------------------------------------------------
// 应用重启恢复逻辑（app ready 后由 registerIpcHandlers 调用）
// ---------------------------------------------------------------------------

/**
 * 值守服务启动入口（含自动恢复判定，幂等）：
 * - watchEnabled=false：保持关闭，零副作用，仅记 INFO 日志
 * - watchEnabled=true：真实自检（IMAP/SMTP），通过则以「本次启动时刻」为时间游标基线恢复轮询
 *   （不补处理停机期间的积压邮件），失败回落关闭（保留 watchEnabled 用户意图 +
 *   ERROR 日志 + 界面 Alert 数据，下次重启仍会自动恢复重试）
 */
export function startWatchService(): void {
  if (recoveryStarted) {
    return;
  }
  recoveryStarted = true;

  const settings = readNormalizedWatchSettings();
  if (!settings.watchEnabled) {
    writeWatchLog('INFO', 'watch.resume', 'watchEnabled=false：值守服务保持关闭（零副作用）');
    return;
  }

  writeWatchLog(
    'INFO',
    'watch.resume',
    `检测到 watchEnabled=true：尝试自动恢复值守（真实自检：IMAP 登录 + SMTP 登录）mailbox=${maskMailbox(settings.watchMailboxAddress)}`,
  );
  void performStart(true).then((result) => {
    if (result.ok) {
      writeWatchLog('INFO', 'watch.resume', '已按上次开关状态自动恢复值守（自检通过，时间游标以本次启动时刻重新建立）');
    } else {
      writeWatchLog(
        'ERROR',
        'watch.resume',
        `值守自动恢复失败已回落关闭：${result.code ?? 'ERR_WATCH_INTERNAL'} ${result.message ?? ''}；请检查配置后重新开启`,
      );
    }
  });
}

/** 停止值守服务（应用退出 before-quit 接线调用：仅清内存态与定时器，不写 watchEnabled——保留
 * 用户意图跨重启）；作废在途 start 事务，与 stopWatch 同一世代仲裁口径。 */
export function stopWatchService(): void {
  startGeneration += 1;
  if (pollTimerHandle) {
    clearTimeout(pollTimerHandle);
    pollTimerHandle = null;
  }
  nextPollAt = null;
  runtimeStatus = 'closed';
  setWatchRuntimeRunning(false);
  recoveryStarted = false;
  // 运行态终局（closed + 标志复位）落位后统一通知（与其他终态转移同一时点口径）
  notifyRuntimeStateChange();
  writeWatchLog('INFO', 'watch.state', '值守服务已随应用退出复位（stopWatchService：清定时器，不写回 watchEnabled）');
}
