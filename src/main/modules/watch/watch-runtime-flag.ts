/**
 * watch-runtime-flag — 值守运行态标志与值守指令上下文类型（阶段3）
 *
 * 职责（v3 §11 原定 watch-runtime-flag.ts，无依赖纯状态/类型模块）：
 * - 运行态标志：watch-service 在自检通过/关闭回落时置位与清零；
 *   send-email.ts 执行体经 isWatchRuntimeRunning() 做执行层拦截
 *   （值守未运行 → TOOL_DISABLED_WATCH_OFF，v3 §8.5）；声明层装配判定同源
 *   （prompt.ts buildMainTools 以本标志为唯一判定源）。
 *   独立成模块的原因：send-email.ts 不得反向依赖 watch-service
 *   （watch-service → conversation-send-service → runMainAgent → send-email 已成链，
 *   再回指 watch-service 将构成 ES 模块循环依赖）。
 * - 值守指令上下文（WatchCommandContext）：所有者=run 实例——watch-service 在
 *   launchInjectRunInBackground 内为每次注入创建私有对象，随
 *   sendUserMessageIntoConversation → runMainAgent → executeSendEmailTool 调用链传递；
 *   send-email.ts 读它自动补全 In-Reply-To/References（=指令邮件收件箱实际 Message-ID，
 *   腾讯会改写声明值）与 X-Delepi-Command-Id，并在发送成功时直接在同一对象上置位
 *   receiptSentByAgent 等回执观测字段（单轨回执防重发数据源）；run 终态后随实例消亡。
 */

/** 值守指令邮件上下文（run 实例私有；注入前由 watch-service 创建，随调用链传入 send-email 工具体） */
export interface WatchCommandContext {
  /** 指令 request_id（X-Delepi-Command-Id 回带值） */
  requestId: string;
  /** 指令邮件在收件箱中的实际 Message-ID（腾讯改写值；In-Reply-To/References 自动补全源） */
  commandMessageId: string;
  /** 指令邮件发件人（From 头解析结果，非空） */
  from: string;
  /** 回执收件人解析结果（watchReceiptRecipient 非空取之，否则值守邮箱自身，Q7） */
  receiptRecipient: string;
  /** 主智能体是否已经 send_email 工具发出回执（发送成功时由 send-email.ts 在本对象上置位） */
  receiptSentByAgent: boolean;
  /** 已发出回执的收件人（观测用；未发出为空串） */
  receiptSentTo: string;
  /** 已发出回执的声明 Message-ID（观测用；未发出为空串） */
  receiptSentMessageId: string;
  /** 已发出回执携带的附件数（观测用；未发出为 0） */
  receiptAttachmentCount: number;
}

/** 值守运行态标志（true=watch-service 自检通过进入 running） */
let watchRuntimeRunning = false;

/** 置位/清零值守运行态（watch-service 调用） */
export function setWatchRuntimeRunning(running: boolean): void {
  watchRuntimeRunning = running;
}

/** 读取值守运行态（send-email.ts 执行层拦截与 prompt.ts 声明层装配的共同判定源） */
export function isWatchRuntimeRunning(): boolean {
  return watchRuntimeRunning;
}
