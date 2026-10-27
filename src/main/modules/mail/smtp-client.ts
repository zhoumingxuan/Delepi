/**
 * smtp-client — 纯 Node.js SMTP 发送模块（阶段4 发送侧第一阶段）
 *
 * 设计约束：
 * - 零新增 npm 依赖：只使用 node:tls / node:crypto / node:os / node:string_decoder 等内置模块；
 * - 支持两种加密方式（阶段7 目标3：自定义邮箱 provider 需要的加密取舍）：
 *   'ssl'（默认，465 隐式 TLS：tls.connect，rejectUnauthorized: true，servername = host）与
 *   'starttls'（明文建连 → EHLO → STARTTLS → 同 socket 升级 TLS → 再 EHLO，拒绝明文凭据）；
 * - 命令序列：EHLO → AUTH LOGIN（base64 用户名、base64 授权码）→ MAIL FROM →
 *   RCPT TO → DATA → 内容 → "." → QUIT，逐条解析响应（支持 250- 多行续行）；
 * - From 恒等于登录邮箱；Subject 非 ASCII 时按 RFC 2047 B 编码；Date 为 RFC 2822；
 *   Message-ID 使用自定义域 delepi.watch；调用方可通过 headers 传入任意自定义头；
 * - 正文固定 text/html; charset=UTF-8，base64 编码并按 76 列折行；
 * - 附件使用 multipart/mixed，附件头同时写 name/filename 与 filename*=UTF-8'' 双形式；
 * - 统一 CRLF 行尾；DATA 段做 dot-stuffing（行首 "." 变为 ".."）；
 * - 错误阶段：connect（TCP/TLS 建连与 EHLO）、auth（登录被拒）、
 *   send（MAIL/RCPT/DATA 阶段被拒或发送链路异常）、timeout（整体/空闲超时）；
 * - 所有错误文本在返回前把授权码（含 base64 形式）替换为 <QQ邮箱授权码>。
 */

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { connect as netConnect, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

/** 授权码占位符（任何返回文本中一律使用，严禁出现明文） */
export const AUTH_CODE_PLACEHOLDER = '<QQ邮箱授权码>';

/** SMTP 错误阶段 */
export type SmtpErrorStage = 'connect' | 'auth' | 'send' | 'timeout';

/** 自定义头字段（name 仅允许字母/数字/连字符；value 中的换行会被折叠为空格） */
export interface SmtpHeaderInput {
  name: string;
  value: string;
}

/** 附件入参（content 已在内存中，避免发送模块触碰文件系统） */
export interface SmtpAttachmentInput {
  fileName: string;
  content: Buffer;
  contentType?: string;
}

/** 发送函数入参 */
export interface SmtpSendOptions {
  host: string;
  port: number;
  mailbox: string;
  authCode: string;
  to: string;
  subject: string;
  html: string;
  /** 任意自定义头（In-Reply-To、References、X-Delepi-Role、X-Delepi-Command-Id 等） */
  headers?: SmtpHeaderInput[];
  attachments?: SmtpAttachmentInput[];
  /** 整体超时（毫秒，含 socket 空闲超时），默认 90000 */
  timeoutMs?: number;
  /**
   * 加密方式（默认 'ssl'=隐式 TLS/465）：'starttls' 时先明文建连再 STARTTLS 升级。
   * 不提供明文（无 TLS）模式：授权码等价密码，拒绝明文传输。
   */
  encryption?: 'ssl' | 'starttls';
}

/** 发送成功结果 */
export interface SmtpSendSuccess {
  ok: true;
  /** 声明 Message-ID（自定义域 delepi.watch） */
  declaredMessageId: string;
  /** 服务端接受的收件人 */
  acceptedRecipients: string[];
  /** 被拒收件人 */
  refusedRecipients: string[];
  /** 附件数量 */
  attachmentCount: number;
  /** 附件总字节 */
  attachmentBytes: number;
  /** 耗时（毫秒） */
  elapsedMs: number;
}

/** 发送失败结果 */
export interface SmtpSendFailure {
  ok: false;
  stage: SmtpErrorStage;
  error: string;
  /** 被拒收件人（RCPT TO 被拒时非空） */
  refusedRecipients: string[];
}

export type SmtpSendResult = SmtpSendSuccess | SmtpSendFailure;

/** MIME 构建入参 */
export interface MimeMessageInput {
  mailbox: string;
  to: string;
  subject: string;
  html: string;
  headers?: SmtpHeaderInput[];
  attachments?: SmtpAttachmentInput[];
  date?: Date;
}

/** MIME 构建结果 */
export interface MimeMessageResult {
  message: string;
  declaredMessageId: string;
  attachmentCount: number;
  attachmentBytes: number;
}

const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * 进程级默认加密方式（阶段7 目标3 的发信侧 provider 接缝）：
 * 值守服务在每次解析邮箱端点时调用 setDefaultSmtpEncryption()，使「未显式传 encryption」
 * 的既有调用方（send_email 工具，本轮改动白名单之外）自动跟随当前邮箱类型；
 * 未注入前恒为 'ssl'，与阶段4~6 的 465 隐式 TLS 行为逐字节一致。
 */
let defaultSmtpEncryption: 'ssl' | 'starttls' = 'ssl';

/** 注入默认加密方式（仅接受 'ssl' / 'starttls'） */
export function setDefaultSmtpEncryption(value: 'ssl' | 'starttls'): void {
  defaultSmtpEncryption = value === 'starttls' ? 'starttls' : 'ssl';
}

/** 读取默认加密方式（诊断用） */
export function getDefaultSmtpEncryption(): 'ssl' | 'starttls' {
  return defaultSmtpEncryption;
}
const BASE64_LINE_WIDTH = 76;
const MAX_ENCODED_WORD_BYTES = 45;

/** 保留头字段：由模块统一生成，自定义头中的同名项会被忽略（From 恒等于登录邮箱） */
const RESERVED_HEADER_NAMES = new Set([
  'from',
  'to',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
]);

/** 阶段错误（内部使用；对外统一转为 SmtpSendFailure） */
class SmtpStageError extends Error {
  readonly stage: SmtpErrorStage;
  readonly refusedRecipients: string[];

  constructor(stage: SmtpErrorStage, message: string, refusedRecipients: string[] = []) {
    super(message);
    this.name = 'SmtpStageError';
    this.stage = stage;
    this.refusedRecipients = refusedRecipients;
  }
}

/** 单条 SMTP 响应（多行响应已合并） */
interface SmtpResponse {
  code: number;
  lines: string[];
}

interface ResponseWaiter {
  resolve: (response: SmtpResponse) => void;
  reject: (error: Error) => void;
}

/**
 * SMTP 连接：负责 TLS 建连、命令写入、响应行缓冲与多行响应组装。
 * 串行使用（同一时刻至多一个 readResponse 等待者）。
 */
class SmtpConnection {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly decoder = new StringDecoder('utf8');
  private socket: Socket | null = null;
  private buffer = '';
  private partial: { code: number; lines: string[] } | null = null;
  private readonly responseQueue: SmtpResponse[] = [];
  private waiter: ResponseWaiter | null = null;
  private fatalError: Error | null = null;
  private readonly onData = (chunk: Buffer): void => {
    this.handleChunk(this.decoder.write(chunk));
  };
  private readonly onError = (error: Error): void => {
    this.rejectPendingConnect?.(error);
    this.fail(error);
  };
  private readonly onTimeout = (): void => {
    const timeoutError = new SmtpStageError('timeout', `SMTP 空闲超时（${this.timeoutMs}ms），已销毁连接`);
    this.rejectPendingConnect?.(timeoutError);
    this.fail(timeoutError);
  };
  private readonly onClose = (): void => {
    this.rejectPendingConnect?.(this.fatalError ?? new Error('SMTP 连接在握手完成前关闭'));
    this.fail(new Error('SMTP 连接已关闭'));
  };
  private rejectPendingConnect: ((error: Error) => void) | null = null;

  constructor(host: string, port: number, timeoutMs: number) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
  }

  /**
   * 建立连接：
   * - encryption='ssl'（默认）：隐式 TLS（证书校验开启；servername 用于 SNI）
   * - encryption='starttls'：先明文 TCP 建连，由调用方在 EHLO 后发 STARTTLS 并调用 upgradeToTls()
   * 握手有独立超时兜底：任何事件缺失（对端静默/半开连接）都会在 timeoutMs 内以 timeout 阶段失败，
   * 绝不悬挂等待。
   */
  connect(encryption: 'ssl' | 'starttls' = 'ssl'): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
      const settle = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        if (error) {
          this.fail(error);
          reject(error);
          return;
        }
        resolve();
      };
      this.rejectPendingConnect = (error: Error) => settle(error);
      const socket = encryption === 'ssl'
        ? tlsConnect({
            host: this.host,
            port: this.port,
            ...(isIpLiteral(this.host) ? {} : { servername: this.host }),
            rejectUnauthorized: true,
          })
        : netConnect({ host: this.host, port: this.port });
      this.socket = socket;
      this.attach(socket);
      socket.setTimeout(this.timeoutMs);
      handshakeTimer = setTimeout(() => {
        settle(new SmtpStageError('timeout', `SMTP 建连/握手超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      socket.once(encryption === 'ssl' ? 'secureConnect' : 'connect', () => settle());
    });
  }

  /**
   * STARTTLS 升级：把已建立的明文 socket 包装为 TLS（证书校验开启）。
   * 旧 socket 监听先解绑，缓冲区/半包状态清零（明文流的残余字节不得进入 TLS 通道）。
   * 同样带独立握手超时兜底，握手期间连接被关闭也会立即失败（不会悬挂）。
   */
  upgradeToTls(): Promise<void> {
    const rawSocket = this.socket;
    if (!rawSocket) {
      return Promise.reject(new SmtpStageError('connect', 'SMTP 连接不可用，无法 STARTTLS 升级'));
    }
    this.detach();
    this.buffer = '';
    this.partial = null;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
      const settle = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        if (error) {
          this.fail(error);
          reject(error);
          return;
        }
        resolve();
      };
      this.rejectPendingConnect = (error: Error) => settle(error);
      handshakeTimer = setTimeout(() => {
        settle(new SmtpStageError('timeout', `SMTP STARTTLS 握手超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      let secured: TLSSocket;
      try {
        secured = tlsConnect({
          socket: rawSocket,
          ...(isIpLiteral(this.host) ? {} : { servername: this.host }),
          rejectUnauthorized: true,
        });
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.socket = secured;
      this.attach(secured);
      secured.setTimeout(this.timeoutMs);
      secured.once('secureConnect', () => settle());
      secured.once('error', (error: Error) => settle(error));
      secured.once('close', () => settle(new SmtpStageError('connect', 'SMTP STARTTLS 升级期间连接被关闭')));
    });
  }

  /** 绑定 socket 监听（connect / upgradeToTls 共用） */
  private attach(socket: Socket): void {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('timeout', this.onTimeout);
    socket.on('close', this.onClose);
  }

  /** 解绑当前 socket 监听（幂等） */
  private detach(): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    socket.removeListener('data', this.onData);
    socket.removeListener('error', this.onError);
    socket.removeListener('timeout', this.onTimeout);
    socket.removeListener('close', this.onClose);
  }

  /** 写入一行命令（自动补 CRLF） */
  writeLine(command: string): void {
    this.assertWritable();
    this.socket?.write(`${command}\r\n`, 'utf8');
  }

  /** 原样写入（DATA 段使用；调用方自行保证 CRLF 与 dot-stuffing） */
  writeRaw(payload: string): void {
    this.assertWritable();
    this.socket?.write(payload, 'utf8');
  }

  /** 读取下一条完整响应 */
  readResponse(): Promise<SmtpResponse> {
    const queued = this.responseQueue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }
    return new Promise<SmtpResponse>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  /** 整体超时：销毁 socket 并以 timeout 阶段失败 */
  abortForTimeout(message: string): void {
    this.fail(new SmtpStageError('timeout', message));
  }

  /** 释放连接（幂等） */
  dispose(): void {
    this.detach();
    const socket = this.socket;
    if (socket && !socket.destroyed) {
      try {
        socket.destroy();
      } catch {
        // socket 可能已被对端关闭
      }
    }
  }

  private assertWritable(): void {
    if (this.fatalError) {
      throw this.fatalError;
    }
    if (!this.socket || this.socket.destroyed) {
      throw new Error('SMTP 连接不可用（socket 已销毁）');
    }
  }

  private handleChunk(chunk: string): void {
    if (!chunk) {
      return;
    }
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      this.consumeLine(line);
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private consumeLine(line: string): void {
    const match = /^(\d{3})([ -])(.*)$/.exec(line);
    const bareMatch = match ? null : /^(\d{3})$/.exec(line);
    if (!match && !bareMatch) {
      // 非标准续行（部分服务端会输出纯文本行）：并入当前多行响应
      if (this.partial) {
        this.partial.lines.push(line);
      }
      return;
    }
    const code = match ? Number(match[1]) : Number(bareMatch?.[1] ?? '0');
    const isFinal = match ? match[2] === ' ' : true;
    const text = match ? (match[3] ?? '') : '';
    if (!this.partial || this.partial.code !== code) {
      this.partial = { code, lines: [text] };
    } else {
      this.partial.lines.push(text);
    }
    if (!isFinal) {
      return;
    }
    const response = this.partial;
    this.partial = null;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.resolve(response);
    } else {
      this.responseQueue.push(response);
    }
  }

  private fail(error: Error): void {
    if (!this.fatalError) {
      this.fatalError = error;
    }
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.reject(this.fatalError);
    }
    this.dispose();
  }
}

/** 统一阶段包装：非阶段错误按传入阶段归类，阶段错误原样透传 */
async function callStage<T>(stage: SmtpErrorStage, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof SmtpStageError) {
      throw error;
    }
    throw new SmtpStageError(stage, errorMessage(error));
  }
}

/** 发送一条命令并校验响应码 */
async function runCommand(
  connection: SmtpConnection,
  command: string,
  expectedCodes: readonly number[],
  stage: SmtpErrorStage,
  label: string,
  rejectedPrefix = false,
): Promise<SmtpResponse> {
  const response = await callStage(stage, async () => {
    connection.writeLine(command);
    return connection.readResponse();
  });
  if (!expectedCodes.includes(response.code)) {
    const prefix = rejectedPrefix ? 'REJECTED: ' : '';
    throw new SmtpStageError(stage, `${prefix}${label} 失败（${describeResponse(response)}）`);
  }
  return response;
}

/** 读取响应并校验（用于服务端问候） */
async function readResponseInStage(
  connection: SmtpConnection,
  stage: SmtpErrorStage,
  label: string,
): Promise<SmtpResponse> {
  const response = await callStage(stage, () => connection.readResponse());
  if (response.code === 421) {
    throw new SmtpStageError(stage, `${label} 失败（${describeResponse(response)}）`);
  }
  return response;
}

/**
 * 发送一封邮件（隐式 TLS / 465）。
 * 不抛异常：所有失败收敛为 SmtpSendFailure（错误文本已脱敏）。
 */
export async function sendSmtpMail(options: SmtpSendOptions): Promise<SmtpSendResult> {
  const startedAtMs = Date.now();
  const timeoutMs = normalizeTimeout(options.timeoutMs);

  if (!options.host || !options.port || !options.mailbox || !options.authCode || !options.to) {
    return {
      ok: false,
      stage: 'send',
      error: 'SMTP 参数不完整（host/port/mailbox/authCode/to 均为必填）',
      refusedRecipients: [],
    };
  }

  let mime: MimeMessageResult;
  try {
    mime = buildMimeMessage({
      mailbox: options.mailbox,
      to: options.to,
      subject: options.subject,
      html: options.html,
      headers: options.headers,
      attachments: options.attachments,
    });
  } catch (error) {
    return {
      ok: false,
      stage: 'send',
      error: maskAuthCode(errorMessage(error), options.authCode),
      refusedRecipients: [],
    };
  }

  const encryption: 'ssl' | 'starttls' = options.encryption === 'starttls'
    ? 'starttls'
    : options.encryption === 'ssl'
      ? 'ssl'
      : defaultSmtpEncryption;
  const connection = new SmtpConnection(options.host, options.port, timeoutMs);
  let phase: SmtpErrorStage = 'connect';
  let refusedRecipients: string[] = [];
  const overallTimer = setTimeout(() => {
    connection.abortForTimeout(`SMTP 整体超时（${timeoutMs}ms），已销毁连接`);
  }, timeoutMs);

  try {
    await callStage('connect', () => connection.connect(encryption));

    const greeting = await readResponseInStage(connection, 'connect', '服务端问候');
    if (greeting.code !== 220) {
      throw new SmtpStageError('connect', `SMTP 服务端问候异常（${describeResponse(greeting)}）`);
    }

    await runCommand(connection, `EHLO ${resolveEhloName()}`, [250], 'connect', 'EHLO');

    // STARTTLS：明文建连后先升级 TLS，再在加密通道里重新 EHLO（凭据只允许走 TLS）
    if (encryption === 'starttls') {
      await runCommand(connection, 'STARTTLS', [220], 'connect', 'STARTTLS');
      await callStage('connect', () => connection.upgradeToTls());
      await runCommand(connection, `EHLO ${resolveEhloName()}`, [250], 'connect', 'EHLO(TLS)');
    }

    phase = 'auth';
    await runCommand(connection, 'AUTH LOGIN', [334], 'auth', 'AUTH LOGIN');
    await runCommand(
      connection,
      Buffer.from(options.mailbox, 'utf8').toString('base64'),
      [334],
      'auth',
      'AUTH LOGIN 用户名',
    );
    // 授权码仅出现在本次写入中，任何错误文本都不包含命令内容
    await runCommand(
      connection,
      Buffer.from(options.authCode, 'utf8').toString('base64'),
      [235],
      'auth',
      'AUTH LOGIN 授权码',
    );

    phase = 'send';
    const recipient = sanitizeAddress(options.to);
    await runCommand(
      connection,
      `MAIL FROM:<${sanitizeAddress(options.mailbox)}>`,
      [250],
      'send',
      'MAIL FROM',
      true,
    );
    try {
      await runCommand(connection, `RCPT TO:<${recipient}>`, [250, 251], 'send', 'RCPT TO', true);
    } catch (error) {
      refusedRecipients = [recipient];
      throw error;
    }
    await runCommand(connection, 'DATA', [354], 'send', 'DATA', true);

    const stuffed = dotStuff(mime.message);
    const dataPayload = stuffed.endsWith('\r\n') ? `${stuffed}.\r\n` : `${stuffed}\r\n.\r\n`;
    const dataResponse = await callStage('send', async () => {
      connection.writeRaw(dataPayload);
      return connection.readResponse();
    });
    if (dataResponse.code !== 250) {
      throw new SmtpStageError(
        'send',
        `REJECTED: DATA 内容未被接收（${describeResponse(dataResponse)}）`,
      );
    }

    try {
      await runCommand(connection, 'QUIT', [221], 'send', 'QUIT');
    } catch {
      // QUIT 为最佳努力：DATA 已被接收即视为发送成功
    }

    return {
      ok: true,
      declaredMessageId: mime.declaredMessageId,
      acceptedRecipients: [recipient],
      refusedRecipients: [],
      attachmentCount: mime.attachmentCount,
      attachmentBytes: mime.attachmentBytes,
      elapsedMs: Date.now() - startedAtMs,
    };
  } catch (error) {
    const stage = error instanceof SmtpStageError ? error.stage : phase;
    const refused =
      error instanceof SmtpStageError && error.refusedRecipients.length > 0
        ? error.refusedRecipients
        : refusedRecipients;
    return {
      ok: false,
      stage,
      error: maskAuthCode(errorMessage(error), options.authCode),
      refusedRecipients: refused,
    };
  } finally {
    clearTimeout(overallTimer);
    connection.dispose();
  }
}

/**
 * SMTP 登录自检（只做 AUTH LOGIN，不发信）：等价旧桥自检的 SMTP 段。
 * 阶段语义与 sendSmtpMail 一致：connect（TCP/TLS/EHLO）、auth（AUTH LOGIN 被拒或断连）、
 * timeout（整体/空闲超时）。不抛异常，失败收敛为 { ok:false, stage, error }（错误已脱敏）。
 */
export interface SmtpLoginVerifyOptions {
  host: string;
  port: number;
  mailbox: string;
  authCode: string;
  timeoutMs?: number;
  encryption?: 'ssl' | 'starttls';
}

export type SmtpLoginVerifyResult = { ok: true } | { ok: false; stage: SmtpErrorStage; error: string };

export async function verifySmtpLogin(options: SmtpLoginVerifyOptions): Promise<SmtpLoginVerifyResult> {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  if (!options.host || !options.port || !options.mailbox || !options.authCode) {
    return { ok: false, stage: 'auth', error: 'SMTP 参数不完整（host/port/mailbox/authCode 均为必填）' };
  }
  const encryption: 'ssl' | 'starttls' = options.encryption === 'starttls'
    ? 'starttls'
    : options.encryption === 'ssl'
      ? 'ssl'
      : defaultSmtpEncryption;
  const connection = new SmtpConnection(options.host, options.port, timeoutMs);
  const overallTimer = setTimeout(() => {
    connection.abortForTimeout(`SMTP 登录自检整体超时（${timeoutMs}ms），已销毁连接`);
  }, timeoutMs);
  try {
    await callStage('connect', () => connection.connect(encryption));
    const greeting = await readResponseInStage(connection, 'connect', '服务端问候');
    if (greeting.code !== 220) {
      throw new SmtpStageError('connect', `SMTP 服务端问候异常（${describeResponse(greeting)}）`);
    }
    await runCommand(connection, `EHLO ${resolveEhloName()}`, [250], 'connect', 'EHLO');
    if (encryption === 'starttls') {
      await runCommand(connection, 'STARTTLS', [220], 'connect', 'STARTTLS');
      await callStage('connect', () => connection.upgradeToTls());
      await runCommand(connection, `EHLO ${resolveEhloName()}`, [250], 'connect', 'EHLO(TLS)');
    }
    await runCommand(connection, 'AUTH LOGIN', [334], 'auth', 'AUTH LOGIN');
    await runCommand(
      connection,
      Buffer.from(options.mailbox, 'utf8').toString('base64'),
      [334],
      'auth',
      'AUTH LOGIN 用户名',
    );
    await runCommand(
      connection,
      Buffer.from(options.authCode, 'utf8').toString('base64'),
      [235],
      'auth',
      'AUTH LOGIN 授权码',
    );
    try {
      await runCommand(connection, 'QUIT', [221], 'send', 'QUIT');
    } catch {
      // QUIT 为最佳努力：认证已通过即视为自检成功
    }
    return { ok: true };
  } catch (error) {
    const stage = error instanceof SmtpStageError ? error.stage : 'auth';
    return { ok: false, stage, error: maskAuthCode(errorMessage(error), options.authCode) };
  } finally {
    clearTimeout(overallTimer);
    connection.dispose();
  }
}

/**
 * 构建完整 MIME 报文（CRLF 行尾，未做 dot-stuffing）。
 * - 无附件：单段 text/html; charset=UTF-8 + base64
 * - 有附件：multipart/mixed（正文段 + 若干附件段）
 */
export function buildMimeMessage(input: MimeMessageInput): MimeMessageResult {
  const mailbox = sanitizeAddress(input.mailbox);
  const to = sanitizeAddress(input.to);
  const declaredMessageId = `<${Date.now()}.${randomBytes(10).toString('hex')}@delepi.watch>`;
  const headerLines: string[] = [
    `From: ${mailbox}`,
    `To: ${to}`,
    `Subject: ${encodeUnstructuredHeader(input.subject)}`,
    `Date: ${formatRfc2822Date(input.date ?? new Date())}`,
    `Message-ID: ${declaredMessageId}`,
    'MIME-Version: 1.0',
  ];

  for (const item of input.headers ?? []) {
    const name = String(item?.name ?? '').trim();
    const value = stripLineBreaks(String(item?.value ?? '')).trim();
    if (!name || !value) {
      continue;
    }
    if (!/^[A-Za-z0-9-]+$/.test(name)) {
      throw new SmtpStageError('send', `自定义头字段名非法：${name}`);
    }
    if (RESERVED_HEADER_NAMES.has(name.toLowerCase())) {
      continue;
    }
    headerLines.push(`${name}: ${encodeUnstructuredHeader(value)}`);
  }

  const htmlBase64 = foldBase64(Buffer.from(input.html, 'utf8'));
  const attachments = input.attachments ?? [];
  let attachmentBytes = 0;
  for (const attachment of attachments) {
    attachmentBytes += attachment.content.length;
  }

  if (attachments.length === 0) {
    const message = [
      headerLines.join('\r\n'),
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      htmlBase64,
    ].join('\r\n');
    return {
      message,
      declaredMessageId,
      attachmentCount: 0,
      attachmentBytes: 0,
    };
  }

  const boundary = createBoundary([
    htmlBase64,
    ...attachments.map((attachment) => attachment.content.toString('base64')),
  ]);
  const parts: string[] = [
    headerLines.join('\r\n'),
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    htmlBase64,
  ];

  for (const attachment of attachments) {
    const fileName = sanitizeFileName(attachment.fileName);
    const contentType = normalizeContentType(attachment.contentType);
    parts.push(`--${boundary}`);
    parts.push(`Content-Type: ${contentType}; name="${encodeMimeParameter(fileName)}"`);
    parts.push('Content-Transfer-Encoding: base64');
    parts.push(
      `Content-Disposition: attachment; filename="${encodeMimeParameter(fileName)}"; filename*=UTF-8''${encodeRfc5987(fileName)}`,
    );
    parts.push('');
    parts.push(foldBase64(attachment.content));
  }
  parts.push(`--${boundary}--`);

  return {
    message: parts.join('\r\n'),
    declaredMessageId,
    attachmentCount: attachments.length,
    attachmentBytes,
  };
}

/** base64 按 76 列折行（CRLF） */
export function foldBase64(data: Buffer | string, width: number = BASE64_LINE_WIDTH): string {
  const base64 = typeof data === 'string' ? data : data.toString('base64');
  if (!base64) {
    return '';
  }
  const lines: string[] = [];
  for (let index = 0; index < base64.length; index += width) {
    lines.push(base64.slice(index, index + width));
  }
  return lines.join('\r\n');
}

/** 授权码脱敏：明文、base64、base64url、URL 编码形式全部替换为占位符 */
export function maskAuthCode(text: string, authCode: string): string {
  let safe = String(text ?? '');
  const secret = String(authCode ?? '');
  if (!secret) {
    return safe;
  }
  const variants = new Set<string>([
    secret,
    Buffer.from(secret, 'utf8').toString('base64'),
    Buffer.from(secret, 'utf8').toString('base64url'),
    encodeURIComponent(secret),
  ]);
  for (const variant of variants) {
    if (variant) {
      safe = safe.split(variant).join(AUTH_CODE_PLACEHOLDER);
    }
  }
  return safe;
}

/** DATA 段 dot-stuffing：行首 "." 变为 ".." */
function dotStuff(message: string): string {
  return message
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

/** 生成不与正文/附件内容冲突的 MIME boundary */
function createBoundary(parts: string[]): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `=_Delepi_${randomBytes(16).toString('hex')}`;
    if (!parts.some((part) => part.includes(candidate))) {
      return candidate;
    }
  }
  return `=_Delepi_${randomBytes(24).toString('hex')}`;
}

/** RFC 2822 Date（本地时区偏移） */
function formatRfc2822Date(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const pad = (value: number): string => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetMinutes);
  return [
    `${days[date.getDay()]},`,
    `${pad(date.getDate())}`,
    `${months[date.getMonth()]}`,
    `${date.getFullYear()}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `${sign}${pad(Math.floor(absoluteMinutes / 60))}${pad(absoluteMinutes % 60)}`,
  ].join(' ');
}

/** 非 ASCII 头值按 RFC 2047 B 编码（相邻编码字按折叠空白分隔，单个编码字 ≤ 75 字符） */
function encodeUnstructuredHeader(value: string): string {
  const text = stripLineBreaks(value).trim();
  if (!text) {
    return '';
  }
  if (/^[\x20-\x7E]*$/.test(text)) {
    return text;
  }
  return encodeRfc2047(text);
}

function encodeRfc2047(text: string): string {
  const encodedWords: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const char of Array.from(text)) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (chunk && chunkBytes + charBytes > MAX_ENCODED_WORD_BYTES) {
      encodedWords.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += charBytes;
  }
  if (chunk) {
    encodedWords.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
  }
  return encodedWords.join('\r\n ');
}

/** MIME 参数值（name / filename）：ASCII 原样，非 ASCII 用 RFC 2047 B 编码字 */
function encodeMimeParameter(value: string): string {
  const text = String(value ?? '').replace(/[\r\n"]/g, '_').trim() || 'attachment';
  if (/^[\x20-\x7E]*$/.test(text)) {
    return text;
  }
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/** RFC 5987 扩展参数值（filename*=UTF-8''） */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sanitizeFileName(value: string): string {
  const cleaned = String(value ?? '')
    .replace(/[\r\n"]/g, '_')
    .replace(/[\\/]/g, '_')
    .trim();
  return cleaned || 'attachment';
}

function normalizeContentType(value: string | undefined): string {
  const text = String(value ?? '')
    .replace(/[\r\n]/g, ' ')
    .trim();
  return text || 'application/octet-stream';
}

function stripLineBreaks(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

function sanitizeAddress(value: string): string {
  return value.replace(/[\r\n<>]/g, '').trim();
}

function describeResponse(response: SmtpResponse): string {
  return `${response.code} ${response.lines.join(' ')}`.trim();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function normalizeTimeout(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * 主机是否为 IP 字面量（IP 不发送 SNI：RFC 6066 禁止 IP 作为 server_name；
 * 生产端点均为域名，此判断只影响本地 mock/内网 IP 场景的告警噪声）
 */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

function resolveEhloName(): string {
  try {
    const name = hostname().replace(/[^A-Za-z0-9.-]/g, '-');
    if (!name) {
      return 'delepi.local';
    }
    return name.includes('.') ? name : `${name}.local`;
  } catch {
    return 'delepi.local';
  }
}
