/**
 * 最近活跃对话恢复 — 共享常量
 *
 * 设计原则：
 * - 仅导出 handler 名称常量，供主进程(ipcMain.handle)和preload(ipcRenderer.invoke)共用
 * - 实际状态(lastActiveConversationId)在主进程 ipc-handlers.ts 模块作用域维护
 * - 重启后内存自然清空 → get-last-active-conversation 返回 null → 场景C退化
 *
 * 约束：零新增 ipc-channels.ts 常量（本模块独立于 IPC_CONV）
 */

/** get-last-active-conversation handler 通道名 */
export const GET_LAST_ACTIVE_CONVERSATION = 'get-last-active-conversation' as const;
