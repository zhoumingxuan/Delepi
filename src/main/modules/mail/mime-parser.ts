/**
 * mime-parser — 纯 Node.js MIME 解析（阶段7 目标2：收信桥 Node 化的解析层）
 *
 * 覆盖范围（与被替换的旧桥解析实现对齐）：
 * - 头部折行（RFC 5322 folding / unfolding）
 * - RFC 2047 编码字（=?UTF-8?B?...?= / =?GBK?Q?...?=），支持 B 与 Q 两种编码
 * - multipart/alternative、multipart/mixed、multipart/related 递归展开
 * - Content-Transfer-Encoding：base64 / quoted-printable / 7bit / 8bit / binary
 * - 字符集解码：UTF-8、GB18030（含 GB2312/GBK 别名）、Big5、ISO-8859-1、windows-1252、
 *   UTF-16LE；全部经 TextDecoder（Electron 自带 ICU），不支持的标签逐级回落 UTF-8 → latin1
 * - 正文取值优先级与旧桥一致：优先 text/plain，缺失时取 text/html 去标签，正文截断 25000 字符
 * - 明确跳过 Content-Disposition: attachment 的部件（附件正文不能进指令解析）
 *
 * 设计约束：
 * - 零第三方依赖，只用 node:buffer 与内置 TextDecoder；
 * - 纯函数、无 IO、无 electron 依赖，可直接在受控 harness 中加载断言。
 */

/** 正文文本硬上限（与被替换的旧桥 BODY_TEXT_LIMIT 完全一致） */
export const MAX_BODY_TEXT_CHARS = 25_000;

/** MIME 部件（头部 + 原始 body 字节） */
export interface MimePart {
  headers: Record<string, string>;
  body: Buffer;
}

/** 解析结果（收信桥只消费 headers 与 bodyText） */
export interface ParsedMailMessage {
  /** 头部小写键 → 原始（已 unfolding、未做 RFC 2047 解码）值；同名头保留第一次出现 */
  headers: Record<string, string>;
  /** 正文纯文本（优先 text/plain，回退 html 去标签，截断 25000 字符） */
  bodyText: string;
  /** 顶层 Content-Type（小写，不含参数） */
  contentType: string;
}

/** 字符集别名归一（GB2312/GBK 一律按 GB18030 解，覆盖汉字全集，避免生僻字乱码） */
const CHARSET_ALIASES: Record<string, string> = {
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  ascii: 'utf-8',
  'us-ascii': 'utf-8',
  gb2312: 'gb18030',
  'gb2312-80': 'gb18030',
  gbk: 'gb18030',
  gb18030: 'gb18030',
  big5: 'big5',
  'big-5': 'big5',
  latin1: 'iso-8859-1',
  'iso-8859-1': 'iso-8859-1',
  'windows-1252': 'windows-1252',
  'utf-16': 'utf-16le',
  'utf-16le': 'utf-16le',
  utf16: 'utf-16le',
};

/** TextDecoder 可用性缓存（ICU 缺失时避免反复抛错） */
const decoderSupportCache = new Map<string, boolean>();

function canDecode(label: string): boolean {
  const cached = decoderSupportCache.get(label);
  if (cached !== undefined) {
    return cached;
  }
  let ok = false;
  try {
    // 仅探测构造是否抛错，不实际解码
    new TextDecoder(label);
    ok = true;
  } catch {
    ok = false;
  }
  decoderSupportCache.set(label, ok);
  return ok;
}

/** 字符集标签归一（非法/空 → utf-8） */
export function normalizeCharset(charset: string | undefined): string {
  const raw = String(charset ?? '').trim().toLowerCase().replace(/^"|"$/g, '');
  if (!raw) {
    return 'utf-8';
  }
  return CHARSET_ALIASES[raw] ?? raw;
}

/**
 * 按字符集解码字节：请求字符集 → utf-8 → iso-8859-1 逐级回落。
 * 回落顺序保证「绝不返回乱码英文」优先于「严格保真」：真实邮件里 GBK 头/体最常见。
 */
export function decodeBytesWithCharset(body: Buffer, charset: string | undefined): string {
  const requested = normalizeCharset(charset);
  const candidates = [requested];
  if (!candidates.includes('utf-8')) {
    candidates.push('utf-8');
  }
  if (!candidates.includes('iso-8859-1')) {
    candidates.push('iso-8859-1');
  }
  for (const label of candidates) {
    if (!canDecode(label)) {
      continue;
    }
    try {
      return new TextDecoder(label, { fatal: false }).decode(body);
    } catch {
      // 继续下一候选
    }
  }
  return body.toString('latin1');
}

/** 把一行的原始字节形式的 `=XX` 还原成字节 */
function decodeQpTokenBytes(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '=') {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
      bytes.push(0x3d);
      continue;
    }
    const code = text.charCodeAt(i);
    bytes.push(code > 0xff ? 0x3f : code);
  }
  return Buffer.from(bytes);
}

/** quoted-printable 解码（支持软换行 `=` + CRLF、`=XX` 与非法序列原样保留） */
export function decodeQuotedPrintable(input: Buffer | string): Buffer {
  const text = typeof input === 'string' ? input : input.toString('latin1');
  const withoutSoftBreaks = text.replace(/=\r\n/g, '').replace(/=\n/g, '');
  return decodeQpTokenBytes(withoutSoftBreaks);
}

/** base64 解码（容忍换行、空格与非法字符；填充缺失自动补齐） */
export function decodeBase64Body(input: Buffer | string): Buffer {
  const text = typeof input === 'string' ? input : input.toString('latin1');
  const cleaned = text.replace(/[^A-Za-z0-9+/=]/g, '');
  if (!cleaned) {
    return Buffer.alloc(0);
  }
  return Buffer.from(cleaned, 'base64');
}

/** 按 Content-Transfer-Encoding 解码 body */
export function decodeTransferEncoding(body: Buffer, encoding: string | undefined): Buffer {
  const normalized = String(encoding ?? '').trim().toLowerCase();
  if (normalized === 'base64') {
    return decodeBase64Body(body);
  }
  if (normalized === 'quoted-printable') {
    return decodeQuotedPrintable(body);
  }
  return body;
}

/** 把 `=?charset?B|Q?data?=` 编码字解码为 UTF-8 文本（相邻编码字之间的空白按 RFC 2047 折叠） */
export function decodeEncodedWords(value: string): string {
  if (!value || !value.includes('=?')) {
    return value;
  }
  const joined = value.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return joined.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g, (matched, charset: string, encoding: string, data: string) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return decodeBytesWithCharset(decodeBase64Body(data), charset);
      }
      const bytes = decodeQpTokenBytes(data.replace(/_/g, ' '));
      return decodeBytesWithCharset(bytes, charset);
    } catch {
      return matched;
    }
  });
}

/** 头部值解码（RFC 2047 + 折行残留空白归一） */
export function decodeHeaderValue(value: string | undefined): string {
  const raw = String(value ?? '');
  if (!raw) {
    return '';
  }
  return decodeEncodedWords(raw).replace(/\s+/g, ' ').trim();
}

/** 解析 Content-Type：返回小写 type 与小写参数名映射（参数值去引号） */
export function parseContentType(value: string | undefined): { type: string; params: Record<string, string> } {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return { type: 'text/plain', params: {} };
  }
  const segments = splitSemicolon(raw);
  const type = (segments.shift() ?? '').trim().toLowerCase() || 'text/plain';
  const params: Record<string, string> = {};
  for (const segment of segments) {
    const eq = segment.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = segment.slice(0, eq).trim().toLowerCase();
    let val = segment.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    if (key) {
      params[key] = val;
    }
  }
  return { type, params };
}

/** 按分号切分（忽略引号内的分号） */
function splitSemicolon(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '"' && value[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === ';' && !inQuotes) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** 头部/正文分界：优先 CRLFCRLF，其次 LFLF / CRCR */
export function splitHeaderBlock(raw: Buffer): MimePart {
  const patterns: Array<Buffer> = [Buffer.from('\r\n\r\n', 'latin1'), Buffer.from('\n\n', 'latin1'), Buffer.from('\r\r', 'latin1')];
  for (const pattern of patterns) {
    const index = raw.indexOf(pattern);
    if (index >= 0) {
      return {
        headers: parseHeaderLines(raw.subarray(0, index).toString('utf8')),
        body: raw.subarray(index + pattern.length),
      };
    }
  }
  // 无正文（只有头部）
  return { headers: parseHeaderLines(raw.toString('utf8')), body: Buffer.alloc(0) };
}

/** 头部行解析：先 unfolding，再逐行拆分；同名头只保留第一次出现 */
export function parseHeaderLines(headerText: string): Record<string, string> {
  const unfolded = headerText.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};
  for (const line of unfolded.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!name) {
      continue;
    }
    if (!(name in headers)) {
      headers[name] = value;
    }
  }
  return headers;
}

/**
 * multipart 切分：boundary 前必须有行首 `--`；返回各部件（头部 + body 字节）。
 * 做法：把 body 以 latin1 文本处理（1 字节 ↔ 1 字符，二进制无损），按 `\r\n--boundary`
 * 或 `\n--boundary` 切分，再逐段用 latin1 还原为 Buffer。
 */
export function splitMultipart(body: Buffer, boundary: string): MimePart[] {
  if (!boundary) {
    return [];
  }
  const text = body.toString('latin1');
  // 兼容两种真实形态：body 以 `--boundary` 直接开头，或先有 preamble 再出现 `CRLF--boundary`
  const normalized = text.startsWith(`--${boundary}`) ? `\r\n${text}` : text;
  const crlfDelimiter = `\r\n--${boundary}`;
  const lfDelimiter = `\n--${boundary}`;
  const delimiter = normalized.includes(crlfDelimiter) ? crlfDelimiter : lfDelimiter;
  if (!normalized.includes(delimiter)) {
    return [];
  }
  const chunks = normalized.split(delimiter);
  const parts: MimePart[] = [];
  for (let i = 1; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (chunk.startsWith('--')) {
      break; // 结束边界
    }
    const withoutLeadingNewline = chunk.replace(/^[ \t]*\r?\n/, '');
    const withoutTrailingNewline = withoutLeadingNewline.replace(/\r?\n$/, '');
    const parsed = splitHeaderBlock(Buffer.from(withoutTrailingNewline, 'latin1'));
    parts.push(parsed);
  }
  return parts;
}

/** HTML → 纯文本：去 script/style 内容、去标签、实体解码、空白归一（与旧桥「标签替换为空格」等价） */
export function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(withoutTags).replace(/[ \t\u00a0]+/g, ' ');
}

/** 常见 HTML 实体解码（只覆盖邮件正文实际出现的六种 + 数字实体） */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d{1,6});/g, (_m, code: string) => {
      const value = Number(code);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : _m;
    });
}

interface CollectedText {
  plain: string | null;
  html: string | null;
}

/** 递归收集正文文本部件 */
function collectTextParts(headers: Record<string, string>, body: Buffer, collected: CollectedText): void {
  const contentType = parseContentType(headers['content-type']);
  if (contentType.type.startsWith('multipart/')) {
    const boundary = contentType.params.boundary ?? '';
    for (const part of splitMultipart(body, boundary)) {
      collectTextParts(part.headers, part.body, collected);
    }
    return;
  }
  const disposition = String(headers['content-disposition'] ?? '').toLowerCase();
  if (disposition.includes('attachment')) {
    return; // 附件正文不参与指令解析
  }
  const decoded = decodeTransferEncoding(body, headers['content-transfer-encoding']);
  const text = decodeBytesWithCharset(decoded, contentType.params.charset);
  if (contentType.type === 'text/plain') {
    if (collected.plain === null) {
      collected.plain = text;
    }
    return;
  }
  if (contentType.type === 'text/html') {
    if (collected.html === null) {
      collected.html = text;
    }
  }
}

/**
 * 解析整封邮件：返回小写头映射、正文文本（≤25000 字符）与顶层 Content-Type。
 * 与旧桥 build_mail_entry 的取值顺序保持一致：plain 优先，其次 html 去标签。
 */
export function parseMimeMessage(raw: Buffer): ParsedMailMessage {
  const root = splitHeaderBlock(raw);
  const collected: CollectedText = { plain: null, html: null };
  collectTextParts(root.headers, root.body, collected);
  let bodyText = '';
  if (collected.plain !== null) {
    bodyText = collected.plain;
  } else if (collected.html !== null) {
    bodyText = htmlToText(collected.html);
  }
  if (bodyText.length > MAX_BODY_TEXT_CHARS) {
    bodyText = bodyText.slice(0, MAX_BODY_TEXT_CHARS);
  }
  return {
    headers: root.headers,
    bodyText,
    contentType: parseContentType(root.headers['content-type']).type,
  };
}

/**
 * 提取首个邮箱地址（等价旧桥 parseaddr(From)[1].strip().lower()）：
 * - `"姓名" <a@b.com>` / `<a@b.com>` / `a@b.com`
 * - 带注释 `a@b.com (姓名)` 时取注释前的地址
 * - 解析失败返回空串（调用方按空 From 处理为 sender_rejected）
 */
export function parseFirstAddress(value: string | undefined): string {
  const raw = String(value ?? '');
  if (!raw) {
    return '';
  }
  const angle = /<([^<>]+)>/.exec(raw);
  let candidate = angle ? angle[1] : raw;
  candidate = candidate.replace(/\([^()]*\)/g, ' ');
  candidate = candidate.replace(/^[\s"']+|[\s"']+$/g, '');
  if (candidate.includes(',')) {
    candidate = candidate.split(',')[0];
  }
  const match = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/.exec(candidate);
  return match ? match[0].toLowerCase() : '';
}
