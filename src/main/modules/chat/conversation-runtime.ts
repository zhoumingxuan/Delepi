/**
 * 对话运行时管理
 *
 * 适配自 E:\ai_fr\lib\chat\runtime.ts
 * 简化为 Delepi 单用户 Electron 架构：
 * - 进程级 Map 足够（无需 userId 维度）
 * - 仅保留核心功能：beginConversationRun / finishConversationRun / abortConversationRun
 */

/** 全局对话运行状态：conversationId → AbortController */
const conversationRunMap = new Map<string, AbortController>();

/**
 * 开始对话运行
 * 并发保护：若同一对话已在运行中则返回 null
 */
export function beginConversationRun(
  conversationId: string,
): AbortController | null {
  if (conversationRunMap.has(conversationId)) {
    return null;
  }

  const controller = new AbortController();
  conversationRunMap.set(conversationId, controller);
  return controller;
}

/**
 * 结束对话运行
 * 从运行 Map 中移除指定对话
 */
export function finishConversationRun(conversationId: string): void {
  conversationRunMap.delete(conversationId);
}

/**
 * 中止对话运行
 * 触发 AbortController.abort() 并返回是否成功
 */
export function abortConversationRun(conversationId: string): boolean {
  const controller = conversationRunMap.get(conversationId);

  if (!controller) {
    return false;
  }

  controller.abort();
  conversationRunMap.delete(conversationId);
  return true;
}
