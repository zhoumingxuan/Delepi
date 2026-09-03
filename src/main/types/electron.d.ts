/**
 * Electron 环境类型声明
 *
 * Phase 3 P0 适配层：
 * - executor.onSnapshot(callback)：订阅子智能体六字段信号（v2.1 M1/D2 收敛）
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
    /** 轻量快照查询：返回 Array<{toolCallId, message, toolCalls}>（正在运行的任务快照三元组） */
    getRunningSnapshots: (id: string) => Promise<unknown[]>;
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
    /** Phase 3 P0-3 适配层：订阅子智能体执行中间快照推送（v2.1 M1/D2：六字段信号） */
    onSnapshot: (listener: (payload: unknown) => void) => () => void;
  };
  python: {
    /** 下载/安装 Python */
    download: () => Promise<void>;
    /** 选择自定义 Python 解释器路径 */
    selectCustom: () => Promise<import('./python').SystemPythonInfo>;
  };
  skills: {
    /** 列出内置8标签（只读，含 fileName）与自定义标签元数据+上限 */
    list: () => Promise<unknown>;
    /** 新建/编辑自定义技能标签与模板（originalName=编辑时的原标签名；新建不传） */
    save: (params: unknown) => Promise<unknown>;
    /** 删除自定义技能标签（连带删除 userData 模板目录） */
    delete: (params: unknown) => Promise<unknown>;
    /** 读取技能模板内容（source=builtin：fileName 白名单+覆写优先；source=custom：slug 回显，未写过模板返回空） */
    readTemplate: (params: unknown) => Promise<{ success: boolean; content?: string; error?: string }>;
    /** 保存内置技能模板覆写（content=null 恢复默认并删除覆写文件；fileName 白名单校验在主进程） */
    saveBuiltinOverride: (params: unknown) => Promise<{ success: boolean; error?: string }>;
  };
  /**
   * 渲染端日志转发（R3 修复配套）：渲染→主 invoke，主进程 writeMainLog 写入
   * userData/logs/main.log 持久日志。渲染端上传失败等异常经此通道落 ERROR 记录，
   * 不再止于打包版不可见的 console.error。旧版 preload 未暴露时调用方以 ?. 防御。
   */
  log: {
    write: (params: {
      level: 'INFO' | 'WARN' | 'ERROR';
      stage: string;
      message: string;
      err?: { message: string; stack?: string };
    }) => Promise<void>;
  };
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
