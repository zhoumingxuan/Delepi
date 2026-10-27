/**
 * mail-bridge — 值守模式邮件通道桥（阶段7：收信侧完整 Node.js 化）
 *
 * 阶段7 变更（目标2）：
 * - 删除内嵌解释器脚本桥（原内嵌脚本常量 / 落盘脚本文件 / spawn 子进程 / 行式 JSON 协议）；
 * - 收信改由纯 Node 实现承担：
 *     mail/imap-client.ts    —— IMAP 协议（TCP/TLS、LOGIN、ID、EXAMINE、UID SEARCH、UID FETCH、LOGOUT）
 *     mail/mime-parser.ts    —— MIME 解析（multipart/alternative、base64、quoted-printable、字符集）
 *     mail/smtp-client.ts    —— SMTP 发送（阶段4 已 Node 化，本轮新增 STARTTLS 支持）
 * - 本模块只保留「编排 + 契约」：对外仍是 mailSelfTest / mailImapPoll / mailImapPollSince /
 *   mailSmtpSend 四个导出，解析产物仍是 FetchedWatchMail 九字段契约，调用方零改造；
 * - 端点不再写死：全部来自 mail/mail-provider.ts 的 provider 解析结果（MailProviderEndpoints），
 *   由 watch-service 按当前 settings 注入。
 *
 * 兼容接缝（发信侧 send_email 工具在阶段7 改动白名单之外，无法直接改造）：
 * - 导出 WATCH_SMTP_ENDPOINT 以「只读 getter 对象」形式保留：host/port 在访问时返回当前生效
 *   provider 端点（未注入前回落到 QQ 内置常量，与阶段4~6 行为逐字节一致）；
 * - 同时把 provider 的 SMTP 加密方式写入 smtp-client 的进程级默认值
 *   （setDefaultSmtpEncryption），使未显式传 encryption 的既有调用方自动跟随 provider 设置。
 *   两处接缝都属于「迁移记录」性质，详见阶段7 实现报告第 4/5 章。
 *
 * 错误阶段分类（保持阶段2 的对外语义）：
 * - connect：TCP/DNS/TLS 建连失败
 * - auth：登录被拒（QQ IMAP 返回 NO [AUTHENTICATIONFAILED]；SMTP 认证失败在 QQ 上表现为直接断连）
 * - recv：登录成功后的 EXAMINE / SEARCH / FETCH 失败
 * - send：SMTP 发送阶段失败
 * - timeout：整体/空闲超时
 * 凭据脱敏：任何返回文本都把授权码（含 base64/base64url/URL 编码形态）替换为 <QQ邮箱授权码>。
 *
 * 本模块保持纯 Node（不 import electron），端点与凭据全部由调用方注入，便于受控 harness 直测。
 */

import { formatImapSearchDate, imapPollSinceDate, imapPollSinceUid, imapSelfTest, type ImapFailure, type RawImapMessage } from '../mail/imap-client';
import { parseFirstAddress, parseMimeMessage, decodeHeaderValue } from '../mail/mime-parser';
import { QQ_MAIL_PROVIDER, type MailProviderEndpoints } from '../mail/mail-provider';
import {
  maskAuthCode,
  sendSmtpMail,
  setDefaultSmtpEncryption,
  verifySmtpLogin,
  type SmtpHeaderInput,
} from '../mail/smtp-client';

/** 单次操作超时（毫秒，沿用阶段2 口径：IMAP 轮询 45 秒；SMTP 发信基础 90 秒） */
export const MAIL_BRIDGE_TIMEOUT_MS = {
  selfTest: 45_000,
  imapPoll: 45_000,
  imapPollSince: 45_000,
  smtpSend: 90_000,
} as const;

/** 时间增量收信单轮最多取回的候选 UID 数（与被替换的旧桥 MAX_POLL_SINCE_UIDS 一致） */
export const MAX_POLL_SINCE_UIDS = 50;

/** 授权码占位符（任何错误文本/日志中一律使用，严禁出现明文） */
const AUTH_CODE_PLACEHOLDER = '<QQ邮箱授权码>';

// ---------------------------------------------------------------------------
// 生效端点注册表（provider 解析结果由 watch-service 注入）
// ---------------------------------------------------------------------------

/** 未注入前的默认端点：QQ 内置常量（阶段2~6 的实测端点，保证任何早期调用行为不变） */
const FALLBACK_ENDPOINTS: MailProviderEndpoints = {
  providerId: QQ_MAIL_PROVIDER.id,
  providerLabel: QQ_MAIL_PROVIDER.label,
  imap: { ...QQ_MAIL_PROVIDER.fixedEndpoints!.imap },
  smtp: { ...QQ_MAIL_PROVIDER.fixedEndpoints!.smtp },
};

let activeEndpoints: MailProviderEndpoints = FALLBACK_ENDPOINTS;

/**
 * 注入当前生效端点（watch-service 在每次读取值守配置时调用）。
 * 同时把 SMTP 加密方式同步给 smtp-client 的进程级默认值，供未显式传 encryption 的
 * 既有调用方（send_email 工具）跟随 provider 设置。
 */
export function setActiveMailEndpoints(endpoints: MailProviderEndpoints): void {
  activeEndpoints = endpoints;
  setDefaultSmtpEncryption(endpoints.smtp.encryption);
}

/** 读取当前生效端点（诊断/日志/测试用） */
export function getActiveMailEndpoints(): MailProviderEndpoints {
  return activeEndpoints;
}

/**
 * 兼容导出（阶段4~6 的既有引用点：src/main/tools/send-email.ts）。
 * 只读 getter：每次访问都取当前生效 provider 端点，使 send_email 无需改动即可跟随邮箱类型设置。
 */
export const WATCH_SMTP_ENDPOINT: { readonly host: string; readonly port: number } = {
  get host(): string {
    return activeEndpoints.smtp.host;
  },
  get port(): number {
    return activeEndpoints.smtp.port;
  },
};

/** 兼容导出：IMAP 端点（阶段7 起仅供诊断展示，收信一律走 provider 解析） */
export const WATCH_IMAP_ENDPOINT: { readonly host: string; readonly port: number } = {
  get host(): string {
    return activeEndpoints.imap.host;
  },
  get port(): number {
    return activeEndpoints.imap.port;
  },
};

// ---------------------------------------------------------------------------
// 运行结果契约与错误归一
// ---------------------------------------------------------------------------

export type MailBridgeFailureStage = 'connect' | 'auth' | 'recv' | 'send' | 'timeout' | 'internal';

export interface MailBridgeFailure {
  ok: false;
  stage: MailBridgeFailureStage;
  code: string;
  message: string;
  detail: string;
}

export type MailBridgeOutcome<T> = ({ ok: true; data: T }) | MailBridgeFailure;

/** 邮件通道调用上下文：收/发端点（provider 解析结果） */
export interface MailBridgeContext {
  endpoints: MailProviderEndpoints;
}

/** 授权码脱敏：任何外发文本中一律以占位符替换（§10.5） */
function sanitizeWithSecret(text: string, secret: string): string {
  const masked = maskAuthCode(text, secret);
  const outText = secret ? masked.split(secret).join(AUTH_CODE_PLACEHOLDER) : masked;
  return outText.length > 500 ? `${outText.slice(0, 500)}…` : outText;
}

/** IMAP 阶段失败 → 对外统一失败契约（阶段2 的错误码/文案保持不变） */
function classifyImapFailure(failure: ImapFailure): MailBridgeFailure {
  if (failure.stage === 'auth') {
    return {
      ok: false,
      stage: 'auth',
      code: 'ERR_WATCH_MAIL_AUTH_FAILED',
      message: '邮箱登录验证失败（阶段=登录）：授权码错误或 IMAP/SMTP 服务未开启',
      detail: failure.error,
    };
  }
  if (failure.stage === 'connect') {
    return {
      ok: false,
      stage: 'connect',
      code: 'ERR_WATCH_NETWORK',
      message: '邮件服务器连接失败（阶段=连接）：网络不可达 / DNS / TLS 失败',
      detail: failure.error,
    };
  }
  if (failure.stage === 'timeout') {
    return {
      ok: false,
      stage: 'timeout',
      code: 'ERR_WATCH_TIMEOUT',
      message: '邮件通道操作超时（阶段=超时）',
      detail: failure.error,
    };
  }
  return {
    ok: false,
    stage: 'recv',
    code: 'ERR_WATCH_NETWORK',
    message: 'IMAP 收信阶段失败（阶段=收信）',
    detail: failure.error,
  };
}

/** IMAP 结果 → 对外契约 */
function toOutcome<T>(result: { ok: true; data: T } | ImapFailure, secret: string): MailBridgeOutcome<T> {
  if (result.ok) {
    return { ok: true, data: result.data };
  }
  const failure = classifyImapFailure(result);
  return { ...failure, detail: sanitizeWithSecret(failure.detail, secret) };
}

// ---------------------------------------------------------------------------
// 时间工具（导出以便受控单测）
// ---------------------------------------------------------------------------

/**
 * IMAP INTERNALDATE → ISO 8601（解析失败返回空串，调用方回退 Date 头）。
 * 输入形态：`26-Oct-2026 19:38:16 +0800`（IMAP 固定格式，月份为英文三字母缩写）。
 * 说明：只做「到秒」的等价换算（阶段6 用户已明确取消毫秒精度要求）。
 */
export function internalDateToIso(raw: string): string {
  const text = String(raw ?? '').trim();
  if (!text) {
    return '';
  }
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})[ T](\d{2}):(\d{2}):(\d{2})(?:\s+([+-])(\d{2})(\d{2}))?$/.exec(text);
  if (!match) {
    return '';
  }
  const monthIndex = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
    match[2].toLowerCase(),
  );
  if (monthIndex < 0) {
    return '';
  }
  const day = Number(match[1]);
  const year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  let offsetMinutes = 0;
  if (match[7] && match[8] && match[9]) {
    offsetMinutes = Number(match[8]) * 60 + Number(match[9]);
    if (match[7] === '-') {
      offsetMinutes = -offsetMinutes;
    }
  }
  const utcMs = Date.UTC(year, monthIndex, day, hour, minute, second) - offsetMinutes * 60_000;
  const parsed = new Date(utcMs);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toISOString();
}

/**
 * sinceIso → IMAP SEARCH SINCE 日期（DD-Mon-YYYY，取 sinceIso 往前 1 天，覆盖时区与日界）。
 * 非法/空值返回 null（调用方按 recv 阶段失败处理，与被替换的旧桥一致）。
 */
export function toImapSearchDate(sinceIso: string): string | null {
  const text = String(sinceIso ?? '').trim();
  if (!text) {
    return null;
  }
  const timestampMs = Date.parse(text);
  if (Number.isNaN(timestampMs)) {
    return null;
  }
  const anchor = new Date(timestampMs - 24 * 60 * 60 * 1000);
  return formatImapSearchDate(anchor);
}

// ---------------------------------------------------------------------------
// 对外操作接口
// ---------------------------------------------------------------------------

export interface MailSelfTestInput {
  mailbox: string;
  authCode: string;
}

export interface MailSelfTestOk {
  ok: true;
  uidvalidity: number;
  uidnext: number;
}

/**
 * 凭据自检：IMAP 登录 + EXAMINE INBOX（取 UIDVALIDITY/UIDNEXT）+ SMTP 登录（不发信）。
 * 与被替换的旧桥自检等价（IMAP 段 + SMTP 段，两段都成功才通过）。
 */
export async function mailSelfTest(
  input: MailSelfTestInput,
  context: MailBridgeContext,
): Promise<MailBridgeOutcome<MailSelfTestOk>> {
  const imapResult = await imapSelfTest({
    endpoint: context.endpoints.imap,
    mailbox: input.mailbox,
    authCode: input.authCode,
    timeoutMs: MAIL_BRIDGE_TIMEOUT_MS.selfTest,
  });
  if (!imapResult.ok) {
    return toOutcome(imapResult, input.authCode);
  }

  const smtpResult = await smtpVerifyLogin({
    endpoint: context.endpoints.smtp,
    mailbox: input.mailbox,
    authCode: input.authCode,
    timeoutMs: MAIL_BRIDGE_TIMEOUT_MS.selfTest,
  });
  if (!smtpResult.ok) {
    return smtpResult;
  }

  return {
    ok: true,
    data: { ok: true, uidvalidity: imapResult.data.uidvalidity, uidnext: imapResult.data.uidnext },
  };
}

/** SMTP 登录自检（只做 AUTH LOGIN，不发信；失败按 connect/auth 分类） */
async function smtpVerifyLogin(params: {
  endpoint: MailProviderEndpoints['smtp'];
  mailbox: string;
  authCode: string;
  timeoutMs: number;
}): Promise<MailBridgeOutcome<{ ok: true }>> {
  const result = await verifySmtpLogin({
    host: params.endpoint.host,
    port: params.endpoint.port,
    encryption: params.endpoint.encryption,
    mailbox: params.mailbox,
    authCode: params.authCode,
    timeoutMs: params.timeoutMs,
  });
  if (result.ok) {
    return { ok: true, data: { ok: true } };
  }
  const stage: MailBridgeFailureStage = result.stage === 'auth' ? 'auth' : result.stage === 'timeout' ? 'timeout' : 'connect';
  return {
    ok: false,
    stage,
    code: stage === 'auth' ? 'ERR_WATCH_MAIL_AUTH_FAILED' : stage === 'timeout' ? 'ERR_WATCH_TIMEOUT' : 'ERR_WATCH_NETWORK',
    message:
      stage === 'auth'
        ? '邮箱登录验证失败（阶段=登录）：授权码错误或 IMAP/SMTP 服务未开启'
        : stage === 'timeout'
          ? '邮件通道操作超时（阶段=超时）'
          : '邮件服务器连接失败（阶段=连接）：网络不可达 / DNS / TLS 失败',
    detail: sanitizeWithSecret(result.error, params.authCode),
  };
}

export interface FetchedWatchMail {
  uid: number;
  messageId: string;
  fromAddress: string;
  subject: string;
  delepiRole: string;
  xDelepiCommandId: string;
  inReplyTo: string;
  date: string;
  /** IMAP INTERNALDATE 的 ISO 8601 文本（解析失败为空串）：时间增量过滤的首选依据 */
  internalDate: string;
  bodyText: string;
}

export interface MailImapPollOk {
  ok: true;
  uidvalidity: number;
  uidnext: number;
  mails: FetchedWatchMail[];
}

/** 原始 IMAP 取回 → FetchedWatchMail 九字段契约（header 解码 + MIME 解析） */
export function toFetchedWatchMail(raw: RawImapMessage): FetchedWatchMail {
  const parsed = parseMimeMessage(raw.body);
  const headers = parsed.headers;
  return {
    uid: raw.uid,
    messageId: String(headers['message-id'] ?? '').trim(),
    fromAddress: parseFirstAddress(decodeHeaderValue(headers.from)),
    subject: decodeHeaderValue(headers.subject),
    delepiRole: String(headers['x-delepi-role'] ?? '').trim(),
    xDelepiCommandId: String(headers['x-delepi-command-id'] ?? '').trim(),
    inReplyTo: String(headers['in-reply-to'] ?? '').trim(),
    date: String(headers.date ?? '').trim(),
    internalDate: internalDateToIso(raw.internalDateRaw),
    bodyText: parsed.bodyText,
  };
}

/**
 * 解析邮件时间戳（毫秒）：优先 INTERNALDATE（ISO 8601），回退 Date 头（RFC 2822 文本）；
 * 两者都无法解析时返回 null（由调用方决定「视为需处理」还是「排到最后」）。
 */
export function resolveMailTimestampMs(mail: Pick<FetchedWatchMail, 'internalDate' | 'date'>): number | null {
  const internalIso = typeof mail.internalDate === 'string' ? mail.internalDate.trim() : '';
  if (internalIso) {
    const internalMs = Date.parse(internalIso);
    if (!Number.isNaN(internalMs)) {
      return internalMs;
    }
  }
  const headerDate = typeof mail.date === 'string' ? mail.date.trim() : '';
  if (headerDate) {
    const headerMs = Date.parse(headerDate);
    if (!Number.isNaN(headerMs)) {
      return headerMs;
    }
  }
  return null;
}

/**
 * 时间增量过滤：保留时间戳 >= cursorMs 的邮件。
 * INTERNALDATE 为空时回退 Date 头；仍为空（无法解析）时「视为需处理」，宁可多处理一封也不丢信
 * （执行侧还有 messageId/requestId 双重去重兜底）。
 */
export function filterMailsAtOrAfterCursor(mails: FetchedWatchMail[], cursorMs: number): FetchedWatchMail[] {
  return mails.filter((mail) => {
    const timestampMs = resolveMailTimestampMs(mail);
    return timestampMs === null ? true : timestampMs >= cursorMs;
  });
}

/**
 * 按时间升序排序（不修改入参）：无法解析时间的邮件排到最后；同一时刻按 uid 升序保证稳定与确定性。
 */
export function sortMailsByTimeAscending(mails: FetchedWatchMail[]): FetchedWatchMail[] {
  return [...mails].sort((a, b) => {
    const aMs = resolveMailTimestampMs(a);
    const bMs = resolveMailTimestampMs(b);
    const aKey = aMs === null ? Number.MAX_SAFE_INTEGER : aMs;
    const bKey = bMs === null ? Number.MAX_SAFE_INTEGER : bMs;
    if (aKey !== bKey) {
      return aKey - bKey;
    }
    return a.uid - b.uid;
  });
}

/**
 * IMAP 增量收信：UID FETCH (sinceUid+1):* BODY.PEEK[]（不置已读）。
 * 星号语义可能多带回一封不大于 sinceUid 的旧邮件，调用方必须按 uid > sinceUid 过滤。
 * 阶段7 起为「保留能力」：值守主链路使用时间增量（mailImapPollSince），本导出供诊断与兼容调用。
 */
export async function mailImapPoll(
  input: { mailbox: string; authCode: string; sinceUid: number },
  context: MailBridgeContext,
): Promise<MailBridgeOutcome<MailImapPollOk>> {
  const result = await imapPollSinceUid({
    endpoint: context.endpoints.imap,
    mailbox: input.mailbox,
    authCode: input.authCode,
    sinceUid: input.sinceUid,
    timeoutMs: MAIL_BRIDGE_TIMEOUT_MS.imapPoll,
  });
  if (!result.ok) {
    return toOutcome(result, input.authCode);
  }
  const mails = result.data.messages
    .filter((message) => message.uid > input.sinceUid)
    .map((message) => toFetchedWatchMail(message));
  return {
    ok: true,
    data: {
      ok: true,
      uidvalidity: result.data.uidvalidity,
      uidnext: result.data.uidnext,
      mails,
    },
  };
}

export interface MailImapPollSinceInput {
  mailbox: string;
  authCode: string;
  /** 时间游标（ISO 8601）：据此取「往前 1 天」的 IMAP 日期做 SEARCH SINCE */
  sinceIso: string;
}

export interface MailImapPollSinceOk {
  ok: true;
  uidvalidity: number;
  uidnext: number;
  mails: FetchedWatchMail[];
}

/**
 * IMAP 时间增量收信：以 sinceIso 往前 1 天的 IMAP 日期执行 UID SEARCH SINCE <date>，
 * 取候选中最新的至多 50 个 UID，再 UID FETCH (INTERNALDATE BODY.PEEK[])。
 * SEARCH SINCE 只精确到「日」，秒级增量判定由调用方用 internalDate（空则回退 date 头）完成。
 */
export async function mailImapPollSince(
  input: MailImapPollSinceInput,
  context: MailBridgeContext,
): Promise<MailBridgeOutcome<MailImapPollSinceOk>> {
  const sinceDate = toImapSearchDate(input.sinceIso);
  if (!sinceDate) {
    return {
      ok: false,
      stage: 'recv',
      code: 'ERR_WATCH_NETWORK',
      message: 'IMAP 收信阶段失败（阶段=收信）',
      detail: sanitizeWithSecret(`sinceIso 无法解析为 ISO 8601：${String(input.sinceIso ?? '').slice(0, 40)}`, input.authCode),
    };
  }
  const result = await imapPollSinceDate({
    endpoint: context.endpoints.imap,
    mailbox: input.mailbox,
    authCode: input.authCode,
    sinceDate,
    maxUids: MAX_POLL_SINCE_UIDS,
    timeoutMs: MAIL_BRIDGE_TIMEOUT_MS.imapPollSince,
  });
  if (!result.ok) {
    return toOutcome(result, input.authCode);
  }
  return {
    ok: true,
    data: {
      ok: true,
      uidvalidity: result.data.uidvalidity,
      uidnext: result.data.uidnext,
      mails: result.data.messages.map((message) => toFetchedWatchMail(message)),
    },
  };
}

export interface MailSmtpSendInput {
  mailbox: string;
  authCode: string;
  to: string;
  subject: string;
  body: string;
  headers: {
    inReplyTo?: string;
    references?: string;
    xDelepiRole?: string;
    xDelepiCommandId?: string;
  };
}

export interface MailSmtpSendOk {
  ok: true;
  declaredMessageId: string;
  refused: string[];
}

/**
 * SMTP 服务直发（兼容导出）：值守主链路的回执已改用 sendSmtpMail（HTML + 附件），
 * 本函数保留给「纯文本单段」调用方，内部把纯文本包装为 <pre> 的 HTML 文档后走同一发送实现。
 * 迁移记录：旧桥固定单段纯文本；本实现统一 HTML（smtp-client 的能力子集），
 * 语义等价点=同一 SMTP 命令序列、同一 From/To/Subject 语义、同一 dot-stuffing 与超时分类。
 */
export async function mailSmtpSend(
  input: MailSmtpSendInput,
  context: MailBridgeContext,
): Promise<MailBridgeOutcome<MailSmtpSendOk>> {
  const headers: SmtpHeaderInput[] = [];
  if (input.headers?.inReplyTo) {
    headers.push({ name: 'In-Reply-To', value: input.headers.inReplyTo });
    headers.push({ name: 'References', value: input.headers.references || input.headers.inReplyTo });
  } else if (input.headers?.references) {
    headers.push({ name: 'References', value: input.headers.references });
  }
  if (input.headers?.xDelepiRole) {
    headers.push({ name: 'X-Delepi-Role', value: input.headers.xDelepiRole });
  }
  if (input.headers?.xDelepiCommandId) {
    headers.push({ name: 'X-Delepi-Command-Id', value: input.headers.xDelepiCommandId });
  }

  const html = `<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body><pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit">${escapeHtml(
    input.body,
  )}</pre></body></html>`;

  const outcome = await sendSmtpMail({
    host: context.endpoints.smtp.host,
    port: context.endpoints.smtp.port,
    encryption: context.endpoints.smtp.encryption,
    mailbox: input.mailbox,
    authCode: input.authCode,
    to: input.to || input.mailbox,
    subject: input.subject,
    html,
    headers,
    timeoutMs: MAIL_BRIDGE_TIMEOUT_MS.smtpSend,
  });

  if (outcome.ok) {
    return {
      ok: true,
      data: { ok: true, declaredMessageId: outcome.declaredMessageId, refused: outcome.refusedRecipients },
    };
  }
  return {
    ok: false,
    stage: outcome.stage === 'auth' ? 'auth' : outcome.stage === 'timeout' ? 'timeout' : 'send',
    code: outcome.stage === 'auth' ? 'ERR_WATCH_MAIL_AUTH_FAILED' : 'ERR_WATCH_SEND_FAILED',
    message: outcome.stage === 'auth' ? '邮箱登录验证失败（阶段=登录）：授权码错误或 IMAP/SMTP 服务未开启' : 'SMTP 发送阶段失败',
    detail: sanitizeWithSecret(outcome.error, input.authCode),
  };
}

/** 最小 HTML 转义（纯文本兼容导出用） */
function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
