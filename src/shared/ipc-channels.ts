/**
 * 跨进程共享的 IPC 通道常量定义
 * 所有主进程 ↔ 渲染进程通信通道的统一管理
 * 主进程、preload 和渲染进程均从此文件导入
 */

// --- 聊天相关 IPC 通道 ---
export const IPC_CHAT = {
  /** 发送消息并启动流式对话 */
  SEND: 'chat:send',
  /** 中止当前对话 */
  ABORT: 'chat:abort',
  /** 思考内容推送（主→渲染） */
  THINKING: 'chat:thinking',
  /** 流式 chunk 推送（主→渲染） */
  CHUNK: 'chat:chunk',
  /** 工具调用通知（主→渲染） */
  TOOL_CALL: 'chat:tool-call',
  /** 工具调用结果（主→渲染） */
  TOOL_RESULT: 'chat:tool-result',
  /** 对话完成通知（主→渲染） */
  DONE: 'chat:done',
  /** 对话标题生成完成通知（主→渲染，首轮触发） */
  TITLE: 'chat:title',
  /** 错误通知（主→渲染） */
  ERROR: 'chat:error',
  /** 上下文压缩通知（主→渲染） */
  COMPRESSION: 'chat:compression',
  /**
   * 用户消息创建事件（主→渲染）
   * 已由主进程真实推送（main-agent.ts 对应 emit → ipc-handlers.ts 白名单转发）
   * 用于 replaceLatestLocalUser 将 status='local' 的本地乐观消息替换为服务端真实消息
   */
  USER_MESSAGE_CREATED: 'chat:user-message-created',
  /**
   * Assistant 消息三态事件（主→渲染）
   * Phase 3 P1-2 适配层：
   * - STARTED: 初始化 assistant message（status='loading'）
   * - DONE: 标记 status='success' 或 'error'
   * 已由主进程真实推送（main-agent.ts 对应 emit → ipc-handlers.ts 白名单转发）
   */
  ASSISTANT_STARTED: 'chat:assistant-started',
  ASSISTANT_DONE: 'chat:assistant-done',
  /** Tool 消息创建事件（主→渲染），对齐 ai_fr tool.message.created */
  TOOL_MESSAGE_CREATED: 'tool.message.created',
  /**
   * 对话被中止事件（主→渲染）
   * 已由主进程真实推送（main-agent.ts 对应 emit → ipc-handlers.ts 白名单转发）
   * 用于 markRunningMessagesAborted + markRunningToolSnapshotsAborted 归一化
   */
  ABORTED: 'chat:aborted',
  /** 批次完成事件（主→渲染），对齐 ai_fr tool.batch.completed */
  TOOL_BATCH_COMPLETED: 'tool.batch.completed',
} as const;

// --- 配置相关 IPC 通道 ---
export const IPC_CONFIG = {
  /** 获取配置 */
  GET: 'config:get',
  /** 保存配置 */
  SAVE: 'config:save',
  /** 重新加载配置 */
  RELOAD: 'config:reload',
  /** 列出全部模型档案与当前激活档案 id（渲染→主，invoke） */
  PROFILES_LIST: 'config:profiles-list',
  /** 另存为模型档案：主进程把当前生效配置快照为新档案，同名覆盖（渲染→主，invoke） */
  PROFILES_SAVE: 'config:profiles-save',
  /** 删除模型档案；删除当前激活档案时仅清空 activeProfileId，九键保持现状（渲染→主，invoke） */
  PROFILES_DELETE: 'config:profiles-delete',
  /** 切换模型档案：批量写九键+开关/档位（部分失败不回滚），成功后写 activeProfileId（渲染→主，invoke） */
  PROFILES_SWITCH: 'config:profiles-switch',
} as const;

// --- 对话管理 IPC 通道 ---
export const IPC_CONV = {
  /** 获取对话列表 */
  LIST: 'conv:list',
  /** 创建对话 */
  CREATE: 'conv:create',
  /** 删除对话 */
  DELETE: 'conv:delete',
  /** 获取对话消息列表 */
  GET_MESSAGES: 'conv:get-messages',
  /** 对话摘要更新推送（主→渲染），用于同步 isRunning/title 等列表态 */
  UPDATED: 'conv:updated',
  /** 重命名对话（渲染→主，invoke）：先安全关闭在途标题生成，再写入自定义标题（不动 updated_at/is_running） */
  RENAME: 'conv:rename',
  /** 移除对话标签（渲染→主，invoke） */
  TAG_REMOVE: 'conv:tag-remove',
} as const;

// --- 执行子智能体 IPC 通道 ---
export const IPC_EXECUTOR = {
  /**
   * 子智能体 thinking / 工具进度推送（主→渲染）
   * 已由主进程真实推送（main-agent.ts 对应 emit → ipc-handlers.ts 白名单转发）
   * 通道定义就绪，前端 listener 占位注册即生效
   */
  THINKING: 'executor:thinking',
  /**
   * 子智能体工具进度推送（主→渲染）
   * ★ 修复主/子智能体消息混淆：后端 main-agent.ts 的 onToolCall / onToolResult 回调 emit 此事件，
   *   前端 useChat.ts 订阅后写入 toolSnapshots 状态（按 taskId/taskName 聚合）
   *   payload 包含：conversationId, taskId, callId（子智能体工具真实 ID）, name, arguments/result,
   *   source='executor', taskName, status='calling'|'completed'|'failed'
   */
  TOOL_PROGRESS: 'executor:tool-progress',
  /**
   * 子智能体执行中间快照推送（主→渲染）
   * 已由主进程真实推送（main-agent.ts 对应 emit → ipc-handlers.ts 白名单转发）
   * 用于 buildConversationDisplayState 恢复 in-flight 任务
   */
  SNAPSHOT: 'executor:snapshot',
} as const;

// --- 本地文件相关 IPC 通道 ---
export const IPC_FILE = {
  /** 使用系统默认应用打开本地文件或目录 */
  OPEN: 'file:open',
  /**
   * 上传单个文件到对话 uploads 目录（主进程落盘）
   * 参数 FileUploadParams：{ conversationId, name, size, contentType, data: ArrayBuffer }
   * 返回 FileUploadResult：{ file: ChatUploadedFile }
   * 对齐 E:\ai_fr app/api/uploads/route.ts POST（去除鉴权层）
   * - 校验 conversationId 非空、name 非空、data 非空
   * - 文件数限制 MAX_UPLOAD_COUNT=10（基于 uploads 目录现有文件数 +1）
   * - 落盘 conversations/{conversationId}/uploads/{fileId}-{sanitizedName}.{ext}
   */
  UPLOAD: 'file:upload',
  /**
   * 列出对话 uploads 目录下的所有已上传文件
   * 参数 FileListParams：{ conversationId }
   * 返回 FileListResult：{ files: ChatUploadedFile[] }
   * 对齐 E:\ai_fr app/api/uploads/route.ts GET（仅列清单部分，不含流式回传）
   * - 扫描 conversations/{conversationId}/uploads/ 目录
   * - 过滤 .json manifest 文件，仅返回实际文件条目
   * - 按文件名解析 {fileId}-{name}.{ext}，从 stat 读取 size/mtime
   */
  LIST: 'file:list',
  /**
   * 删除已上传的单个文件（磁盘 + manifest 一并清理）
   * 参数 FileDeleteParams：{ conversationId, storageKey }
   * 返回 FileDeleteResult：{ success: boolean }
   * 对齐 E:\ai_fr app/api/uploads/route.ts DELETE（去除鉴权层）
   * - 校验 storageKey 前缀属于当前 conversationId 的 uploads/（防止越权删除）
   * - rm(filePath, force) + rm(metaPath, force)
   */
  DELETE: 'file:delete',
  /**
   * 读取已上传文件的二进制内容（用于 P7 切换会话时重建 ObjectURL 预览）
   * 参数 FileReadParams：{ conversationId, storageKey }
   * 返回 FileReadResult：{ data: ArrayBuffer, contentType: string, name: string, size: number }
   * 对齐 E:\ai_fr components/chat-shell.tsx createRemoteUploadedFile (HTTP blob fetch)
   * 适配 Delepi 客户端:无 static token 鉴权,直接通过 IPC 读取已上传文件到 ArrayBuffer
   * - 校验 storageKey 前缀属于当前 conversationId 的 uploads/(防越权读取)
   * - 主进程用 readFile 读取磁盘内容,IPC 序列化 ArrayBuffer 回前端
   */
  READ: 'file:read',
  /**
   * P9 孤儿清理（手动触发）
   * 参数 FileCleanupOrphansParams：{}
   * 返回 FileCleanupOrphansResult：{ removedConversationIds, scannedCount, removedCount }
   * - 主进程扫描 bin/conversations/ 目录,与 SQLite conversations 表比对
   * - 删除 SQLite 中无引用的会话目录（含 uploads/ + tasks/ + manifest.json）
   * - 防御性:每个被删目录必须在 bin/conversations/ 内（isPathInsideDir 校验）
   */
  CLEANUP_ORPHANS: 'file:cleanup-orphans',
} as const;


// --- Python 内置环境 IPC 通道 ---
export const IPC_PYTHON = {
  /** 下载/安装 Python（渲染→主，invoke） */
  DOWNLOAD: 'python:download',
  /** 选择自定义 Python 解释器路径（渲染→主，invoke） */
  SELECT_CUSTOM: 'python:select-custom',
} as const;


// --- 自定义技能 IPC 通道（方向2：内置8标签只读锁定，自定义标签/模板管理） ---
export const IPC_SKILLS = {
  /** 列出内置8标签（只读）与自定义标签元数据+上限（渲染→主，invoke） */
  LIST: 'skills:list',
  /** 新建/编辑自定义技能标签与模板（渲染→主，invoke）：写 settings customSkillTags 键 + userData 模板文件，成功后刷新主智能体 skills enum */
  SAVE: 'skills:save',
  /** 删除自定义技能标签（渲染→主，invoke）：连带删除 userData 模板目录，成功后刷新主智能体 skills enum */
  DELETE: 'skills:delete',
  /** 读取技能模板内容（builtin=fileName 白名单+覆写优先；custom=slug 回显，未写过模板返回空；渲染→主，invoke） */
  READ_TEMPLATE: 'skills:read-template',
  /** 保存内置技能模板覆写（content=null 恢复默认并删除覆写文件；渲染→主，invoke） */
  SAVE_BUILTIN_OVERRIDE: 'skills:save-builtin-override',
} as const;

// --- 动态工具 IPC 通道（方向5：userData/dyn-tools 动态注册；内置3工具锁定不受重载影响） ---
export const IPC_TOOLS = {
  /** 重载动态工具：先注销全部动态注册再重扫 dyn-tools 目录（渲染→主，invoke） */
  DYN_RELOAD: 'tools:dyn-reload',
  /** 列出当前已注册动态工具（name/displayName/description/progressName/timeoutSeconds）（渲染→主，invoke） */
  DYN_LIST: 'tools:dyn-list',
} as const;

// --- 对话框 IPC 通道 ---
export const IPC_DIALOG = {
  /** 打开文件选择对话框（渲染→主，invoke） */
  SHOW_OPEN: 'dialog:show-open',
} as const;

/** 所有 IPC 通道的联合类型 */
export type IpcChannel =
  | (typeof IPC_CHAT)[keyof typeof IPC_CHAT]
  | (typeof IPC_CONFIG)[keyof typeof IPC_CONFIG]
  | (typeof IPC_CONV)[keyof typeof IPC_CONV]
  | (typeof IPC_EXECUTOR)[keyof typeof IPC_EXECUTOR]
  | (typeof IPC_FILE)[keyof typeof IPC_FILE]
  | (typeof IPC_PYTHON)[keyof typeof IPC_PYTHON]
  | (typeof IPC_SKILLS)[keyof typeof IPC_SKILLS]
  | (typeof IPC_TOOLS)[keyof typeof IPC_TOOLS]
  | (typeof IPC_DIALOG)[keyof typeof IPC_DIALOG];

