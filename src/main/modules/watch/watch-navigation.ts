/**
 * watch-navigation — 值守指令 → 前端会话跳转（阶段7 目标5②）
 *
 * 职责边界（单一职责，便于受控断言）：
 * - 定义主进程推送给渲染层的载荷结构（IPC_WATCH.COMMAND_NAVIGATE）；
 * - 定义「哪些邮件处理状态绝不触发跳转」的判定表：role_filtered / subject_filtered /
 *   sender_rejected / non_command —— 这四类在 watch-service.processWatchMail 的 ①~④ 步
 *   直接返回，尚未解析任何指令，因此不存在任何跳转路径；
 * - 纯函数、零依赖（不 import electron），可被 harness 直接断言。
 *
 * 注意：真正的 ipc 推送在 watch-service（持有 BrowserWindow），本模块只产生载荷与判定，
 * 这样「哪四类不跳转」可以被独立测试，不依赖 Electron 运行环境。
 */

/** 会触发跳转的指令类型（list_conversations 无目标会话，不跳转） */
export type WatchNavigationCommandType = 'send_message' | 'new_conversation';

/** 推送给渲染层的载荷（preload 原样透传，渲染层按 conversationId 切会话） */
export interface WatchCommandNavigationPayload {
  /** 目标会话 id（新建对话指令=新建出的会话 id） */
  conversationId: string;
  /** 目标会话标题（新建对话时为默认标题「新对话」，渲染层用于提示文案） */
  conversationTitle: string;
  /** 指令类型（渲染层据此区分提示语：向已有对话发消息 / 新建对话） */
  commandType: WatchNavigationCommandType;
  /** 指令请求号（REQ- 或 RESUME- 前缀，用于日志与提示对齐） */
  requestId: string;
  /** 指令邮件主题（截断后展示） */
  subject: string;
  /** 指令被接受的时间（ISO 8601） */
  receivedAtIso: string;
  /** 是否为本轮新建的对话（新建对话指令=true） */
  createdNewConversation: boolean;
}

/**
 * 永不触发跳转的邮件处理状态（processWatchMail ①~④ 步的返回状态）：
 * - role_filtered      X-Delepi-Role 头存在（防回执环第一道）
 * - subject_filtered   主题前缀 [Delepi回执]（防回执环第二道）
 * - sender_rejected    From 头缺失/解析失败（不可判定来源）
 * - non_command        未命中任何指令标记（静默忽略、零回执）
 */
export const WATCH_NAVIGATION_SUPPRESSED_STATUSES = [
  'role_filtered',
  'subject_filtered',
  'sender_rejected',
  'non_command',
] as const;

/** 该处理状态是否被禁止跳转（上述四类为 true） */
export function isNavigationSuppressedStatus(status: string): boolean {
  return (WATCH_NAVIGATION_SUPPRESSED_STATUSES as readonly string[]).includes(status);
}

/** 构造跳转载荷（subject 截断 80 字符，避免超大主题进 IPC） */
export function buildCommandNavigationPayload(params: {
  conversationId: string;
  conversationTitle: string;
  commandType: WatchNavigationCommandType;
  requestId: string;
  subject: string;
  receivedAtIso: string;
}): WatchCommandNavigationPayload {
  const subject = String(params.subject ?? '').replace(/\s+/g, ' ').trim();
  return {
    conversationId: params.conversationId,
    conversationTitle: params.conversationTitle || '新对话',
    commandType: params.commandType,
    requestId: params.requestId,
    subject: subject.length > 80 ? `${subject.slice(0, 80)}…` : subject,
    receivedAtIso: params.receivedAtIso,
    createdNewConversation: params.commandType === 'new_conversation',
  };
}
