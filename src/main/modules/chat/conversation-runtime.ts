/**
 * 对话运行时管理
 *
 * 适配自 E:\ai_fr\lib\chat\runtime.ts
 * 简化为 Delepi 单用户 Electron 架构：
 * - 进程级 Map 足够（无需 userId 维度）
 * - 仅保留核心功能：beginConversationRun / finishConversationRun / abortConversationRun
 */

/**
 * 全局对话运行状态：conversationId → AbortController
 * ★ 闸门生命周期与 run 实例绑定模型：条目在 beginConversationRun 创建后，仅由持有
 *   该控制器实例的 run 在真实 settle 时经 finishConversationRun（实例归属校验）释放；
 *   abortConversationRun 只触发取消、不提前释放条目——保证任意时刻同会话至多一个 run，
 *   且旧 run 的退出不可能删除/覆盖新 run 的 AbortController 与状态。
 */
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
 * 结束对话运行（run 真实 settle 的唯一闸门释放出口）
 * ★ 缺陷①根因修复（实例归属校验）：仅当闸门条目仍归属本次 run 的控制器实例时才移除，
 *   旧 run 的退出不得删除/覆盖新 run 的 AbortController（原按键盲删会在取消-settle
 *   窗口错杀后继 run 的控制器，导致后续任何手动取消因 get 返回 undefined 而失效）。
 * @returns 是否实际移除（false = 条目已不归属该控制器，本 run 无权触碰闸门与状态）
 */
export function finishConversationRun(
  conversationId: string,
  controller: AbortController,
): boolean {
  if (conversationRunMap.get(conversationId) !== controller) {
    return false;
  }
  conversationRunMap.delete(conversationId);
  return true;
}

/**
 * 中止对话运行
 * 触发 AbortController.abort() 并返回是否成功
 * ★ 缺陷①根因修复（闸门生命周期与 run 实例绑定）：abort 只触发控制器取消，不再
 *   立即删除闸门条目——条目由该 run 真实 settle（chat:send finally）经
 *   finishConversationRun 实例归属校验后释放。取消-settle 窗口内同会话新 chat:send
 *   仍被 beginConversationRun 并发拒绝（不产生并发双 run，杜绝错杀），渲染层
 *   "取消后立刻重发"由取消待收口队列在 settle 时刻（flightKey/闸门同点释放）自动重发。
 */
export function abortConversationRun(conversationId: string): boolean {
  const controller = conversationRunMap.get(conversationId);

  if (!controller) {
    return false;
  }

  controller.abort();
  return true;
}
