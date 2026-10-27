/**
 * watch-runtime-flag — 值守运行态标志与值守指令上下文表（阶段3）
 *
 * 职责（v3 §11 原定 watch-runtime-flag.ts，无依赖纯状态模块）：
 * - 运行态标志：watch-service 在自检通过/关闭回落时置位与清零；
 *   send-email.ts 执行体经 isWatchRuntimeRunning() 做执行层拦截
 *   （watchEnabled=true 但服务未运行 → TOOL_DISABLED_WATCH_OFF，v3 §8.5）。
 *   独立成模块的原因：send-email.ts 不得反向依赖 watch-service
 *   （watch-service → conversation-send-service → runMainAgent → send-email 已成链，
 *   再回指 watch-service 将构成 ES 模块循环依赖）。
 * - 值守指令上下文表（conversationId → 指令邮件上下文）：watch-service 在调用
 *   sendUserMessageIntoConversation 前写入、run 终态后读取并清除；
 *   send-email.ts 执行体读取它自动补全 In-Reply-To/References（=指令邮件收件箱
 *   实际 Message-ID，腾讯会改写声明值）与 X-Delepi-Command-Id，模型无需也无法
 *   感知 Message-ID 具体值（v3 §8.6-3）；回执是否已由主智能体发出（单轨回执的
 *   可观测标志）也记录在此，供 watch-service 终态登记 watch_processed_mails。
 */

/** 值守指令邮件上下文（阶段3：send_message 注入链路的头补全与回执观测数据源） */
export interface WatchCommandContext {
  /** 指令 request_id（X-Delepi-Command-Id 回带值） */
  requestId: string;
  /** 指令邮件在收件箱中的实际 Message-ID（腾讯改写值；In-Reply-To/References 自动补全源） */
  commandMessageId: string;
  /** 指令邮件发件人（From 头解析结果，非空） */
  from: string;
  /** 回执收件人解析结果（watchReceiptRecipient 非空取之，否则值守邮箱自身，Q7） */
  receiptRecipient: string;
  /** 主智能体是否已经 send_email 工具发出回执（发送成功时由 send-email.ts 置位） */
  receiptSentByAgent: boolean;
  /** 已发出回执的收件人（观测用；未发出为空串） */
  receiptSentTo: string;
  /** 已发出回执的声明 Message-ID（观测用；未发出为空串） */
  receiptSentMessageId: string;
  /** 已发出回执携带的附件数（观测用；未发出为 0） */
  receiptAttachmentCount: number;
}

/** 写入上下文表时的入参（回执观测三字段由内部初始化） */
export type WatchCommandContextInput = Pick<
  WatchCommandContext,
  'requestId' | 'commandMessageId' | 'from' | 'receiptRecipient'
>;

/** 值守运行态标志（true=watch-service 自检通过进入 running） */
let watchRuntimeRunning = false;

/** 指令上下文表：conversationId → 上下文（同会话同时至多一条在途值守指令——与会话闸门互斥一致） */
const commandContextMap = new Map<string, WatchCommandContext>();

/** 置位/清零值守运行态（watch-service 调用） */
export function setWatchRuntimeRunning(running: boolean): void {
  watchRuntimeRunning = running;
}

/** 读取值守运行态（send-email.ts 执行层拦截数据源） */
export function isWatchRuntimeRunning(): boolean {
  return watchRuntimeRunning;
}

/** 写入值守指令上下文（watch-service 在 sendUserMessageIntoConversation 调用前） */
export function setWatchCommandContext(conversationId: string, input: WatchCommandContextInput): void {
  commandContextMap.set(conversationId, {
    ...input,
    receiptSentByAgent: false,
    receiptSentTo: '',
    receiptSentMessageId: '',
    receiptAttachmentCount: 0,
  });
}

/** 读取值守指令上下文（返回浅拷贝，防调用方篡改内部状态；无上下文返回 null） */
export function getWatchCommandContext(conversationId: string): WatchCommandContext | null {
  const entry = commandContextMap.get(conversationId);
  return entry ? { ...entry } : null;
}

/** 标记该会话的回执已由主智能体经 send_email 发出（send-email.ts 发送成功时调用；无上下文为 no-op） */
export function markWatchCommandReceiptSent(
  conversationId: string,
  sentTo: string,
  declaredMessageId: string,
  attachmentCount: number,
): void {
  const entry = commandContextMap.get(conversationId);
  if (!entry) {
    return;
  }
  entry.receiptSentByAgent = true;
  entry.receiptSentTo = sentTo;
  entry.receiptSentMessageId = declaredMessageId;
  entry.receiptAttachmentCount = attachmentCount;
}

/** 清除值守指令上下文（watch-service 在 run 终态登记后调用） */
export function clearWatchCommandContext(conversationId: string): void {
  commandContextMap.delete(conversationId);
}
