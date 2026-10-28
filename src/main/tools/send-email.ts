/**
 * send-email — 主智能体 send_email 工具执行体（阶段4：Node 原生 SMTP 发送）
 *
 * 职责：
 * - 执行层能力拦截：值守运行态标志未置位时返回 TOOL_DISABLED_WATCH_OFF；
 *   工具声明层可见性由 prompt.ts buildMainTools() 无条件追加（本执行体保持同一拦截口径）。
 * - 参数校验：subject 1-200 / body 1-8192 / attachments string[]；
 *   不再读取正文格式与线程头入参（线程头只由值守指令上下文自动补全）。
 * - 收件人缺省解析：显式 to → watchReceiptRecipient → watchMailboxAddress。
 * - 正文统一为“无任何 JS 的 HTML”：移除 script/iframe/object/embed 标签及其内容、
 *   移除所有 on* 事件属性、移除 javascript: 协议；无 HTML 标签时用 <pre> 包裹并转义；
 *   缺少 html 骨架时补 <!DOCTYPE html><html><head><meta charset="utf-8"></head><body>…</body></html>。
 * - 附件路径三类根校验：当前对话目录 / 月度输出目录 / userData/watch-attachments；
 *   拒绝含 .. 段、realpath 后二次根校验、必须是普通文件、可读校验；不设数量与大小上限。
 * - http(s) URL 附件使用 Node 全局 fetch 下载到内存（拒绝 file:// 等其它协议）。
 * - SMTP 发送调用 src/main/modules/mail/smtp-client.ts（纯 Node 实现，零新增依赖）。
 * - 头自动补全：In-Reply-To/References 取值守指令上下文的 commandMessageId；
 *   X-Delepi-Role: agent 恒加；X-Delepi-Command-Id 有上下文时回带。
 * - 失败按 stage 分类透传（validate/download/connect/auth/send/timeout），错误文本脱敏；
 *   发送成功后调用 markWatchCommandReceiptSent 标记回执已发出。
 * - BUG3 登记侧：发送成功后登记出站邮件映射（Message-ID → conversationId → 收件人，
 *   outbound-mail-map，内存 + 文件缓存）——**不依赖值守指令上下文**，本地对话发起的
 *   run 同样登记，供收信侧把「用户直接回复本邮件」关联回原对话；登记失败不影响发送结果。
 */

import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { configManager } from '../modules/config/config-manager';
import {
  maskAuthCode,
  sendSmtpMail,
  type SmtpAttachmentInput,
  type SmtpHeaderInput,
} from '../modules/mail/smtp-client';
import { WATCH_SMTP_ENDPOINT } from '../modules/watch/mail-bridge';
import { registerOutboundMail } from '../modules/watch/outbound-mail-map';
import {
  getWatchCommandContext,
  isWatchRuntimeRunning,
  markWatchCommandReceiptSent,
} from '../modules/watch/watch-runtime-flag';
import { isPathInsideDir, resolveConversationDir, resolveMonthlyOutputDir } from '../utils/storage-paths';
import { buildToolResult, type ToolResult } from './result';
import type { ToolRuntimeContext } from './runtime-context';

/** 邮箱格式校验（与 v3 §4.1 / watch-service 一致） */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** http(s) 远程 URL 附件识别 */
const HTTP_URL_RE = /^https?:\/\//i;

/** URL 协议识别（Windows 盘符单独排除，避免把 C:\path 当作协议） */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

/** 正文长度上限（与工具 Schema body.maxLength=8192 对齐） */
const BODY_MAX_LENGTH = 8192;

/** 动态超时基础（毫秒）：90s + 每附件 30s + 每 2MB 加 10s（不封顶，仅防挂死） */
const SEND_TIMEOUT_BASE_MS = 90_000;
const SEND_TIMEOUT_PER_ATTACHMENT_MS = 30_000;
const SEND_TIMEOUT_PER_2MB_MS = 10_000;

/** 待处理附件（本地路径已完成三道校验；URL 待下载） */
type PendingAttachment = { kind: 'file'; path: string } | { kind: 'url'; url: string };

/** 已就绪附件（内容已在内存中） */
type ResolvedAttachment = SmtpAttachmentInput;

/** 附件 URL 下载失败（stage=download） */
class AttachmentDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentDownloadError';
  }
}

/** 整体期限耗尽（stage=timeout） */
class DeadlineExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineExceededError';
  }
}

type LocalAttachmentResolution =
  | { ok: true; realPath: string; size: number }
  | { ok: false; result: ToolResult };

function cleanOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

/** 失败返回构造（阶段分类透传） */
function emailFailure(
  code: string,
  stage: string,
  message: string,
  detail: string,
  extra?: Record<string, unknown>,
): ToolResult {
  return buildToolResult({
    success: false,
    code,
    message: message.length > 500 ? `${message.slice(0, 500)}…` : message,
    data: {
      stage,
      detail: detail.length > 1000 ? `${detail.slice(0, 1000)}…` : detail,
      ...(extra ?? {}),
    },
  });
}

/**
 * 附件本地路径三道校验（不设数量/大小上限）：
 * 1) 拒绝含 .. 段的输入；
 * 2) path.resolve 后必须严格位于三类允许根之一（不得等于根本身）；
 * 3) realpath 后再次根校验（防符号链接逃逸）+ 必须是普通文件 + 可读。
 */
function resolveLocalAttachment(item: string, allowedRoots: string[]): LocalAttachmentResolution {
  const segments = item.split(/[\\/]+/);
  if (segments.includes('..')) {
    return {
      ok: false,
      result: emailFailure(
        'EMAIL_ATTACHMENT_PATH_FORBIDDEN',
        'validate',
        `附件路径越界（含 .. 段）：${item}`,
        item,
      ),
    };
  }
  const resolved = path.resolve(item);
  if (!allowedRoots.some((root) => isPathInsideDir(root, resolved))) {
    return {
      ok: false,
      result: emailFailure(
        'EMAIL_ATTACHMENT_PATH_FORBIDDEN',
        'validate',
        `附件路径越界（仅允许当前对话目录、输出目录或值守附件暂存目录内的文件）：${item}`,
        `resolved=${resolved}; allowedRoots=${allowedRoots.join(' | ')}`,
      ),
    };
  }
  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch (error) {
    return {
      ok: false,
      result: emailFailure(
        'EMAIL_ATTACHMENT_NOT_FOUND',
        'validate',
        `附件不存在或无法解析路径：${item}`,
        errorText(error),
      ),
    };
  }
  if (!allowedRoots.some((root) => isPathInsideDir(root, realPath))) {
    return {
      ok: false,
      result: emailFailure(
        'EMAIL_ATTACHMENT_PATH_FORBIDDEN',
        'validate',
        `附件路径越界（符号链接逃逸被拒绝）：${item}`,
        `realpath=${realPath}`,
      ),
    };
  }
  let fileStat;
  try {
    fileStat = statSync(realPath);
  } catch (error) {
    return {
      ok: false,
      result: emailFailure(
        'EMAIL_ATTACHMENT_NOT_FOUND',
        'validate',
        `附件不存在：${item}`,
        errorText(error),
      ),
    };
  }
  if (!fileStat.isFile()) {
    return {
      ok: false,
      result: emailFailure(
        'EMAIL_ATTACHMENT_NOT_FOUND',
        'validate',
        `附件不是普通文件：${item}`,
        realPath,
      ),
    };
  }
  try {
    accessSync(realPath, constants.R_OK);
  } catch (error) {
    return {
      ok: false,
      result: emailFailure(
        'EMAIL_ATTACHMENT_READ_FAILED',
        'validate',
        `附件读取失败（权限不足或被占用）：${item}`,
        errorText(error),
      ),
    };
  }
  return { ok: true, realPath, size: fileStat.size };
}

/** 判断是否为 http(s) 之外的显式协议（file://、ftp:// 等一律拒绝） */
function isNonHttpProtocol(value: string): boolean {
  if (WINDOWS_DRIVE_RE.test(value)) {
    return false;
  }
  return SCHEME_RE.test(value) && !HTTP_URL_RE.test(value);
}

/** 清洗下载文件名（不使用任何大小上限，仅做路径/控制字符安全处理） */
function sanitizeAttachmentName(value: string): string {
  const cleaned = value
    .replace(/[\r\n]/g, ' ')
    .replace(/[\\/]/g, '_')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 180) || 'attachment';
}

/** 从 Content-Disposition / URL 末段解析下载文件名 */
function resolveDownloadFileName(response: Response, url: string, index: number): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const utf8Match = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
  if (utf8Match && utf8Match[1]) {
    try {
      return sanitizeAttachmentName(
        decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, '')),
      );
    } catch {
      // 非法百分号编码时继续尝试其它来源
    }
  }
  const plainMatch = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition);
  if (plainMatch) {
    const raw = (plainMatch[1] ?? plainMatch[2] ?? '').trim();
    if (raw) {
      return sanitizeAttachmentName(raw);
    }
  }
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split('/').filter(Boolean).pop() ?? '';
    if (lastSegment) {
      return sanitizeAttachmentName(decodeURIComponent(lastSegment));
    }
  } catch {
    // URL 解析失败时使用序号兜底
  }
  return `attachment-${index + 1}`;
}

/** 用 Node 全局 fetch 下载 http(s) 附件（不落盘，直接进内存） */
async function downloadAttachment(
  url: string,
  index: number,
  timeoutMs: number,
): Promise<ResolvedAttachment> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'Delepi/1.0' },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DeadlineExceededError(`附件下载超时（${Math.max(1, timeoutMs)}ms）：${url}`);
      }
      throw new AttachmentDownloadError(`附件 URL 请求失败：${errorText(error)}（${url}）`);
    }
    if (!response.ok) {
      throw new AttachmentDownloadError(
        `附件 URL 返回 HTTP ${response.status} ${response.statusText}：${url}`,
      );
    }
    let content: Buffer;
    try {
      content = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DeadlineExceededError(`附件下载超时（${Math.max(1, timeoutMs)}ms）：${url}`);
      }
      throw new AttachmentDownloadError(`附件内容读取失败：${errorText(error)}（${url}）`);
    }
    return {
      fileName: resolveDownloadFileName(response, url, index),
      content,
      contentType: (response.headers.get('content-type') ?? '').replace(/[\r\n]/g, ' ').trim() || undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// HTML 正文清洗（统一为“无任何 JS 的 HTML”）
// ---------------------------------------------------------------------------

const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/;

/** 成对危险标签（标签 + 内容一并移除） */
const BLOCKED_PAIRED_TAG_RE = /<(script|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** 未闭合的危险开标签：安全优先，从该标签起到文末整体移除 */
const BLOCKED_UNCLOSED_TAG_RE = /<(script|iframe|object)\b[^>]*>[\s\S]*$/gi;

/** 残余危险标签（含 embed 等空元素） */
const BLOCKED_TAG_RE = /<\/?(?:script|iframe|object|embed)\b[^>]*>/gi;

/** 标签匹配（允许属性值中出现 >） */
const TAG_PATTERN = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;

/** on* 事件属性 */
const EVENT_ATTRIBUTE_PATTERN = /\son[a-z][a-z0-9_-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/** 通用属性（用于识别 URL 类属性中的 javascript: 协议） */
const ATTRIBUTE_PATTERN = /\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

const URL_ATTRIBUTE_NAMES = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'background',
  'data',
  'xlink:href',
]);

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
    return '';
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** 基础实体解码（用于识别 java&#115;cript: 之类绕过） */
function decodeBasicEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_match: string, hex: string) =>
      safeFromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);?/g, (_match: string, decimal: string) =>
      safeFromCodePoint(parseInt(decimal, 10)),
    )
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n');
}

function isJavascriptProtocol(value: string): boolean {
  const normalized = decodeBasicEntities(value)
    .replace(/[\u0000-\u0020\u007f-\u009f]/g, '')
    .toLowerCase();
  return normalized.startsWith('javascript:');
}

/** 单个标签清洗：去 on* 事件属性、去 javascript: 协议 */
function sanitizeSingleTag(tag: string): string {
  let output = tag.replace(EVENT_ATTRIBUTE_PATTERN, '');
  output = output.replace(
    ATTRIBUTE_PATTERN,
    (
      match: string,
      name: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      bare: string | undefined,
    ) => {
      if (!URL_ATTRIBUTE_NAMES.has(name.toLowerCase())) {
        return match;
      }
      const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
      return isJavascriptProtocol(value) ? '' : match;
    },
  );
  return output.replace(/javascript\s*:/gi, '');
}

/** 移除危险标签及其内容（成对、未闭合、残余标签三层处理） */
function stripDangerousBlocks(html: string): string {
  let output = html;
  let previous = '';
  while (output !== previous) {
    previous = output;
    output = output.replace(BLOCKED_PAIRED_TAG_RE, '');
  }
  output = output.replace(BLOCKED_UNCLOSED_TAG_RE, '');
  output = output.replace(BLOCKED_TAG_RE, '');
  return output;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 补全 html 骨架（仅补缺失部分，不改写已有内容） */
function ensureHtmlSkeleton(html: string): string {
  let output = html.trim();
  if (!/<html[\s>]/i.test(output)) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${output}</body></html>`;
  }
  if (!/<!doctype\s+html/i.test(output)) {
    output = `<!DOCTYPE html>${output}`;
  }
  if (!/<head[\s>]/i.test(output)) {
    output = output.replace(/<html\b([^>]*)>/i, `<html$1><head><meta charset="utf-8"></head>`);
  }
  if (!/<body[\s>]/i.test(output)) {
    const headClose = /<\/head\s*>/i.exec(output);
    if (headClose) {
      const insertAt = headClose.index + headClose[0].length;
      const before = output.slice(0, insertAt);
      const rest = output.slice(insertAt);
      const htmlClose = /<\/html\s*>\s*$/i.exec(rest);
      const inner = htmlClose ? rest.slice(0, htmlClose.index) : rest;
      output = `${before}<body>${inner}</body>${htmlClose ? '</html>' : ''}`;
    } else {
      const htmlOpen = /<html\b[^>]*>/i.exec(output);
      if (htmlOpen) {
        const insertAt = htmlOpen.index + htmlOpen[0].length;
        output = `${output.slice(0, insertAt)}<body>${output.slice(insertAt)}</body>`;
      }
    }
  }
  return output;
}

/**
 * 生成可直接发送的 HTML 正文：
 * 移除危险标签/事件属性/协议 → 无标签时 <pre> 包裹并转义 → 补全骨架。
 */
function prepareHtmlDocument(rawBody: string): string {
  let html = stripDangerousBlocks(rawBody);
  html = html.replace(TAG_PATTERN, (tag: string) => sanitizeSingleTag(tag));
  html = html.replace(/javascript\s*:/gi, '');
  if (!HTML_TAG_RE.test(html)) {
    html = `<pre>${escapeHtml(html)}</pre>`;
  }
  return ensureHtmlSkeleton(html);
}

/**
 * send_email 工具执行体入口（main-agent.ts send_email 分支调用；不注册进 executor-registry）。
 * 任何执行异常都在内部收敛为 success=false 的 ToolResult，不向调用方抛错。
 */
export async function executeSendEmailTool(
  rawArguments: string,
  context?: Partial<ToolRuntimeContext>,
): Promise<ToolResult> {
  const startedAtMs = Date.now();

  // 0. 执行层能力拦截
  if (!isWatchRuntimeRunning()) {
    return buildToolResult({
      success: false,
      code: 'TOOL_DISABLED_WATCH_OFF',
      message: '值守模式未开启或未在运行，send_email 工具不可用。请在值守服务运行中再调用本工具。',
    });
  }

  // 1. 参数解析与校验
  let parsedArguments: Record<string, unknown>;
  try {
    const parsed: unknown = rawArguments ? JSON.parse(rawArguments) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('工具参数必须是 JSON 对象');
    }
    parsedArguments = parsed as Record<string, unknown>;
  } catch (error) {
    return buildToolResult({
      success: false,
      code: 'TOOL_ARGUMENTS_INVALID',
      message: `send_email 参数无效：${errorText(error)}。请按工具 Schema 修正后重试。`,
      data: { stage: 'validate', detail: errorText(error) },
    });
  }

  const subject = cleanOptionalString(parsedArguments.subject);
  if (!subject || subject.length > 200) {
    return buildToolResult({
      success: false,
      code: 'TOOL_ARGUMENTS_INVALID',
      message: 'send_email 参数无效：subject 必须为 1–200 字符的字符串。',
      data: { stage: 'validate', detail: `subject 长度 ${subject.length}` },
    });
  }
  const body = typeof parsedArguments.body === 'string' ? parsedArguments.body : '';
  if (!body || body.length > BODY_MAX_LENGTH) {
    return buildToolResult({
      success: false,
      code: 'TOOL_ARGUMENTS_INVALID',
      message: `send_email 参数无效：body 必须为 1–${BODY_MAX_LENGTH} 字符的字符串。`,
      data: { stage: 'validate', detail: `body 长度 ${body.length}` },
    });
  }
  const explicitTo = cleanOptionalString(parsedArguments.to);
  if (explicitTo && !EMAIL_RE.test(explicitTo)) {
    return emailFailure('EMAIL_RECIPIENT_INVALID', 'validate', '收件人地址非法，请检查 to 字段格式。', explicitTo);
  }
  if (parsedArguments.attachments !== undefined && !Array.isArray(parsedArguments.attachments)) {
    return buildToolResult({
      success: false,
      code: 'TOOL_ARGUMENTS_INVALID',
      message: 'send_email 参数无效：attachments 必须为字符串数组（本地文件绝对路径或 http(s) URL）。',
      data: { stage: 'validate', detail: 'attachments 非 array' },
    });
  }
  const attachmentItems = (parsedArguments.attachments as unknown[] | undefined) ?? [];
  for (const item of attachmentItems) {
    if (typeof item !== 'string' || !item.trim()) {
      return buildToolResult({
        success: false,
        code: 'TOOL_ARGUMENTS_INVALID',
        message: 'send_email 参数无效：attachments 元素必须为非空字符串（本地文件绝对路径或 http(s) URL）。',
        data: { stage: 'validate', detail: String(item) },
      });
    }
  }

  // 2. 值守配置与收件人缺省解析
  const settings = configManager.getSettings();
  const mailbox = cleanOptionalString(settings.watchMailboxAddress);
  const authCode = cleanOptionalString(settings.watchMailboxAuthCode);
  if (!mailbox || !authCode) {
    return emailFailure(
      'EMAIL_AUTH_FAILED',
      'auth',
      '值守邮箱或授权码配置缺失，无法发送邮件。',
      'watchMailboxAddress / watchMailboxAuthCode 为空',
    );
  }
  const resolvedTo =
    explicitTo || cleanOptionalString(settings.watchReceiptRecipient) || mailbox;
  if (!EMAIL_RE.test(resolvedTo)) {
    return emailFailure(
      'EMAIL_RECIPIENT_INVALID',
      'validate',
      '收件人地址非法（to 与缺省解析结果均无效），请检查。',
      resolvedTo,
    );
  }

  // 3. 值守指令上下文（线程头只由代码补全，模型不可见）
  const conversationId = cleanOptionalString(context?.conversationId);
  const commandContext = conversationId ? getWatchCommandContext(conversationId) : null;
  const inReplyTo = commandContext?.commandMessageId ?? '';

  // 4. 附件三类根校验（本地路径）
  const conversationDir = conversationId ? resolveConversationDir(conversationId) : '';
  const monthlyOutputDir = resolveMonthlyOutputDir();
  const attachmentsRootDir = path.join(app.getPath('userData'), 'watch-attachments');
  const allowedRoots = [conversationDir, monthlyOutputDir, attachmentsRootDir].filter(Boolean);

  const pendingAttachments: PendingAttachment[] = [];
  let localAttachmentBytes = 0;
  for (const rawItem of attachmentItems) {
    const item = String(rawItem).trim();
    if (HTTP_URL_RE.test(item)) {
      pendingAttachments.push({ kind: 'url', url: item });
      continue;
    }
    if (isNonHttpProtocol(item)) {
      return emailFailure(
        'EMAIL_ATTACHMENT_PATH_FORBIDDEN',
        'validate',
        `附件仅支持 http(s) URL 或本地文件路径（已拒绝 file:// 等其它协议）：${item}`,
        item,
      );
    }
    const resolution = resolveLocalAttachment(item, allowedRoots);
    if (!resolution.ok) {
      return resolution.result;
    }
    localAttachmentBytes += resolution.size;
    pendingAttachments.push({ kind: 'file', path: resolution.realPath });
  }

  // 5. 动态超时（90s + 每附件 30s + 每 2MB 加 10s，不封顶）
  const timeoutMs =
    SEND_TIMEOUT_BASE_MS +
    pendingAttachments.length * SEND_TIMEOUT_PER_ATTACHMENT_MS +
    Math.floor(localAttachmentBytes / (2 * 1024 * 1024)) * SEND_TIMEOUT_PER_2MB_MS;
  const deadlineMs = startedAtMs + timeoutMs;

  // 6. 附件内容准备（URL 用全局 fetch 下载；本地文件读取）
  const attachments: ResolvedAttachment[] = [];
  try {
    for (let index = 0; index < pendingAttachments.length; index += 1) {
      const entry = pendingAttachments[index];
      if (!entry) {
        continue;
      }
      if (entry.kind === 'url') {
        const remaining = deadlineMs - Date.now();
        if (remaining <= 0) {
          throw new DeadlineExceededError(
            `发送超时（动态阈值 ${Math.round(timeoutMs / 1000)}s）：附件下载前已耗尽时间预算`,
          );
        }
        attachments.push(await downloadAttachment(entry.url, index, remaining));
        continue;
      }
      let content: Buffer;
      try {
        content = readFileSync(entry.path);
      } catch (error) {
        return emailFailure(
          'EMAIL_ATTACHMENT_READ_FAILED',
          'validate',
          `附件读取失败（权限不足或被占用）：${entry.path}`,
          errorText(error),
        );
      }
      attachments.push({ fileName: path.basename(entry.path), content });
    }
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      const safeError = maskAuthCode(errorText(error), authCode);
      return emailFailure(
        'EMAIL_TIMEOUT',
        'send',
        `发送超时（stage=send）：${safeError}。可重试（同一失败原因不超过 2 次）。`,
        safeError,
      );
    }
    if (error instanceof AttachmentDownloadError) {
      const safeError = maskAuthCode(errorText(error), authCode);
      return emailFailure(
        'EMAIL_ATTACHMENT_NOT_FOUND',
        'download',
        `附件 URL 下载失败（stage=download）：${safeError}。请修正 URL 后重试。`,
        safeError,
      );
    }
    const safeError = maskAuthCode(errorText(error), authCode);
    return emailFailure(
      'EMAIL_INTERNAL',
      'download',
      `附件下载内部错误（stage=download）：${safeError}`,
      safeError,
    );
  }

  // 7. 正文清洗与头组装
  const html = prepareHtmlDocument(body);
  const headers: SmtpHeaderInput[] = [];
  if (inReplyTo) {
    headers.push({ name: 'In-Reply-To', value: inReplyTo });
    headers.push({ name: 'References', value: inReplyTo });
  }
  headers.push({ name: 'X-Delepi-Role', value: 'agent' });
  if (commandContext?.requestId) {
    headers.push({ name: 'X-Delepi-Command-Id', value: commandContext.requestId });
  }

  // 8. SMTP 发送（剩余时间预算作为整体超时）
  const smtpTimeoutMs = Math.max(1000, deadlineMs - Date.now());
  const outcome = await sendSmtpMail({
    host: WATCH_SMTP_ENDPOINT.host,
    port: WATCH_SMTP_ENDPOINT.port,
    mailbox,
    authCode,
    to: resolvedTo,
    subject,
    html,
    headers,
    attachments,
    timeoutMs: smtpTimeoutMs,
  });

  if (outcome.ok) {
    if (commandContext) {
      markWatchCommandReceiptSent(
        conversationId,
        resolvedTo,
        outcome.declaredMessageId,
        outcome.attachmentCount,
      );
    }
    // BUG3 登记侧：出站邮件映射（不依赖指令上下文——本地对话发起的 run 同样登记），
    // 供收信侧把「用户直接回复本邮件」关联回原对话；登记失败不影响发送结果（内部已收敛）
    if (conversationId && outcome.declaredMessageId) {
      registerOutboundMail({
        messageId: outcome.declaredMessageId,
        conversationId,
        sentTo: resolvedTo,
        subject,
        sentAtIso: new Date().toISOString(),
      });
    }
    return buildToolResult({
      success: true,
      code: 'EMAIL_SENT',
      message: '邮件已发送',
      data: {
        to: resolvedTo,
        subject,
        messageId: outcome.declaredMessageId,
        acceptedRecipients: outcome.acceptedRecipients,
        refusedRecipients: outcome.refusedRecipients,
        attachmentCount: outcome.attachmentCount,
        attachmentBytes: outcome.attachmentBytes,
        elapsedMs: Date.now() - startedAtMs,
        smtpEndpoint: `${WATCH_SMTP_ENDPOINT.host}:${WATCH_SMTP_ENDPOINT.port}`,
        ...(inReplyTo ? { inReplyTo } : {}),
      },
    });
  }

  // 9. 失败分类透传（错误文本已由 smtp-client 脱敏，此处再次兜底）
  const safeError = maskAuthCode(outcome.error, authCode);
  const refusedExtra = outcome.refusedRecipients.length
    ? { refusedRecipients: outcome.refusedRecipients }
    : undefined;
  if (outcome.stage === 'auth') {
    return emailFailure(
      'EMAIL_AUTH_FAILED',
      'auth',
      `登录阶段失败（stage=auth）：${safeError}。请检查授权码是否正确、SMTP 服务是否开启。`,
      safeError,
      refusedExtra,
    );
  }
  if (outcome.stage === 'timeout') {
    return emailFailure(
      'EMAIL_TIMEOUT',
      'send',
      `发送超时（stage=send）：${safeError}。可重试（同一失败原因不超过 2 次）。`,
      safeError,
      refusedExtra,
    );
  }
  if (outcome.stage === 'send' && safeError.startsWith('REJECTED:')) {
    return emailFailure(
      'EMAIL_SEND_REJECTED',
      'send',
      `服务端拒收（stage=send）：${safeError}。不得擅自截断、压缩或拆分交付文件；应在正文中如实说明并给出替代获取方式。`,
      safeError,
      refusedExtra,
    );
  }
  if (outcome.stage === 'send') {
    return emailFailure(
      'EMAIL_NETWORK_ERROR',
      'send',
      `发送阶段失败（stage=send）：${safeError}。可重试（同一失败原因不超过 2 次）。`,
      safeError,
      refusedExtra,
    );
  }
  if (outcome.stage === 'connect') {
    return emailFailure(
      'EMAIL_NETWORK_ERROR',
      'connect',
      `网络连接失败（stage=connect）：${safeError}。可重试（同一失败原因不超过 2 次）。`,
      safeError,
      refusedExtra,
    );
  }
  return emailFailure(
    'EMAIL_INTERNAL',
    'validate',
    `内部错误：${safeError}`,
    safeError,
    refusedExtra,
  );
}
