/**
 * imap-client — 纯 Node.js IMAP 收信客户端（阶段7 目标2：替换原内嵌解释器脚本桥）
 *
 * 能力范围（与被删除的旧桥逐项等价）：
 * - 建连：隐式 TLS（993，tls.connect + servername + rejectUnauthorized:true）
 *   或 STARTTLS（明文建连 → STARTTLS 命令 → 同 socket 升级 TLS）
 * - 登录：AUTH 走 LOGIN 命令（QQ 实测支持；失败返回 NO/BAD → 认证阶段错误，一次即回落）
 * - 会话准备：ID 命令（best effort，失败忽略）→ EXAMINE "INBOX"（只读打开，不置已读标志）
 * - 收信①：UID FETCH <sinceUid+1>:* BODY.PEEK[]（UID 增量；星号语义可能多带回一封旧邮件，
 *   调用方按 uid > sinceUid 过滤）
 * - 收信②：UID SEARCH SINCE <DD-Mon-YYYY> → 取最新至多 N 个 UID → UID FETCH (INTERNALDATE BODY.PEEK[])
 * - 退出：LOGOUT（best effort）
 *
 * 协议解析（阶段6 实测坑位的根治）：
 * - 自实现响应解析器，按「tag + token 树」解析，原生处理 IMAP literal（{n} + CRLF + n 字节），
 *   不再依赖旧桥「tuple + 紧随独立响应项」的解析语义；
 * - INTERNALDATE 在 head 内或在同一响应里独立出现都能取到（见 parseFetchResponses 的合并逻辑），
 *   服务端把 INTERNALDATE 作为紧随 tuple 的独立响应项返回时仍能取到该字符串。
 *
 * 错误阶段（三类 + 超时）：
 * - 'connect'：TCP/TLS 建连、问候语、STARTTLS 升级失败
 * - 'auth'   ：LOGIN 被拒（QQ 返回 NO [AUTHENTICATIONFAILED]），调用方一次即回落关闭
 * - 'recv'   ：登录成功后的 EXAMINE / SEARCH / FETCH 失败
 * - 'timeout'：整体超时或 socket 空闲超时
 * 所有错误文本在返回前用 maskAuthCode 脱敏（明文/ base64 / base64url / URL 编码四种形态）。
 *
 * 设计约束：
 * - 只使用 node:net / node:tls / node:buffer 等内置模块，零第三方依赖；
 * - 不 import electron，端点与凭据全部由调用方注入，便于受控 harness 直连本地 mock 服务端；
 * - 提供 createImapSession(socket) 注入缝：单测可用 net.connect 的明文 socket 驱动完整命令序列。
 */

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions as TlsConnectionOptions, type TLSSocket } from 'node:tls';
import type { MailEndpoint } from './mail-provider';
import { maskAuthCode } from './smtp-client';

/** IMAP 失败阶段 */
export type ImapFailureStage = 'connect' | 'auth' | 'recv' | 'timeout';

/** IMAP 失败结果 */
export interface ImapFailure {
  ok: false;
  stage: ImapFailureStage;
  error: string;
}

/** IMAP 成功/失败联合 */
export type ImapResult<T> = { ok: true; data: T } | ImapFailure;

/** 单封邮件的原始取回结果（MIME 解析在 mime-parser 层完成） */
export interface RawImapMessage {
  uid: number;
  /** INTERNALDATE 原始字符串（例如 26-Oct-2026 19:38:16 +0800）；服务端未返回时为空串 */
  internalDateRaw: string;
  /** BODY.PEEK[] 原始字节 */
  body: Buffer;
}

/** 收信结果（uidvalidity/uidnext 仅用于日志与诊断，不再作为水位） */
export interface ImapFetchResult {
  uidvalidity: number;
  uidnext: number;
  messages: RawImapMessage[];
}

/** 登录参数（端点 + 凭据；凭据只在本次命令写入中出现） */
export interface ImapAuthParams {
  endpoint: MailEndpoint;
  mailbox: string;
  authCode: string;
  /** 整体超时（毫秒），默认 45000（与旧桥 OP_TIMEOUT=25s 之上的整体兜底一致） */
  timeoutMs?: number;
  /** 额外 TLS 参数（测试注入自签 CA 用；生产不传，走 rejectUnauthorized:true） */
  tlsOptions?: TlsConnectionOptions;
  /**
   * socket 工厂注入缝（受控测试专用）：提供后跳过内置 TLS/TCP 建连，
   * 直接使用返回的 socket 走后续协议流程（可用本地明文 mock IMAP 服务端驱动完整命令序列）。
   * 生产调用一律不传，端点加密方式仍由 endpoint.encryption 决定。
   */
  socketFactory?: (endpoint: MailEndpoint) => Promise<Socket>;
}

/** 阶段错误（内部使用，对外统一转 ImapFailure） */
class ImapStageError extends Error {
  readonly stage: ImapFailureStage;

  constructor(stage: ImapFailureStage, message: string) {
    super(message);
    this.name = 'ImapStageError';
    this.stage = stage;
  }
}

// ---------------------------------------------------------------------------
// 响应解析：tag + token 树（支持 literal）
// ---------------------------------------------------------------------------

export type ImapToken =
  | { kind: 'atom'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'literal'; value: Buffer }
  | { kind: 'list'; items: ImapToken[] };

export interface ImapResponse {
  /** '*' 表示未标记响应；'+' 表示续行；其余为命令 tag */
  tag: string;
  /** 标记响应状态词大写（OK/NO/BAD/BYE/PREAUTH）；未标记响应为 'UNTAGGED'；续行为 'CONTINUATION' */
  status: string;
  tokens: ImapToken[];
}

interface ParseOk {
  ok: true;
  response: ImapResponse;
  consumed: number;
}
interface ParseNeedMore {
  ok: false;
  needMore: true;
}
interface ParseError {
  ok: false;
  needMore: false;
  error: string;
}
type ParseOutcome = ParseOk | ParseNeedMore | ParseError;

/**
 * 从 buffer 起点解析一条完整响应。
 * - 不完整（CRLF 未到 / literal 字节不足）→ needMore，调用方继续收数据；
 * - 语法错误 → error（调用方按协议错误收口）。
 */
export function parseImapResponseAt(buffer: Buffer): ParseOutcome {
  let i = 0;
  // ---- tag ----
  while (i < buffer.length && buffer[i] !== 0x20 && buffer[i] !== 0x0d && buffer[i] !== 0x0a) {
    i += 1;
  }
  if (i >= buffer.length) {
    return { ok: false, needMore: true };
  }
  const tag = buffer.subarray(0, i).toString('latin1');
  while (i < buffer.length && (buffer[i] === 0x20 || buffer[i] === 0x09)) {
    i += 1;
  }

  const root: ImapToken[] = [];
  const stack: ImapToken[][] = [root];
  const push = (token: ImapToken): void => {
    stack[stack.length - 1].push(token);
  };

  for (;;) {
    if (i >= buffer.length) {
      return { ok: false, needMore: true };
    }
    const byte = buffer[i];
    if (byte === 0x0d) {
      if (i + 1 >= buffer.length) {
        return { ok: false, needMore: true };
      }
      i += buffer[i + 1] === 0x0a ? 2 : 1;
      break;
    }
    if (byte === 0x0a) {
      i += 1;
      break;
    }
    if (byte === 0x20 || byte === 0x09) {
      i += 1;
      continue;
    }
    if (byte === 0x28) {
      const list: ImapToken[] = [];
      push({ kind: 'list', items: list });
      stack.push(list);
      i += 1;
      continue;
    }
    if (byte === 0x29) {
      if (stack.length > 1) {
        stack.pop();
      }
      i += 1;
      continue;
    }
    if (byte === 0x22) {
      let j = i + 1;
      let text = '';
      let closed = false;
      while (j < buffer.length) {
        const inner = buffer[j];
        if (inner === 0x5c) {
          if (j + 1 >= buffer.length) {
            return { ok: false, needMore: true };
          }
          text += String.fromCharCode(buffer[j + 1]);
          j += 2;
          continue;
        }
        if (inner === 0x22) {
          closed = true;
          j += 1;
          break;
        }
        text += String.fromCharCode(inner);
        j += 1;
      }
      if (!closed) {
        return { ok: false, needMore: true };
      }
      push({ kind: 'string', value: text });
      i = j;
      continue;
    }
    if (byte === 0x7b) {
      // literal: {<digits>}\r\n<bytes>
      let j = i + 1;
      let digits = '';
      while (j < buffer.length && buffer[j] >= 0x30 && buffer[j] <= 0x39) {
        digits += String.fromCharCode(buffer[j]);
        j += 1;
      }
      const isLiteral = digits.length > 0 && j < buffer.length && buffer[j] === 0x7d;
      if (isLiteral) {
        j += 1;
        if (j >= buffer.length) {
          return { ok: false, needMore: true };
        }
        if (buffer[j] === 0x0d) {
          if (j + 1 >= buffer.length) {
            return { ok: false, needMore: true };
          }
          if (buffer[j + 1] !== 0x0a) {
            return { ok: false, needMore: false, error: 'IMAP literal 头后缺少 CRLF' };
          }
          j += 2;
        } else if (buffer[j] === 0x0a) {
          j += 1;
        } else {
          return { ok: false, needMore: false, error: 'IMAP literal 头后缺少换行' };
        }
        const length = Number(digits);
        if (!Number.isFinite(length) || length < 0 || length > 64 * 1024 * 1024) {
          return { ok: false, needMore: false, error: `IMAP literal 长度非法：${digits}` };
        }
        if (buffer.length < j + length) {
          return { ok: false, needMore: true };
        }
        push({ kind: 'literal', value: buffer.subarray(j, j + length) });
        i = j + length;
        continue;
      }
      // 不是 literal 起点：按 atom 继续（例如 BODY[HEADER.FIELDS (X-Y)] 里的 { 极少见）
    }
    // atom
    let k = i;
    while (k < buffer.length) {
      const inner = buffer[k];
      if (inner === 0x20 || inner === 0x09 || inner === 0x0d || inner === 0x0a || inner === 0x28 || inner === 0x29) {
        break;
      }
      k += 1;
    }
    if (k >= buffer.length) {
      return { ok: false, needMore: true };
    }
    push({ kind: 'atom', value: buffer.subarray(i, k).toString('utf8') });
    i = k;
  }

  const response = buildResponse(tag, root);
  return { ok: true, response, consumed: i };
}

function buildResponse(tag: string, root: ImapToken[]): ImapResponse {
  if (tag === '+') {
    return { tag, status: 'CONTINUATION', tokens: root };
  }
  if (tag === '*') {
    return { tag, status: 'UNTAGGED', tokens: root };
  }
  const first = root[0];
  const status = first && first.kind === 'atom' ? first.value.toUpperCase() : '';
  return { tag, status, tokens: root };
}

/** 把 token 树按出现顺序摊平（保留 list 内部顺序） */
export function flattenTokens(tokens: ImapToken[], out: ImapToken[] = []): ImapToken[] {
  for (const token of tokens) {
    if (token.kind === 'list') {
      flattenTokens(token.items, out);
      continue;
    }
    out.push(token);
  }
  return out;
}

/** 从响应里取 `[CODE n]` 形式的数字（UIDVALIDITY / UIDNEXT） */
export function extractResponseCodeNumber(responses: ImapResponse[], code: string): number {
  const wanted = `[${code.toUpperCase()}`;
  for (const response of responses) {
    const flat = flattenTokens(response.tokens);
    for (let i = 0; i < flat.length; i += 1) {
      const token = flat[i];
      if (token.kind !== 'atom' || token.value.toUpperCase() !== wanted) {
        continue;
      }
      const next = flat[i + 1];
      if (next && next.kind === 'atom') {
        const parsed = Number(next.value.replace(/\]$/, ''));
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
  }
  return 0;
}

/**
 * FETCH 响应 → 邮件列表。
 * 同一 UID 的多个 FETCH 响应（服务端把 INTERNALDATE 拆成独立响应项时会出现）按 UID 合并：
 * 取更长的 body 与首个非空 INTERNALDATE —— 阶段6 实测坑位在此根治。
 */
export function parseFetchResponses(responses: ImapResponse[]): RawImapMessage[] {
  const byUid = new Map<number, RawImapMessage>();
  for (const response of responses) {
    if (response.tag !== '*' || response.status !== 'UNTAGGED') {
      continue;
    }
    const flat = flattenTokens(response.tokens);
    const hasFetch = flat.some((token) => token.kind === 'atom' && token.value.toUpperCase() === 'FETCH');
    if (!hasFetch) {
      continue;
    }
    let uid = 0;
    let internalDateRaw = '';
    let body: Buffer | null = null;
    for (let i = 0; i < flat.length; i += 1) {
      const token = flat[i];
      if (token.kind === 'atom') {
        const upper = token.value.toUpperCase();
        if (upper === 'UID') {
          const next = flat[i + 1];
          if (next && next.kind === 'atom' && /^\d+$/.test(next.value)) {
            uid = Number(next.value);
          }
        } else if (upper === 'INTERNALDATE') {
          const next = flat[i + 1];
          if (next && next.kind === 'string') {
            internalDateRaw = next.value;
          } else if (next && next.kind === 'atom') {
            internalDateRaw = next.value;
          }
        }
      } else if (token.kind === 'literal') {
        if (body === null || token.value.length > body.length) {
          body = token.value;
        }
      }
    }
    if (uid <= 0) {
      continue;
    }
    const existing = byUid.get(uid);
    if (!existing) {
      byUid.set(uid, { uid, internalDateRaw, body: body ?? Buffer.alloc(0) });
      continue;
    }
    if (!existing.internalDateRaw && internalDateRaw) {
      existing.internalDateRaw = internalDateRaw;
    }
    if (body && body.length > existing.body.length) {
      existing.body = body;
    }
  }
  return [...byUid.values()].sort((a, b) => a.uid - b.uid);
}

/** SEARCH 响应 → UID 列表（升序去重） */
export function parseSearchResponse(responses: ImapResponse[]): number[] {
  const uids = new Set<number>();
  for (const response of responses) {
    if (response.tag !== '*' || response.status !== 'UNTAGGED') {
      continue;
    }
    const flat = flattenTokens(response.tokens);
    const head = flat[0];
    if (!head || head.kind !== 'atom' || head.value.toUpperCase() !== 'SEARCH') {
      continue;
    }
    for (let i = 1; i < flat.length; i += 1) {
      const token = flat[i];
      if (token.kind === 'atom' && /^\d+$/.test(token.value)) {
        uids.add(Number(token.value));
      }
    }
  }
  return [...uids].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// 响应读取器（可随 STARTTLS 升级重新绑定 socket）
// ---------------------------------------------------------------------------

interface ResponseWaiter {
  resolve: (response: ImapResponse) => void;
  reject: (error: Error) => void;
}

/** 串行响应读取器：同一时刻至多一个等待者（命令严格串行，符合 IMAP 语义） */
export class ImapResponseReader {
  private buffer: Buffer = Buffer.alloc(0);
  private queue: ImapResponse[] = [];
  private waiter: ResponseWaiter | null = null;
  private fatal: Error | null = null;
  private socket: Socket | null = null;
  private readonly onData = (chunk: Buffer): void => {
    this.feed(chunk);
  };
  private readonly onError = (error: Error): void => {
    this.fail(new ImapStageError('connect', `IMAP socket 错误：${error.message}`));
  };
  private readonly onClose = (): void => {
    this.fail(new ImapStageError('connect', 'IMAP 连接已被对端关闭'));
  };
  private readonly onTimeout = (): void => {
    this.fail(new ImapStageError('timeout', 'IMAP 空闲超时，已销毁连接'));
  };

  /** 绑定 socket（STARTTLS 升级后再次调用前需先 detach + reset） */
  attach(socket: Socket): void {
    this.socket = socket;
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
    socket.on('timeout', this.onTimeout);
  }

  /** 解绑当前 socket 的全部监听（幂等） */
  detach(): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    socket.removeListener('data', this.onData);
    socket.removeListener('error', this.onError);
    socket.removeListener('close', this.onClose);
    socket.removeListener('timeout', this.onTimeout);
    this.socket = null;
  }

  /** 清空缓冲与队列（TLS 升级后调用：旧明文流的残余字节全部作废） */
  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.fatal = null;
  }

  /** 是否已失效 */
  get failed(): boolean {
    return this.fatal !== null;
  }

  /** 读取下一条完整响应 */
  next(): Promise<ImapResponse> {
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    if (this.fatal) {
      return Promise.reject(this.fatal);
    }
    return new Promise<ImapResponse>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  /** 注入致命错误（超时定时器/上层中止使用） */
  fail(error: Error): void {
    if (!this.fatal) {
      this.fatal = error;
    }
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.reject(this.fatal);
    }
    const socket = this.socket;
    if (socket && !socket.destroyed) {
      try {
        socket.destroy();
      } catch {
        // 已关闭
      }
    }
  }

  private feed(chunk: Buffer): void {
    if (this.fatal || !chunk || chunk.length === 0) {
      return;
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const outcome = parseImapResponseAt(this.buffer);
      if (outcome.ok) {
        this.buffer = this.buffer.subarray(outcome.consumed);
        this.deliver(outcome.response);
        continue;
      }
      if (outcome.needMore) {
        return;
      }
      this.fail(new ImapStageError('recv', `IMAP 响应解析失败：${outcome.error}`));
      return;
    }
  }

  private deliver(response: ImapResponse): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.resolve(response);
      return;
    }
    this.queue.push(response);
  }
}

// ---------------------------------------------------------------------------
// 连接建立 / 命令执行
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 45_000;

/** IMAP 引号字符串（转义 `\` 与 `"`，去掉 CR/LF 防命令注入） */
function quoteImapString(value: string): string {
  const cleaned = String(value ?? '').replace(/[\r\n]/g, '');
  return `"${cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 解析 IMAP 响应里的状态文本（错误详情用；不含凭据） */
function describeResponse(response: ImapResponse): string {
  const flat = flattenTokens(response.tokens);
  const text = flat
    .map((token) => {
      if (token.kind === 'atom' || token.kind === 'string') {
        return token.value;
      }
      if (token.kind === 'literal') {
        return `<literal ${token.value.length}B>`;
      }
      return '';
    })
    .filter((part) => part.length > 0)
    .join(' ');
  return `${response.status} ${text}`.trim().slice(0, 300);
}

/** 主机是否为 IP 字面量（IP 不发送 SNI：RFC 6066 禁止 IP 作为 server_name） */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** 建立 socket（隐式 TLS 或明文；STARTTLS 的升级在会话流程里做） */
function openSocket(
  endpoint: MailEndpoint,
  timeoutMs: number,
  tlsOptions: TlsConnectionOptions | undefined,
  stage: ImapFailureStage,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(new ImapStageError(stage, `IMAP 建连失败（${endpoint.host}:${endpoint.port}）：${error.message}`));
    };
    if (endpoint.encryption === 'ssl') {
      const socket = tlsConnect({
        host: endpoint.host,
        port: endpoint.port,
        ...(isIpLiteral(endpoint.host) ? {} : { servername: endpoint.host }),
        rejectUnauthorized: true,
        ...tlsOptions,
      });
      socket.setTimeout(timeoutMs);
      socket.once('secureConnect', () => resolve(socket));
      socket.once('error', onError);
      return;
    }
    const socket = netConnect({ host: endpoint.host, port: endpoint.port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => resolve(socket));
    socket.once('error', onError);
  });
}

/** 把已建立的明文 socket 升级为 TLS（STARTTLS） */
function upgradeSocketToTls(
  socket: Socket,
  host: string,
  timeoutMs: number,
  tlsOptions: TlsConnectionOptions | undefined,
): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const secured = tlsConnect({
      socket,
      ...(isIpLiteral(host) ? {} : { servername: host }),
      rejectUnauthorized: true,
      ...tlsOptions,
    });
    secured.setTimeout(timeoutMs);
    secured.once('secureConnect', () => resolve(secured));
    secured.once('error', (error: Error) => {
      reject(new ImapStageError('connect', `IMAP STARTTLS 升级失败：${error.message}`));
    });
  });
}

/** 发送一条命令并等待同 tag 的完成响应；untagged 响应全部收集返回 */
async function runCommand(
  reader: ImapResponseReader,
  socket: Socket,
  tag: string,
  command: string,
  label: string,
  stage: ImapFailureStage,
): Promise<{ tagged: ImapResponse; untagged: ImapResponse[] }> {
  socket.write(`${tag} ${command}\r\n`, 'utf8');
  const untagged: ImapResponse[] = [];
  for (;;) {
    const response = await reader.next();
    if (response.tag !== tag) {
      if (response.tag === '*') {
        untagged.push(response);
        continue;
      }
      if (response.tag === '+') {
        // 服务端要求续行：本客户端不使用 literal 命令，直接视为协议异常
        throw new ImapStageError(stage, `${label} 收到意外的续行请求`);
      }
      continue;
    }
    if (response.status !== 'OK') {
      throw new ImapStageError(stage, `${label} 失败（${describeResponse(response)}）`);
    }
    return { tagged: response, untagged };
  }
}

/** 读取服务端问候语（* OK / * PREAUTH；* BYE 视为建连失败） */
async function readGreeting(reader: ImapResponseReader): Promise<ImapResponse> {
  const response = await reader.next();
  const statusText = describeResponse(response);
  if (response.tag === '*' && (response.status === 'UNTAGGED')) {
    const flat = flattenTokens(response.tokens);
    const head = flat[0];
    const word = head && head.kind === 'atom' ? head.value.toUpperCase() : '';
    if (word === 'OK' || word === 'PREAUTH') {
      return response;
    }
    throw new ImapStageError('connect', `IMAP 服务端问候异常（${statusText}）`);
  }
  throw new ImapStageError('connect', `IMAP 服务端问候异常（${statusText}）`);
}

interface SessionContext {
  socket: Socket;
  reader: ImapResponseReader;
  /** 命令标签自增器（A001/A002…，同一会话内唯一） */
  nextTag: () => string;
  uidvalidity: number;
  uidnext: number;
}

/** 会话执行：建连 → 问候 → (STARTTLS) → LOGIN → ID → EXAMINE INBOX → action → LOGOUT */
async function withImapSession<T>(
  params: ImapAuthParams,
  action: (context: SessionContext) => Promise<T>,
): Promise<ImapResult<T>> {
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? Math.floor(params.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const endpoint = params.endpoint;
  let socket: Socket | null = null;
  const reader = new ImapResponseReader();
  const deadline = setTimeout(() => {
    reader.fail(new ImapStageError('timeout', `IMAP 操作超时（${timeoutMs}ms），已销毁连接`));
  }, timeoutMs);

  try {
    socket = params.socketFactory
      ? await params.socketFactory(endpoint)
      : await openSocket(endpoint, timeoutMs, params.tlsOptions, 'connect');
    socket.setTimeout(timeoutMs);
    reader.attach(socket);
    await readGreeting(reader);

    let tagSeq = 0;
    const nextTag = (): string => {
      tagSeq += 1;
      return `A${String(tagSeq).padStart(3, '0')}`;
    };

    if (endpoint.encryption === 'starttls' && !params.socketFactory) {
      const startTls = await runCommand(reader, socket, nextTag(), 'STARTTLS', 'STARTTLS', 'connect');
      if (startTls.tagged.status !== 'OK') {
        throw new ImapStageError('connect', 'STARTTLS 未被服务端接受');
      }
      reader.detach();
      reader.reset();
      const secured = await upgradeSocketToTls(socket, endpoint.host, timeoutMs, params.tlsOptions);
      socket = secured;
      reader.attach(secured);
    }

    // ---- 登录（认证阶段：失败一次即回落，调用方不再重试） ----
    const login = await runCommand(
      reader,
      socket,
      nextTag(),
      `LOGIN ${quoteImapString(params.mailbox)} ${quoteImapString(params.authCode)}`,
      'LOGIN',
      'auth',
    );
    if (login.tagged.status !== 'OK') {
      throw new ImapStageError('auth', 'LOGIN 未被服务端接受');
    }

    // ---- ID（best effort：QQ 支持 ID，其它服务端可能返回 BAD，一律忽略） ----
    try {
      await runCommand(
        reader,
        socket,
        nextTag(),
        'ID ("name" "Delepi" "version" "1.0")',
        'ID',
        'recv',
      );
    } catch {
      // 忽略：ID 非协议必需
    }

    // ---- 只读打开 INBOX（EXAMINE：只读语义，不置已读标志） ----
    const selected = await runCommand(reader, socket, nextTag(), 'EXAMINE "INBOX"', 'EXAMINE INBOX', 'recv');
    const uidvalidity = extractResponseCodeNumber(selected.untagged, 'UIDVALIDITY');
    const uidnext = extractResponseCodeNumber(selected.untagged, 'UIDNEXT');

    const context: SessionContext = { socket, reader, nextTag, uidvalidity, uidnext };
    const result = await action(context);

    // LOGOUT 为最佳努力：写入后等一次应答（最多 800ms）再优雅关闭，
    // 保证命令真正发出（直接 destroy 会丢弃尚未 flush 的写缓冲）
    try {
      socket.write(`${nextTag()} LOGOUT\r\n`, 'utf8');
      await Promise.race([
        reader.next().then(() => undefined).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 800)),
      ]);
      socket.end();
    } catch {
      // 忽略：收信结果已经拿到，LOGOUT 失败不影响本次操作
    }
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, params.authCode);
  } finally {
    clearTimeout(deadline);
    reader.detach();
    if (socket && !socket.destroyed) {
      try {
        socket.destroy();
      } catch {
        // 忽略
      }
    }
  }
}

/** 错误归一：阶段错误直传，其余按 recv 兜底；错误文本脱敏 */
function toFailure(error: unknown, authCode: string): ImapFailure {
  const message = error instanceof Error ? error.message : String(error);
  const stage: ImapFailureStage = error instanceof ImapStageError ? error.stage : 'recv';
  return { ok: false, stage, error: maskAuthCode(message, authCode).slice(0, 500) };
}

/** 会话内执行一条命令（供收信 API 复用，标签与 reader/socket 来自上下文） */
async function sessionCommand(
  context: SessionContext,
  command: string,
  label: string,
  stage: ImapFailureStage,
): Promise<{ tagged: ImapResponse; untagged: ImapResponse[] }> {
  return runCommand(context.reader, context.socket, context.nextTag(), command, label, stage);
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 凭据自检：建连 → LOGIN → ID(忽略失败) → EXAMINE INBOX（取 UIDVALIDITY/UIDNEXT）→ LOGOUT。
 * 与旧桥自检等价（旧桥还额外做一次 SMTP 登录，由调用方用 smtp-client 补齐）。
 */
export async function imapSelfTest(params: ImapAuthParams): Promise<ImapResult<{ uidvalidity: number; uidnext: number }>> {
  return withImapSession(params, async (context) => ({
    uidvalidity: context.uidvalidity,
    uidnext: context.uidnext,
  }));
}

/**
 * UID 增量收信：UID FETCH <sinceUid+1>:* BODY.PEEK[]（不含 INTERNALDATE，等价旧桥 imap_poll）。
 * 星号语义可能多带回一封旧邮件，调用方按 uid > sinceUid 过滤。
 */
export async function imapPollSinceUid(
  params: ImapAuthParams & { sinceUid: number },
): Promise<ImapResult<ImapFetchResult>> {
  return withImapSession(params, async (context) => {
    const sinceUid = Number.isFinite(params.sinceUid) ? Math.max(0, Math.floor(params.sinceUid)) : 0;
    const messages: RawImapMessage[] = [];
    if (sinceUid + 1 <= context.uidnext || context.uidnext === 0) {
      const fetched = await sessionCommand(
        context,
        `UID FETCH ${sinceUid + 1}:* (BODY.PEEK[])`,
        'UID FETCH',
        'recv',
      );
      messages.push(...parseFetchResponses(fetched.untagged));
    }
    return { uidvalidity: context.uidvalidity, uidnext: context.uidnext, messages };
  });
}

/** IMAP SEARCH 日期格式：DD-Mon-YYYY（固定英文月份缩写，不受系统 locale 影响） */
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Date → IMAP SEARCH 日期（DD-Mon-YYYY） */
export function formatImapSearchDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getDate())}-${MONTH_ABBR[date.getMonth()]}-${date.getFullYear()}`;
}

/**
 * 时间增量收信：UID SEARCH SINCE <DD-Mon-YYYY> → 取最新至多 maxUids 个候选 →
 * UID FETCH (INTERNALDATE BODY.PEEK[])（等价旧桥 imap_poll_since）。
 * SEARCH SINCE 只精确到「日」，秒级过滤由调用方用 internalDate/Date 头完成。
 */
export async function imapPollSinceDate(
  params: ImapAuthParams & { sinceDate: string; maxUids?: number },
): Promise<ImapResult<ImapFetchResult>> {
  const sinceDate = String(params.sinceDate ?? '').trim();
  if (!/^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(sinceDate)) {
    return { ok: false, stage: 'recv', error: `sinceDate 非法（须为 DD-Mon-YYYY）：${sinceDate.slice(0, 40)}` };
  }
  const maxUids = typeof params.maxUids === 'number' && params.maxUids > 0 ? Math.floor(params.maxUids) : 50;
  return withImapSession(params, async (context) => {
    const searched = await sessionCommand(context, `UID SEARCH SINCE ${sinceDate}`, 'UID SEARCH SINCE', 'recv');
    const candidates = parseSearchResponse(searched.untagged).slice(-maxUids);
    const messages: RawImapMessage[] = [];
    if (candidates.length > 0) {
      const fetched = await sessionCommand(
        context,
        `UID FETCH ${candidates.join(',')} (INTERNALDATE BODY.PEEK[])`,
        'UID FETCH',
        'recv',
      );
      messages.push(...parseFetchResponses(fetched.untagged));
    }
    return { uidvalidity: context.uidvalidity, uidnext: context.uidnext, messages };
  });
}

/** 暴露会话类构造缝（单测用明文 socket 驱动完整命令序列） */
export function createImapSessionForTest(socket: Socket): ImapResponseReader {
  const reader = new ImapResponseReader();
  reader.attach(socket);
  return reader;
}
