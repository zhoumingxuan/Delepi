/**
 * Preload 脚本 - contextBridge 安全暴露 API
 *
 * Phase 3 P0 适配层：
 * - electronAPI.executor.onSnapshot(callback)：订阅子智能体六字段信号（已由主进程推送，v2.1 M1/D2 收敛）
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHAT, IPC_CONFIG, IPC_CONV, IPC_EXECUTOR, IPC_FILE, IPC_PYTHON, IPC_DIALOG, IPC_SKILLS, IPC_TOOLS, IPC_LOG } from '@shared/ipc-channels';
import { GET_LAST_ACTIVE_CONVERSATION } from '@shared/last-active-conversation';

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
    /** 轻量快照查询：仅返回该对话正在运行的任务快照（三元组数组：toolCallId/message/toolCalls），不拉历史 messages */
    getRunningSnapshots: (id: string) => ipcRenderer.invoke(IPC_CONV.GET_RUNNING_SNAPSHOTS, id),
    /**
     * v2恢复方案：获取上次活跃的对话ID
     * 主进程内存维护，重启后返回 null → 场景C退化
     */
    getRestoreConversationId: () => ipcRenderer.invoke(GET_LAST_ACTIVE_CONVERSATION),
    /** 方向3：重命名对话（主进程先安全关闭在途标题生成再写入；返回带 tags 的会话摘要） */
    rename: (params: { id: string; title: string }) =>
      ipcRenderer.invoke(IPC_CONV.RENAME, params),
    /** 方向3：移除对话标签；返回最新 tags */
    removeTag: (params: { id: string; tag: string }) =>
      ipcRenderer.invoke(IPC_CONV.TAG_REMOVE, params),
  },
  config: {
    get: () => ipcRenderer.invoke(IPC_CONFIG.GET),
    save: (params: unknown) => ipcRenderer.invoke(IPC_CONFIG.SAVE, params),
    reload: () => ipcRenderer.invoke(IPC_CONFIG.RELOAD),
    /** 列出全部模型档案与当前激活档案 id */
    listProfiles: () => ipcRenderer.invoke(IPC_CONFIG.PROFILES_LIST),
    /** 另存为模型档案：主进程把当前生效配置（九键+开关/档位）快照为新档案，同名覆盖 */
    saveProfile: (params: { name: string }) => ipcRenderer.invoke(IPC_CONFIG.PROFILES_SAVE, params),
    /** 删除模型档案；删除当前激活档案时仅清空 activeProfileId，九键保持现状 */
    deleteProfile: (params: { id: string }) => ipcRenderer.invoke(IPC_CONFIG.PROFILES_DELETE, params),
    /** 切换模型档案：主进程批量写九键+开关/档位（部分失败不回滚），成功后写 activeProfileId */
    switchProfile: (params: { id: string }) => ipcRenderer.invoke(IPC_CONFIG.PROFILES_SWITCH, params),
  },
  skills: {
    /** 列出内置8标签（只读）与自定义标签元数据+上限 */
    list: () => ipcRenderer.invoke(IPC_SKILLS.LIST),
    /** 新建/编辑自定义技能标签与模板（originalName=编辑时的原标签名；新建不传） */
    save: (params: unknown) => ipcRenderer.invoke(IPC_SKILLS.SAVE, params),
    /** 删除自定义技能标签（连带删除 userData 模板目录） */
    delete: (params: { name: string }) => ipcRenderer.invoke(IPC_SKILLS.DELETE, params),
    /** 读取技能模板内容（source=builtin：fileName 白名单+覆写优先回显；source=custom：slug 回显，未写过模板返回空） */
    readTemplate: (params: unknown) => ipcRenderer.invoke(IPC_SKILLS.READ_TEMPLATE, params),
    /** 保存内置技能模板覆写（content=null 恢复默认内容并删除覆写文件） */
    saveBuiltinOverride: (params: unknown) => ipcRenderer.invoke(IPC_SKILLS.SAVE_BUILTIN_OVERRIDE, params),
  },
  tools: {
    /** 重载动态工具：先注销全部动态注册再重扫 userData/dyn-tools 目录（内置3工具锁定不受影响） */
    dynReload: () => ipcRenderer.invoke(IPC_TOOLS.DYN_RELOAD),
    /** 列出当前已注册动态工具（name/displayName/description/progressName/timeoutSeconds） */
    dynList: () => ipcRenderer.invoke(IPC_TOOLS.DYN_LIST),
  },
  file: {
    open: (target: string) => ipcRenderer.invoke(IPC_FILE.OPEN, target),
    /**
     * 上传单个文件到对话 uploads 目录（主进程落盘）
     * P5 文件上传独立 IPC 通道，对齐 E:\ai_fr app/api/uploads/route.ts POST
     * H1 防御：data 为 Base64 字符串（主进程兼容 ArrayBuffer/Uint8Array/number[] 旧格式）
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
  },
  python: {
    download: () => ipcRenderer.invoke(IPC_PYTHON.DOWNLOAD),
    selectCustom: () => ipcRenderer.invoke(IPC_PYTHON.SELECT_CUSTOM),
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
  log: {
    /**
     * 渲染端日志转发（渲染→主，invoke）：主进程 writeMainLog 写入 userData/logs/main.log
     * R3 修复配套：渲染端上传失败等异常经此通道落 ERROR 记录（含 err.message/stack）
     * @param params { level, stage, message, err? }
     */
    write: (params: {
      level: 'INFO' | 'WARN' | 'ERROR';
      stage: string;
      message: string;
      err?: { message: string; stack?: string };
    }) => ipcRenderer.invoke(IPC_LOG.RENDERER, params),
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
