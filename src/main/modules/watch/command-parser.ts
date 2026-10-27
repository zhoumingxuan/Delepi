/**
 * command-parser — 值守指令邮件解析（阶段5：命令行风格主协议 + 旧 JSON 围栏兼容）
 *
 * 协议总览（正文纯文本，逐行扫描；阶段7 目标4：新增显式 `--type`，并让「只带 --message」新建对话）：
 * - 查询指令：`--type list`（或旧写法行首 `--list`），可带 `--limit <1-50>`（缺省 20）
 * - 已有对话发消息：`--type send`（可省略）+ `--conversation <编号>` 或 `--conversation-id <UUID>`
 *   + `--message <内容>`
 * - 新建对话并发消息：`--type new`（可省略，仅当只写 `--message` 时）+ `--message <内容>`，
 *   且不得同时出现 `--conversation` / `--conversation-id`
 * - 可选 `--request <自定义 request_id>`；缺省自动生成 REQ-<yyyyMMddHHmmss>-<4位大写字母数字>
 *
 * 类型判定顺序（消除参数组合歧义）：
 * 1) 显式 `--type` 优先（list / send / new，兼容 list_conversations / send_message / new_conversation 别名）；
 * 2) 未写 `--type` 时按旧参数组合推断：`--list` → list；`--message` + 会话引用 → send；
 *    仅 `--message`（无会话引用）→ new（阶段7 新增语义，旧版此处报 ERR_WATCH_NO_COMMAND_BLOCK）；
 * 3) 矛盾组合（如 `--type new` 同时带 `--conversation`）一律 ERR_WATCH_FIELD_INVALID，不做猜测。
 *
 * 解析规则：
 * - 逐行扫描；`--key` 必须位于行首（允许前置空白）——这是「指令行」与「叙述行」的区分依据
 * - 一条参数行内可写多个 `--key value`（命令行风格，示例：`--conversation 3 --message 要发送的内容`）；
 *   同行取值到下一个 `--key` 边界或行尾
 * - `--message` 同行值为空且位于该行末尾时，取其后所有行直到下一个行首 `--key`
 *   （保留原始换行、缩进与空行，不做任何改写；块末结构性空行不计入内容）
 * - 参数名比较不区分大小写；值保持原样（不转小写、不去引号、不做转义）
 * - 未知参数记入 warnings，绝不导致解析失败
 * - 必须命中 `--list` 或（`--conversation`/`--conversation-id` 且 `--message`），
 *   否则返回 ERR_WATCH_NO_COMMAND_BLOCK
 * - 旧 JSON 围栏（```delepi-command 或整段 JSON）继续兼容，映射到同一命令模型
 *   （command 取值同样接受 list / send / new 及其全名别名，阶段7 起含 new_conversation）；
 *   list_conversations 的 limit 保留 1-50 校验；send_message 的 conversation_id
 *   为 36 字符 UUID 时 kind='id'，否则按编号解析规则处理
 *
 * 设计约束：
 * - 本模块零依赖（纯文本处理），可在无 Electron / 无网络的本地环境直接加载验证
 * - requestId 会进入邮件头 X-Delepi-Command-Id，字符集因此限制为 [A-Za-z0-9_-]（防头注入）
 */

/** 正文长度硬上限（防御性上限，与历史实现一致） */
export const WATCH_COMMAND_BODY_MAX_CHARS = 20_000;

/** `--list` 缺省返回条数 */
export const WATCH_LIST_DEFAULT_LIMIT = 20;

/** `--list` 允许的最小/最大返回条数 */
export const WATCH_LIST_MIN_LIMIT = 1;
export const WATCH_LIST_MAX_LIMIT = 50;

/** 对话引用：编号（映射表内 1..N）或 GUID */
export type ConversationRef = { kind: 'index'; index: number } | { kind: 'id'; id: string };

export interface ListConversationsCommand {
  type: 'list_conversations';
  requestId: string;
  limit: number;
}

export interface SendMessageCommand {
  type: 'send_message';
  requestId: string;
  conversationRef: ConversationRef;
  message: string;
}

/**
 * 新建对话并发消息（阶段7 目标4②）：只带 `--message`（不带会话引用）即走本指令。
 * 服务端会 createConversation() 新建会话，再在该新会话内注入 message。
 */
export interface NewConversationCommand {
  type: 'new_conversation';
  requestId: string;
  message: string;
}

export type WatchCommand = ListConversationsCommand | SendMessageCommand | NewConversationCommand;

export type WatchParseResult =
  | { ok: true; command: WatchCommand; warnings: string[] }
  | { ok: false; code: string; message: string };

/** request_id 合法字符集（同时保证可安全进入邮件头） */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** conversation_id 形态：36 字符 UUID 文本（8-4-4-4-12 十六进制，含 4 个短横线） */
const CONVERSATION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 编号形态：1~9 位纯数字（上限由映射表实际长度决定） */
const INDEX_RE = /^[0-9]{1,9}$/;

/** limit 形态：1~3 位纯数字 */
const LIMIT_RE = /^[0-9]{1,3}$/;

/**
 * 「参数行」判定：行首（允许前置空白）必须是 `--key`。
 * 该规则用于把「指令行」与「普通叙述行」区分开——叙述行里出现的 --xxx 一律不当作参数。
 */
const PARAM_LINE_RE = /^[ \t]*--[A-Za-z0-9_-]+/;

/**
 * 参数行内的 `--key` 边界：位于行首，或位于空白之后（支持
 * `--conversation 3 --message 要发送的内容` 这种一行多参写法）。
 * 后面必须紧跟至少一个参数名字符，因此「内容 -- 补充说明」不会被误判为参数。
 */
const KEY_TOKEN_RE = /(^|[ \t])--([A-Za-z0-9_-]+)/g;

/** 非指令判定：行首六类参数任一即可（长选项在前，避免 conversation 抢先匹配 conversation-id） */
const MARKER_RE = /^[ \t]*--(?:conversation-id|conversation|message|request|list|type)(?![A-Za-z0-9_-])/im;

/** 围栏标记：大小写不敏感；g 用于计数（仅配合 String.match 使用，禁止 .test 以免 lastIndex 状态污染） */
const FENCE_HEADER_RE = /```delepi-command/gi;

/** 围栏存在性判定（无 g 标志，可安全复用于 .test） */
const FENCE_TEST_RE = /```delepi-command/i;

/** 围栏块提取 */
const FENCE_BLOCK_RE = /```delepi-command\s*([\s\S]*?)```/i;

/** 已知参数名（小写）；type 为阶段7 新增的显式指令类型 */
const KNOWN_KEYS = new Set(['list', 'limit', 'conversation', 'conversation-id', 'message', 'request', 'type']);

/** 显式指令类型（归一后的三值） */
type ExplicitCommandType = 'list' | 'send' | 'new';

/**
 * `--type` 取值归一（大小写不敏感；同时接受 snake_case 全名，方便旧用户迁移）：
 * - list / list_conversations / list-conversations → 'list'
 * - send / send_message / send-message             → 'send'
 * - new / new_conversation / new-conversation      → 'new'
 * 非法值返回 null（调用方按字段非法报错，绝不猜测）
 */
function normalizeCommandType(raw: string | undefined): ExplicitCommandType | null {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) {
    return null;
  }
  if (text === 'list' || text === 'list_conversations' || text === 'list-conversations') {
    return 'list';
  }
  if (text === 'send' || text === 'send_message' || text === 'send-message') {
    return 'send';
  }
  if (text === 'new' || text === 'new_conversation' || text === 'new-conversation') {
    return 'new';
  }
  return null;
}

/** request_id 后缀字符集（大写字母 + 数字，4 位） */
const REQUEST_ID_SUFFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function fail(code: string, message: string): WatchParseResult {
  return { ok: false, code, message };
}

/** 解析 JSON 对象（非对象/数组/解析失败一律返回 null） */
function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 自动生成 request_id：REQ-<yyyyMMddHHmmss>-<4 位大写字母数字>（本地时间）。
 * 时间戳精确到秒，后缀 36^4 空间；同秒内碰撞概率极低，且碰撞语义等价于「重复请求」，
 * 不会造成重复执行（服务端按 requestId 幂等）。
 */
export function generateRequestId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let suffix = '';
  for (let i = 0; i < 4; i += 1) {
    suffix += REQUEST_ID_SUFFIX_ALPHABET[Math.floor(Math.random() * REQUEST_ID_SUFFIX_ALPHABET.length)];
  }
  return `REQ-${stamp}-${suffix}`;
}

/**
 * 非指令判定（收信侧用于区分指令邮件与普通邮件）。
 * 命中任一即为 true：
 * - 行首 `--list` / `--conversation` / `--conversation-id` / `--message` / `--request`
 * - 含 ```delepi-command 围栏
 * - 去首尾空白后整体是含 `command` 字段的 JSON 对象
 */
export function detectCommandMarkers(bodyText: string): boolean {
  const body = typeof bodyText === 'string' ? bodyText : '';
  if (!body) {
    return false;
  }
  if (MARKER_RE.test(body)) {
    return true;
  }
  if (FENCE_TEST_RE.test(body)) {
    return true;
  }
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    const obj = tryParseJson(trimmed);
    if (obj && Object.prototype.hasOwnProperty.call(obj, 'command')) {
      return true;
    }
  }
  return false;
}

interface ParamToken {
  /** 小写参数名 */
  key: string;
  /** 原文参数名（warnings 展示用） */
  rawKey: string;
  /** 同行取值（首尾分隔空白已剥离，内部原样） */
  value: string;
}

/** 把一条参数行切成若干 `--key value` 片段 */
function tokenizeParamLine(line: string): ParamToken[] {
  const matches: Array<{ key: string; rawKey: string; start: number; end: number }> = [];
  const scanner = new RegExp(KEY_TOKEN_RE.source, 'g');
  let matched: RegExpExecArray | null = scanner.exec(line);
  while (matched !== null) {
    const lead = matched[1] ? matched[1].length : 0;
    matches.push({
      key: matched[2].toLowerCase(),
      rawKey: matched[2],
      start: matched.index + lead,
      end: matched.index + matched[0].length,
    });
    matched = scanner.exec(line);
  }

  const tokens: ParamToken[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const valueEnd = index + 1 < matches.length ? matches[index + 1].start : line.length;
    tokens.push({
      key: current.key,
      rawKey: current.rawKey,
      value: line.slice(current.end, valueEnd).trim(),
    });
  }
  return tokens;
}

interface ScannedParam {
  /** 小写参数名 */
  key: string;
  /** 原文参数名（用于 warnings 展示） */
  rawKey: string;
  /** 参数值（多行块已剥离块末结构性空行） */
  value: string;
  /** 是否为多行块取值（--message 同行无值且位于该行末尾的分支） */
  multiline: boolean;
}

interface ScanResult {
  params: ScannedParam[];
  warnings: string[];
}

/**
 * 逐行扫描参数行：
 * - 一行内可出现多个 `--key value`（命令行风格，示例：`--conversation 3 --message 要发送的内容`）
 * - 同行值取到「下一个 --key 边界或行尾」，首尾分隔空白剥离、内部原样
 * - `--message` 同行无值且位于该行末尾 → 吞掉后续所有行，直到下一个参数行，按原始换行拼接
 */
function scanLineParams(body: string): ScanResult {
  const lines = body.split(/\r\n|\n|\r/);
  const params: ScannedParam[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!PARAM_LINE_RE.test(lines[i])) {
      continue;
    }
    const tokens = tokenizeParamLine(lines[i]);
    for (let t = 0; t < tokens.length; t += 1) {
      const token = tokens[t];
      const isLastOnLine = t === tokens.length - 1;

      if (token.key === 'message' && token.value === '' && isLastOnLine) {
        const block: string[] = [];
        let next = i + 1;
        for (; next < lines.length; next += 1) {
          if (PARAM_LINE_RE.test(lines[next])) {
            break;
          }
          block.push(lines[next]);
        }
        // 块末结构性空行（正文结尾换行 / 与下一个参数行之间的空行）不计入内容
        while (block.length > 0 && block[block.length - 1].trim() === '') {
          block.pop();
        }
        params.push({ key: token.key, rawKey: token.rawKey, value: block.join('\n'), multiline: true });
        i = next - 1;
        break;
      }

      if (token.key === 'message' && token.value === '') {
        warnings.push('--message 同行值为空且其后仍有参数，按空内容处理');
      }
      params.push({ key: token.key, rawKey: token.rawKey, value: token.value, multiline: false });
    }
  }

  return { params, warnings };
}

/** 校验并归一 request_id（缺省自动生成；显式给出则必须符合字符集） */
function resolveRequestId(
  param: ScannedParam | undefined,
  warnings: string[],
): { ok: true; requestId: string } | { ok: false; code: string; message: string } {
  if (!param) {
    return { ok: true, requestId: generateRequestId() };
  }
  const value = param.value;
  if (!value) {
    warnings.push('--request 未提供取值，已自动生成 request_id');
    return { ok: true, requestId: generateRequestId() };
  }
  if (!REQUEST_ID_RE.test(value)) {
    return {
      ok: false,
      code: 'ERR_WATCH_FIELD_INVALID',
      message: '字段非法：--request 仅允许字母/数字/下划线/连字符，长度 1-64',
    };
  }
  return { ok: true, requestId: value };
}

/** 命令行风格解析（主解析方式） */
function parseCliParams(scan: ScanResult): WatchParseResult {
  const warnings = [...scan.warnings];
  const byKey = new Map<string, ScannedParam>();

  for (const param of scan.params) {
    if (!KNOWN_KEYS.has(param.key)) {
      warnings.push(`未知参数已忽略：--${param.rawKey}`);
      continue;
    }
    if (byKey.has(param.key)) {
      warnings.push(`参数重复，取最后一次出现的值：--${param.rawKey}`);
    }
    byKey.set(param.key, param);
  }

  const requestOutcome = resolveRequestId(byKey.get('request'), warnings);
  if (!requestOutcome.ok) {
    return fail(requestOutcome.code, requestOutcome.message);
  }
  const requestId = requestOutcome.requestId;

  const listParam = byKey.get('list');
  const limitParam = byKey.get('limit');
  const conversationParam = byKey.get('conversation');
  const conversationIdParam = byKey.get('conversation-id');
  const messageParam = byKey.get('message');

  // ---- 类型判定：显式 --type 优先，缺省按参数组合推断（阶段7 目标4①）----
  const typeParam = byKey.get('type');
  let explicitType: ExplicitCommandType | null = null;
  if (typeParam) {
    if (!typeParam.value) {
      return fail('ERR_WATCH_FIELD_MISSING', '字段缺失：--type 需要取值 list / send / new');
    }
    explicitType = normalizeCommandType(typeParam.value);
    if (!explicitType) {
      return fail(
        'ERR_WATCH_FIELD_INVALID',
        `字段非法：--type 仅支持 list / send / new（收到 "${typeParam.value.slice(0, 20)}"）`,
      );
    }
  }

  const hasConversationRef = Boolean(conversationParam || conversationIdParam);
  const inferredType: ExplicitCommandType | null = listParam
    ? 'list'
    : hasConversationRef && messageParam
      ? 'send'
      : messageParam
        ? 'new'
        : null;
  const commandType = explicitType ?? inferredType;

  if (!commandType) {
    return fail(
      'ERR_WATCH_NO_COMMAND_BLOCK',
      '正文未包含可识别指令：需要 --list / --type list，或 --message（可带 --conversation/--conversation-id），'
        + '或 --type new 新建对话',
    );
  }

  // ---- 查询指令：--list / --type list [--limit N] ----
  if (commandType === 'list') {
    if (listParam && listParam.value) {
      warnings.push(`--list 为开关参数，其取值已忽略：${listParam.value.slice(0, 20)}`);
    }
    let limit = WATCH_LIST_DEFAULT_LIMIT;
    if (limitParam) {
      if (!LIMIT_RE.test(limitParam.value)) {
        return fail('ERR_WATCH_FIELD_INVALID', '字段非法：--limit 须为 1-50 的整数');
      }
      const parsed = Number(limitParam.value);
      if (parsed < WATCH_LIST_MIN_LIMIT || parsed > WATCH_LIST_MAX_LIMIT) {
        return fail('ERR_WATCH_FIELD_INVALID', '字段非法：--limit 须为 1-50 的整数');
      }
      limit = parsed;
    }
    if (hasConversationRef) {
      warnings.push('同时出现查询指令与 --conversation/--conversation-id，按查询指令处理（会话引用已忽略）');
    }
    if (messageParam) {
      warnings.push('查询指令忽略 --message');
    }
    return { ok: true, command: { type: 'list_conversations', requestId, limit }, warnings };
  }

  // ---- 发消息 / 新建对话：--message 为必需项 ----
  if (!messageParam) {
    return fail(
      'ERR_WATCH_FIELD_MISSING',
      commandType === 'send'
        ? '字段缺失：向已有对话发消息需要同时提供 --message'
        : '字段缺失：新建对话指令需要 --message',
    );
  }
  if (listParam) {
    warnings.push('--list 与发消息参数同时出现，按发消息指令处理（--list 已忽略）');
  }
  if (limitParam) {
    warnings.push('--limit 仅对查询指令生效，已忽略');
  }

  // ---- 新建对话：不得带会话引用（有会话引用的意图必须用 --type send 明确表达）----
  if (commandType === 'new') {
    if (hasConversationRef) {
      return fail(
        'ERR_WATCH_FIELD_INVALID',
        '字段非法：新建对话指令不得同时提供 --conversation / --conversation-id；'
          + '若要向已有对话发消息请写 --type send',
      );
    }
    const newMessage = messageParam.value;
    if (newMessage.trim().length === 0) {
      return fail('ERR_WATCH_FIELD_INVALID', '字段非法：--message 内容为空');
    }
    // 零加工原则：message 原样返回（多行块保留原始换行与缩进）
    return { ok: true, command: { type: 'new_conversation', requestId, message: newMessage }, warnings };
  }

  // ---- 向已有对话发消息：必须且只能有一个会话引用 ----
  if (!hasConversationRef) {
    return fail(
      'ERR_WATCH_FIELD_MISSING',
      '字段缺失：--type send 必须指定 --conversation <编号> 或 --conversation-id <UUID>；'
        + '若要新建对话请改用 --type new（或只写 --message）',
    );
  }

  if (conversationParam && conversationIdParam) {
    return fail('ERR_WATCH_FIELD_INVALID', '字段非法：--conversation 与 --conversation-id 不得同时出现');
  }

  let conversationRef: ConversationRef;
  if (conversationIdParam) {
    const id = conversationIdParam.value;
    if (!CONVERSATION_ID_RE.test(id)) {
      return fail('ERR_WATCH_FIELD_INVALID', '字段非法：--conversation-id 须为 36 字符 UUID 文本');
    }
    conversationRef = { kind: 'id', id };
  } else if (conversationParam) {
    const rawIndex = conversationParam.value;
    if (!INDEX_RE.test(rawIndex)) {
      return fail(
        'ERR_WATCH_FIELD_INVALID',
        `字段非法：--conversation 须为 1 起的对话编号（收到 "${rawIndex.slice(0, 20)}"）`,
      );
    }
    const index = Number(rawIndex);
    if (index < 1) {
      return fail('ERR_WATCH_FIELD_INVALID', '字段非法：--conversation 编号须从 1 开始');
    }
    conversationRef = { kind: 'index', index };
  } else {
    return fail('ERR_WATCH_FIELD_MISSING', '字段缺失：缺少 --conversation 或 --conversation-id');
  }

  const message = messageParam.value;
  if (message.trim().length === 0) {
    return fail('ERR_WATCH_FIELD_INVALID', '字段非法：--message 内容为空');
  }

  // 零加工原则：仅做判定，message 原样返回（多行块保留原始换行与缩进）
  return { ok: true, command: { type: 'send_message', requestId, conversationRef, message }, warnings };
}

/** 旧 JSON 指令对象 → 统一命令模型（阶段2 协议兼容） */
function mapLegacyJsonObject(obj: Record<string, unknown>, baseWarnings: string[]): WatchParseResult {
  const warnings = [...baseWarnings];

  const command = obj.command;
  if (command === undefined || command === null || command === '') {
    return fail('ERR_WATCH_FIELD_MISSING', '必填字段缺失：command');
  }
  if (typeof command !== 'string') {
    return fail('ERR_WATCH_FIELD_INVALID', '字段非法：command 必须为字符串');
  }
  // 旧 JSON 的 command 取值同样接受阶段7 的三种归一（含 new_conversation）
  const normalizedCommand = normalizeCommandType(command);
  if (!normalizedCommand) {
    return fail('ERR_WATCH_COMMAND_UNKNOWN', `未知指令：${command.slice(0, 40)}`);
  }

  let requestId: string;
  const rawRequestId = obj.request_id;
  if (rawRequestId === undefined || rawRequestId === null || rawRequestId === '') {
    requestId = generateRequestId();
    warnings.push('旧格式未提供 request_id，已自动生成');
  } else if (typeof rawRequestId !== 'string' || !REQUEST_ID_RE.test(rawRequestId)) {
    return fail('ERR_WATCH_FIELD_INVALID', '字段非法：request_id 仅允许字母/数字/下划线/连字符，长度 1-64');
  } else {
    requestId = rawRequestId;
  }

  if (normalizedCommand === 'list') {
    let limit = WATCH_LIST_DEFAULT_LIMIT;
    if (obj.limit !== undefined) {
      const rawLimit = obj.limit;
      if (
        typeof rawLimit !== 'number'
        || !Number.isInteger(rawLimit)
        || rawLimit < WATCH_LIST_MIN_LIMIT
        || rawLimit > WATCH_LIST_MAX_LIMIT
      ) {
        return fail('ERR_WATCH_FIELD_INVALID', '字段非法：limit 须为 1–50 的整数');
      }
      limit = rawLimit;
    }
    if (obj.include_running !== undefined || obj.format !== undefined) {
      warnings.push('旧格式字段 include_running/format 已废弃并忽略');
    }
    return { ok: true, command: { type: 'list_conversations', requestId, limit }, warnings };
  }

  if (normalizedCommand === 'new') {
    if (obj.conversation_id !== undefined && obj.conversation_id !== null && obj.conversation_id !== '') {
      return fail('ERR_WATCH_FIELD_INVALID', '字段非法：new_conversation 不得同时提供 conversation_id');
    }
    const newMessage = obj.message;
    if (newMessage === undefined || newMessage === null || newMessage === '') {
      return fail('ERR_WATCH_FIELD_MISSING', '必填字段缺失：message');
    }
    if (typeof newMessage !== 'string') {
      return fail('ERR_WATCH_FIELD_INVALID', '字段非法：message 必须为字符串');
    }
    if (newMessage.trim().length === 0) {
      return fail('ERR_WATCH_FIELD_INVALID', '字段非法：message 去首尾空白后为空');
    }
    return { ok: true, command: { type: 'new_conversation', requestId, message: newMessage }, warnings };
  }

  const rawConversationId = obj.conversation_id;
  if (rawConversationId === undefined || rawConversationId === null || rawConversationId === '') {
    return fail('ERR_WATCH_FIELD_MISSING', '必填字段缺失：conversation_id');
  }
  if (typeof rawConversationId !== 'string') {
    return fail('ERR_WATCH_FIELD_INVALID', '字段非法：conversation_id 必须为字符串');
  }
  const trimmedConversationId = rawConversationId.trim();
  let conversationRef: ConversationRef;
  if (CONVERSATION_ID_RE.test(trimmedConversationId)) {
    conversationRef = { kind: 'id', id: trimmedConversationId };
  } else if (INDEX_RE.test(trimmedConversationId) && Number(trimmedConversationId) >= 1) {
    conversationRef = { kind: 'index', index: Number(trimmedConversationId) };
  } else {
    return fail(
      'ERR_WATCH_FIELD_INVALID',
      '字段非法：conversation_id 须为 36 字符 UUID 文本或 1 起的对话编号',
    );
  }

  const rawMessage = obj.message;
  if (rawMessage === undefined || rawMessage === null || rawMessage === '') {
    return fail('ERR_WATCH_FIELD_MISSING', '必填字段缺失：message');
  }
  if (typeof rawMessage !== 'string') {
    return fail('ERR_WATCH_FIELD_INVALID', '字段非法：message 必须为字符串');
  }
  if (rawMessage.trim().length === 0) {
    return fail('ERR_WATCH_FIELD_INVALID', '字段非法：message 去首尾空白后为空');
  }
  return { ok: true, command: { type: 'send_message', requestId, conversationRef, message: rawMessage }, warnings };
}

/** 旧格式探测与解析：正文不存在任何旧格式形态时返回 null */
function parseLegacyJsonBody(body: string, baseWarnings: string[]): WatchParseResult | null {
  const fenceCount = (body.match(FENCE_HEADER_RE) || []).length;
  let jsonText: string | null = null;

  if (fenceCount === 1) {
    const matched = FENCE_BLOCK_RE.exec(body);
    jsonText = matched ? matched[1].trim() : null;
    if (!jsonText) {
      return fail('ERR_WATCH_NO_COMMAND_BLOCK', 'delepi-command 围栏存在但内容为空');
    }
  } else if (fenceCount > 1) {
    return fail('ERR_WATCH_NO_COMMAND_BLOCK', `正文存在 ${fenceCount} 个 delepi-command 围栏（要求恰好 1 个）`);
  } else {
    const trimmed = body.trim();
    if (!trimmed.startsWith('{')) {
      return null;
    }
    jsonText = trimmed;
  }

  const obj = tryParseJson(jsonText);
  if (!obj) {
    return fail('ERR_WATCH_NO_COMMAND_BLOCK', '指令块 JSON 解析失败');
  }
  return mapLegacyJsonObject(obj, baseWarnings);
}

/**
 * 解析指令邮件正文。
 * 顺序：命令行风格（主） → 旧 JSON 围栏/整段 JSON（兼容）→ ERR_WATCH_NO_COMMAND_BLOCK。
 */
export function parseWatchCommand(bodyText: string): WatchParseResult {
  const body = typeof bodyText === 'string' ? bodyText : '';
  if (body.length > WATCH_COMMAND_BODY_MAX_CHARS) {
    return fail(
      'ERR_WATCH_BODY_TOO_LARGE',
      `正文超过 ${WATCH_COMMAND_BODY_MAX_CHARS} 字符（实际 ${body.length}）`,
    );
  }

  const scan = scanLineParams(body);
  if (scan.params.length > 0) {
    const cliResult = parseCliParams(scan);
    if (cliResult.ok || cliResult.code !== 'ERR_WATCH_NO_COMMAND_BLOCK') {
      return cliResult;
    }
    // 行首参数未构成完整命令行指令时，再尝试旧 JSON 形态（正文确实存在围栏/整段 JSON 才回退）
    const legacyResult = parseLegacyJsonBody(body, scan.warnings);
    if (legacyResult) {
      return legacyResult;
    }
    return cliResult;
  }

  const legacyOnly = parseLegacyJsonBody(body, []);
  if (legacyOnly) {
    return legacyOnly;
  }
  return fail('ERR_WATCH_NO_COMMAND_BLOCK', '正文既无行首 --key 指令，也不是 JSON 指令对象');
}
