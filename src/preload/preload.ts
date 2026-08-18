/**
 * Preload 脚本 - contextBridge 安全暴露 API
 *
 * Phase 3 P0 适配层：
 * - electronAPI.executor.onThinking(callback)：订阅子智能体 thinking / 工具进度（已由主进程推送）
 * - electronAPI.executor.onSnapshot(callback)：订阅子智能体中间快照（已由主进程推送）
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHAT, IPC_CONFIG, IPC_CONV, IPC_EXECUTOR, IPC_FILE, IPC_PYTHON, IPC_DEPS, IPC_DIALOG } from '@shared/ipc-channels';
import { GET_LAST_ACTIVE_CONVERSATION } from '@shared/last-active-conversation';
import type { DepsInstallParams, DepsInstallProgress } from '@shared/types/deps';

const electronAPI = {
  chat: {
    send: (params: unknown) => ipcRenderer.invoke(IPC_CHAT.SEND, params),
    abort: (conversationId: string) => ipcRenderer.send(IPC_CHAT.ABORT, conversationId),
  },
  conversations: {
    list: () => ipcRenderer.invoke(IPC_CONV.LIST),
    create: () => ipcRenderer.invoke(IPC_CONV.CREATE),
    delete: (id: string) => ipcRenderer.invoke(IPC_CONV.DELETE, id),
    getMessages: (id: string) => ipcRenderer.invoke(IPC_CONV.GET_MESSAGES, id),
    /**
     * v2恢复方案：获取上次活跃的对话ID
     * 主进程内存维护，重启后返回 null → 场景C退化
     */
    getRestoreConversationId: () => ipcRenderer.invoke(GET_LAST_ACTIVE_CONVERSATION),
  },
  config: {
    get: () => ipcRenderer.invoke(IPC_CONFIG.GET),
    save: (params: unknown) => ipcRenderer.invoke(IPC_CONFIG.SAVE, params),
    reload: () => ipcRenderer.invoke(IPC_CONFIG.RELOAD),
  },
  file: {
    open: (target: string) => ipcRenderer.invoke(IPC_FILE.OPEN, target),
    /**
     * 上传单个文件到对话 uploads 目录（主进程落盘）
     * P5 文件上传独立 IPC 通道，对齐 E:\ai_fr app/api/uploads/route.ts POST
     * @param params FileUploadParams: { conversationId, name, size, contentType, data }
     * @returns FileUploadResult: { file: ChatUploadedFile }
     */
    upload: (params: unknown) => ipcRenderer.invoke(IPC_FILE.UPLOAD, params),
    /**
     * 列出对话 uploads/ 目录下全部已上传文件
     * P5 文件上传独立 IPC 通道，对齐 E:\ai_fr app/api/uploads/route.ts GET（仅列清单部分）
     * @param params FileListParams: { conversationId }
     * @returns FileListResult: { files: ChatUploadedFile[] }
     */
    list: (params: unknown) => ipcRenderer.invoke(IPC_FILE.LIST, params),
    /**
     * 删除已上传的单个文件（磁盘 + manifest 一并清理）
     * P5 文件上传独立 IPC 通道，对齐 E:\ai_fr app/api/uploads/route.ts DELETE
     * @param params FileDeleteParams: { conversationId, storageKey }
     * @returns FileDeleteResult: { success: boolean }
     */
    delete: (params: unknown) => ipcRenderer.invoke(IPC_FILE.DELETE, params),
    /**
     * 读取已上传文件的二进制内容(P7 切换会话恢复待发送文件)
     * 用于在切回原会话时从主进程读取文件内容,前端用 URL.createObjectURL 重建预览
     * @param params FileReadParams: { conversationId, storageKey }
     * @returns FileReadResult: { data: ArrayBuffer, name: string, size: number }
     */
    read: (params: unknown) => ipcRenderer.invoke(IPC_FILE.READ, params),
    /**
     * P9 孤儿清理(手动触发)
     * 扫描 bin/conversations/ 目录,删除 SQLite 中无引用的会话目录
     * @param params FileCleanupOrphansParams: {}
     * @returns FileCleanupOrphansResult: { removedConversationIds, scannedCount, removedCount }
     */
    cleanupOrphans: (params: unknown = {}) => ipcRenderer.invoke(IPC_FILE.CLEANUP_ORPHANS, params),
  },
  executor: {
    /**
     * 订阅子智能体 thinking / 工具进度事件（Phase 3 P0-1 适配层）
     * 主进程已通过 executor:thinking 通道推送真实数据（main-agent.ts emit → ipc-handlers.ts 白名单转发）
     * 通道已就绪，调用方注册 listener 后即生效
     * @param listener 回调函数，参数为 IPC 推送载荷
     * @returns 取消监听的函数
     */
    onThinking: (listener: (payload: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
        listener(args[0]);
      ipcRenderer.on(IPC_EXECUTOR.THINKING, handler);
      return () => {
        ipcRenderer.removeListener(IPC_EXECUTOR.THINKING, handler);
      };
    },
    /**
     * 订阅子智能体执行中间快照事件（Phase 3 P0-3 适配层）
     * 主进程已通过 executor:snapshot 通道推送真实快照数据（main-agent.ts sendToolSnapshot 唯一出口），前端按 callId 键 upsert 到 toolSnapshots
     * @param listener 回调函数，参数为 IPC 推送载荷
     * @returns 取消监听的函数
     */
    onSnapshot: (listener: (payload: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
        listener(args[0]);
      ipcRenderer.on(IPC_EXECUTOR.SNAPSHOT, handler);
      return () => {
        ipcRenderer.removeListener(IPC_EXECUTOR.SNAPSHOT, handler);
      };
    },
    /**
     * 订阅子智能体工具进度事件
     * ★ 修复主/子智能体消息混淆：后端 main-agent.ts 的 onToolCall / onToolResult 回调 emit
     *   'executor:tool-progress' 事件，前端 useChat.ts 订阅后按 taskId/taskName 聚合到
     *   toolSnapshots 状态（独立于主消息 toolCalls 字段），实现主/子智能体消息分流
     * @param listener 回调函数，参数为 IPC 推送载荷
     * @returns 取消监听的函数
     */
    onToolProgress: (listener: (payload: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
        listener(args[0]);
      ipcRenderer.on(IPC_EXECUTOR.TOOL_PROGRESS, handler);
      return () => {
        ipcRenderer.removeListener(IPC_EXECUTOR.TOOL_PROGRESS, handler);
      };
    },
  },
  python: {
    /**
     * 查询 Python 环境状态
     * @returns PythonStatus { state, progress?, error?, pythonPath? }
     */
    getStatus: () => ipcRenderer.invoke(IPC_PYTHON.GET_STATUS),
    /**
     * 订阅 Python 状态变更事件
     * @param listener 回调函数，参数为 PythonStatus
     * @returns 取消监听的函数
     */
    onStatusChanged: (listener: (status: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
        listener(args[0]);
      ipcRenderer.on(IPC_PYTHON.STATUS_CHANGED, handler);
      return () => {
        ipcRenderer.removeListener(IPC_PYTHON.STATUS_CHANGED, handler);
      };
    },
    detectSystem: () => ipcRenderer.invoke(IPC_PYTHON.DETECT_SYSTEM),
    download: () => ipcRenderer.invoke(IPC_PYTHON.DOWNLOAD),
    selectCustom: () => ipcRenderer.invoke(IPC_PYTHON.SELECT_CUSTOM),
    /** 取消当前 Python 安装/下载操作 */
    cancel: () => ipcRenderer.invoke(IPC_PYTHON.CANCEL),
  },
  deps: {
    /**
     * 安装依赖包
     * @param params DepsInstallParams { level, mirrorUrl?, autoBootstrap? }
     * @returns Promise<{ success: boolean; error?: string }>
     */
    install: (params: DepsInstallParams) =>
      ipcRenderer.invoke(IPC_DEPS.INSTALL, params),
    /**
     * 导出当前已安装依赖包为离线 bundle
     * @returns Promise<DepsExportResult>
     */
    exportBundle: (destPath?: string) =>
      ipcRenderer.invoke(IPC_DEPS.EXPORT, destPath),
    /**
     * 从离线 bundle 导入依赖包
     * @param filePath bundle 文件路径
     * @returns Promise<DepsImportResult>
     */
    importBundle: (filePath: string) =>
      ipcRenderer.invoke(IPC_DEPS.IMPORT, filePath),
    /**
     * 取消当前安装操作
     * @returns Promise<{ success: boolean; error?: string }>
     */
    cancelInstall: () =>
      ipcRenderer.invoke(IPC_DEPS.CANCEL),
    /**
     * 获取已安装的依赖包列表
     * @returns Promise<{ success: boolean; packages?: DepsPackage[]; error?: string }>
     */
    getInstalledPackages: () =>
      ipcRenderer.invoke(IPC_DEPS.GET_INSTALLED),
    /**
     * 弹出保存对话框选择导出路径
     * @returns Promise<{ success: boolean; filePath?: string | null; error?: string }>
     */
    selectExportPath: () =>
      ipcRenderer.invoke(IPC_DEPS.SELECT_EXPORT_PATH),
    /**
     * 获取已安装包列表（含 name+version+size）（Phase3）
     * @returns Promise<{ name: string; version: string; size: number }[]>
     */
    getPackages: () =>
      ipcRenderer.invoke(IPC_DEPS.GET_PACKAGES),
    /**
     * 触发刷新已安装包列表（SHA256 对比+全量替换）（Phase3）
     * @returns Promise<{ changed: boolean; error?: string }>
     */
    refresh: () =>
      ipcRenderer.invoke(IPC_DEPS.REFRESH),
    /**
     * 解析导入文件（.txt / .zip），返回解析出的依赖包列表
     * @param filePath 文件路径
     * @returns Promise<ParsedImportResult>
     */
    parseImportFile: (filePath: string) =>
      ipcRenderer.invoke(IPC_DEPS.PARSE_IMPORT_FILE, filePath),
    /**
     * 订阅依赖安装进度推送
     * @param callback 进度回调，参数为 DepsInstallProgress
     * @returns 取消订阅的函数
     */
    onProgress: (callback: (progress: DepsInstallProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
        callback(args[0] as DepsInstallProgress);
      ipcRenderer.on(IPC_DEPS.PROGRESS, handler);
      return () => {
        ipcRenderer.removeListener(IPC_DEPS.PROGRESS, handler);
      };
    },
  },
  dialog: {
    /**
     * 打开文件选择对话框
     * @param options Electron OpenDialogOptions
     * @returns Promise<Electron.OpenDialogReturnValue>
     */
    showOpenDialog: (options: unknown) =>
      ipcRenderer.invoke(IPC_DIALOG.SHOW_OPEN, options),
  },

  /**
   * 监听主进程推送的事件
   * @param channel IPC 通道名
   * @param listener 回调函数
   * @returns 取消监听的函数
   */
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(...args);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;
