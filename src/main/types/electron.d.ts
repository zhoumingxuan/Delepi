/**
 * Electron 环境类型声明
 *
 * Phase 3 P0 适配层：
 * - executor.onThinking(callback)：订阅子智能体 thinking / 工具进度
 * - executor.onSnapshot(callback)：订阅子智能体执行中间快照
 */

/** 通过 contextBridge 暴露给渲染进程的 API */
export interface ElectronAPI {
  chat: {
    send: (params: import('./ipc').ChatSendParams) => Promise<import('./ipc').ChatSendResult>;
    abort: (conversationId: string) => void;
  };
  conversations: {
    list: () => Promise<import('./ipc').ConversationListItem[]>;
    create: () => Promise<import('./ipc').ConversationListItem>;
    delete: (id: string) => Promise<void>;
    getMessages: (id: string) => Promise<unknown[]>;
    /** v2恢复方案：获取上次活跃的对话ID，主进程内存维护，重启后返回null */
    getRestoreConversationId: () => Promise<string | null>;
  };
  config: {
    get: () => Promise<import('./config').AppSettings>;
    save: (params: import('./ipc').ConfigSaveParams) => Promise<void>;
    reload: () => Promise<void>;
  };
  file: {
    open: (target: string) => Promise<void>;
    /**
     * P5 文件上传独立 IPC 通道
     * @param params FileUploadParams: { conversationId, name, size, contentType, data }
     * @returns FileUploadResult: { file: ChatUploadedFile }
     */
    upload: (params: import('./ipc').FileUploadParams) => Promise<import('./ipc').FileUploadResult>;
    /**
     * P5 文件上传独立 IPC 通道
     * @param params FileListParams: { conversationId }
     * @returns FileListResult: { files: ChatUploadedFile[] }
     */
    list: (params: import('./ipc').FileListParams) => Promise<import('./ipc').FileListResult>;
    /**
     * P5 文件上传独立 IPC 通道
     * @param params FileDeleteParams: { conversationId, storageKey }
     * @returns FileDeleteResult: { success: boolean }
     */
    delete: (params: import('./ipc').FileDeleteParams) => Promise<import('./ipc').FileDeleteResult>;
    /**
     * P7 文件读取 IPC 通道
     * 用于切换会话时从主进程读取已上传文件二进制,前端用 URL.createObjectURL 重建预览
     * @param params FileReadParams: { conversationId, storageKey }
     * @returns FileReadResult: { data: ArrayBuffer, name: string, size: number }
     */
    read: (params: import('./ipc').FileReadParams) => Promise<import('./ipc').FileReadResult>;
    /**
     * P9 孤儿清理(手动触发)
     * 扫描 bin/conversations/ 目录,删除 SQLite 中无引用的会话目录
     * @param params FileCleanupOrphansParams: {}
     * @returns FileCleanupOrphansResult: { removedConversationIds, scannedCount, removedCount }
     */
    cleanupOrphans: (params?: import('./ipc').FileCleanupOrphansParams) => Promise<import('./ipc').FileCleanupOrphansResult>;
  };
  executor: {
    /** Phase 3 P0-1 适配层：订阅子智能体 thinking / 工具进度推送 */
    onThinking: (listener: (payload: unknown) => void) => () => void;
    /** Phase 3 P0-3 适配层：订阅子智能体执行中间快照推送 */
    onSnapshot: (listener: (payload: unknown) => void) => () => void;
    /**
     * Phase 3 P0-2 适配层：订阅子智能体工具进度推送
     * ★ 修复主/子智能体消息混淆：后端 main-agent.ts 的 onToolCall / onToolResult 回调
     *   emit 'executor:tool-progress' 事件，前端 useChat.ts 订阅后按 taskId/taskName 聚合到
     *   toolSnapshots 状态（独立于主消息 toolCalls 字段），实现主/子智能体消息分流
     */
    onToolProgress: (listener: (payload: unknown) => void) => () => void;
  };
  deps: {
    /** 安装依赖包 */
    install: (params: import('@shared/types/deps').DepsInstallParams) => Promise<{ success: boolean; error?: string; packages?: import('@shared/types/deps').DepsPackage[] }>;
    /** 取消当前安装操作 */
    cancelInstall: () => Promise<{ success: boolean; error?: string }>;
    /** 导出当前已安装依赖包为离线 bundle（可选目标路径） */
    exportBundle: (destPath?: string) => Promise<import('@shared/types/deps').DepsExportResult>;
    /** 从离线 bundle 导入依赖包 */
    importBundle: (filePath: string) => Promise<import('@shared/types/deps').DepsImportResult>;
    /** 获取已安装的依赖包列表 */
    getInstalledPackages: () => Promise<{ success: boolean; packages?: import('@shared/types/deps').DepsPackage[]; error?: string }>;
    /** 弹出保存对话框选择导出路径 */
    selectExportPath: () => Promise<{ success: boolean; filePath?: string | null; error?: string }>;
    /** 获取已安装包列表（含 name+version+size）（Phase3） */
    getPackages: () => Promise<{ name: string; version: string; size: number }[]>;
    /** 触发刷新已安装包列表（Phase3） */
    refresh: () => Promise<{ changed: boolean; error?: string }>;
    /** 解析导入文件（.txt / .zip），返回解析出的依赖包列表 */
    parseImportFile: (filePath: string) => Promise<import('@shared/types/deps-import').ParsedImportResult>;
    /** 订阅依赖安装进度推送 */
    onProgress: (callback: (progress: import('@shared/types/deps').DepsInstallProgress) => void) => () => void;
  };
  python: {
    /** 查询 Python 环境状态 */
    getStatus: () => Promise<import('./python').PythonStatus>;
    /** 订阅 Python 状态变更事件 */
    onStatusChanged: (listener: (status: import('./python').PythonStatus) => void) => () => void;
    /** 检测系统 Python 环境 */
    detectSystem: () => Promise<import('./python').SystemPythonInfo>;
    /** 下载/安装 Python */
    download: () => Promise<void>;
    /** 选择自定义 Python 解释器路径 */
    selectCustom: () => Promise<import('./python').SystemPythonInfo>;
    /** 取消当前 Python 安装/下载操作 */
    cancel: () => Promise<void>;
  };
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
