/**
 * IPC 处理器注册
 * 实现核心 IPC 通道：chat:send、chat:abort
 *
 * 事件流（v1.2）：
 * MainAgent 事件 → EventBus → IPC → 前端
 * ExecutorAgent 事件 → EventBus → IPC（executor 三通道）→ 前端
 */

import { ipcMain, BrowserWindow, dialog, shell } from 'electron';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_CHAT, IPC_CONFIG, IPC_CONV, IPC_EXECUTOR, IPC_FILE, IPC_PYTHON, IPC_DEPS, IPC_DIALOG } from '@shared/ipc-channels';
import { GET_LAST_ACTIVE_CONVERSATION } from '@shared/last-active-conversation';
import type {
  ChatSendFileInput,
  ChatSendParams,
  ChatSendResult,
  ChatUploadedFile,
  ConversationListItem,
  ConfigSaveParams,
  FileCleanupOrphansParams,
  FileCleanupOrphansResult,
  FileDeleteParams,
  FileDeleteResult,
  FileListParams,
  FileListResult,
  FileReadParams,
  FileReadResult,
  FileUploadParams,
  FileUploadResult,
} from '../types/ipc';
import type { AppSettings } from '../types/config';
import type { ConfigGetResult } from '@shared/types/config';
import type { StreamMessage } from '@shared/types/chat';
import type { DepsInstallParams, DepsExportResult, DepsImportResult } from '@shared/types/deps';
import { eventBus } from '../modules/event-bus/event-bus';
import { getRunningAssistantMessage } from '../modules/main-agent/running-assistant-message-map';
import { runMainAgent } from '../modules/main-agent/main-agent';
import { configManager } from '../modules/config/config-manager';
import { pythonManager, depsManager, type PythonStatus, type SystemPythonInfo } from '../modules/python';
import {
  createConversation as createConversationRecord,
  deleteConversation as deleteConversationRecord,
  ensureConversation,
  getConversationById,
  listConversations,
  listRendererMessages,
  saveSetting,
  setConversationRunning,
} from '../db';
import { v4 as uuidv4 } from 'uuid';
import { resolveConversationDir } from '../utils/storage-paths';
import {
  ERR_CONVERSATION_RUNNING,
  ERR_ABORTED,
  MAIN_AGENT_CHUNK_EVENT,
  MAIN_AGENT_THINKING_EVENT,
  MAIN_AGENT_TOOL_CALL_EVENT,
  MAIN_AGENT_TOOL_RESULT_EVENT,
  MAIN_AGENT_DONE_EVENT,
  MAIN_AGENT_TITLE_EVENT,
  MAIN_AGENT_ERROR_EVENT,
  MAIN_AGENT_ABORTED_EVENT,
  ASSISTANT_MESSAGE_STARTED_EVENT,
  USER_MESSAGE_CREATED_EVENT,
  ASSISTANT_MESSAGE_DONE_EVENT,
  TOOL_MESSAGE_CREATED_EVENT,
  TOOL_BATCH_COMPLETED_EVENT,
} from '../constants';
import { MAX_UPLOAD_COUNT } from '@shared/constants';
import {
  buildConversationUploadStorageKey,
  isConversationUploadStorageKey,
  normalizeStorageKey,
  resolveConversationUploadDir,
  resolveStoragePath,
  sanitizeFilename,
} from '../utils/storage-paths';
import {
  getFileContentType,
} from '@shared/utils/file-mime';
import {
  removeConversationOutputFiles,
  removeConversationUploadDir,
  removeOrphanConversationUploadDirs,
} from '../utils/uploads';
import {
  beginConversationRun,
  finishConversationRun,
  abortConversationRun,
} from '../modules/chat/conversation-runtime';

let lastActiveConversationId: string | null = null;

function emitConversationUpdated(
  mainWindow: BrowserWindow,
  conversation: ConversationListItem | null | undefined,
): void {
  if (!conversation || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_CONV.UPDATED, { conversation });
}

function resolveLocalOpenPath(target: unknown): string {
  if (typeof target !== 'string' || !target.trim()) {
    throw new Error('文件路径为空');
  }

  const trimmed = target.trim();

  try {
    const url = new URL(trimmed);
    if (url.protocol === 'file:') {
      return fileURLToPath(url);
    }
  } catch {
    // 非 URL 时按本地路径处理。
  }

  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }

  // 兼容相对 storageKey（如 conversations/{id}/uploads/{fileId}.ext）：
  // 乐观插入/历史消息中 attachment.storageKey 可能为相对路径，按存储 key 解析到客户端 bin 目录
  return resolveStoragePath(trimmed);
}

function fileInputToBuffer(file: {
  name?: string;
  data?: ArrayBuffer | Uint8Array | number[];
}): Buffer {
  const data = file.data;

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  if (Array.isArray(data)) {
    return Buffer.from(data);
  }

  throw new Error(`文件 ${file.name || '(未命名)'} 数据无效`);
}

type UploadFileMeta = {
  id: string;
  name: string;
  size: number;
  contentType: string;
  uploadedAt: string;
};

function resolveUploadMetaPath(filePath: string): string {
  return `${filePath}.json`;
}

function parseUploadFileMeta(raw: string): UploadFileMeta | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.size !== 'number' ||
      typeof parsed.contentType !== 'string' ||
      typeof parsed.uploadedAt !== 'string'
    ) {
      return null;
    }

    return {
      id: parsed.id,
      name: parsed.name,
      size: parsed.size,
      contentType: parsed.contentType,
      uploadedAt: parsed.uploadedAt,
    };
  } catch {
    return null;
  }
}

async function readUploadFileMeta(filePath: string): Promise<UploadFileMeta | null> {
  const raw = await readFile(resolveUploadMetaPath(filePath), 'utf8').catch(() => null);
  return raw ? parseUploadFileMeta(raw) : null;
}

function buildUploadFileStoredName(fileId: string, originalName: string): string {
  const extension = path.extname(sanitizeFilename(originalName)).toLowerCase();
  return `${fileId}${extension}`;
}

async function persistUploadedFiles(
  conversationId: string,
  files: ChatSendFileInput[] | undefined,
): Promise<ChatUploadedFile[]> {
  if (!files?.length) {
    return [];
  }

  const uploadedFiles: ChatUploadedFile[] = [];

  for (const file of files) {
    const originalName = file.name || 'untitled';
    const contentType = typeof file.contentType === 'string' && file.contentType.trim()
      ? file.contentType.trim()
      : 'application/octet-stream';

    // chat:send 直接使用已通过 file:upload 落盘的 uploads storageKey 组装元数据（不再前置校验磁盘归属与存在性）。
    // storageKey 经 resolveStoragePath 绝对化后写入 message（与 file:upload 实际落盘路径指向同一文件）
    if (file.storageKey) {
      uploadedFiles.push({
        id: file.id || uuidv4(),
        name: originalName,
        size: typeof file.size === 'number' ? file.size : 0,
        contentType,
        storageKey: resolveStoragePath(file.storageKey),
        uploadedAt: new Date().toISOString(),
      });
      continue;
    }
    throw new Error(`上传文件 ${originalName} 缺少 storageKey`);
  }

  return uploadedFiles;
}

/**
 * 注册所有 IPC 处理器
 */
let eventBusCleanups: (() => void)[] = [];

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  // P1-02: 精确清理上次注册的 EventBus 监听器
  for (const cleanup of eventBusCleanups) {
    cleanup();
  }
  eventBusCleanups = [];
  // ================================================================
  // 聊天处理器
  // ================================================================

  /**
   * chat:send — 发送消息并启动流式对话
   */
  ipcMain.handle(IPC_CHAT.SEND, async (_event, params: ChatSendParams): Promise<ChatSendResult> => {
    const conversationId = params.conversationId;

    // 并发控制（适配 E:\\ai_fr beginConversationRun）：
    //   如果会话正在运行中，拒绝新的 send 请求（返回 CONVERSATION_RUNNING 错误）
    //   E:\\ai_fr 返回 409 状态码；智蜂通过 throw Error 传递错误信息
    // 使用 conversation-runtime 进行并发控制
    const abortController = beginConversationRun(conversationId);
    if (!abortController) {
      throw new Error(ERR_CONVERSATION_RUNNING);
    }

    // 校验主模型 API Key 非空
    const mainModelApiKey = configManager.getSettings().mainModelApiKey;
    if (!mainModelApiKey || mainModelApiKey.trim() === '') {
      throw new Error('主模型 API Key 未配置，请在设置中配置 API Key');
    }

    const messageId = uuidv4();

    // AbortController 已由 beginConversationRun 创建

    try {
      // 确保对话存在
      ensureConversation(conversationId);
      const uploadedFiles = await persistUploadedFiles(conversationId, params.files);

      // 更新对话状态为运行中
      emitConversationUpdated(
        mainWindow,
        setConversationRunning(conversationId, true),
      );

      // 启动主智能体
      const result = await runMainAgent({
        conversationId,
        userMessage: params.message,
        modelConfig: {
          baseUrl: configManager.getSettings().mainModelBaseUrl,
          apiKey: configManager.getSettings().mainModelApiKey,
          model: configManager.getSettings().mainModelName,
        },
        assistantConfig: {
          mainModel: {
            baseUrl: configManager.getSettings().mainModelBaseUrl,
            apiKey: configManager.getSettings().mainModelApiKey,
            model: configManager.getSettings().mainModelName,
          },
          executorModel: {
            baseUrl: configManager.getSettings().executorModelBaseUrl,
            apiKey: configManager.getSettings().executorModelApiKey,
            model: configManager.getSettings().executorModelName,
          },
        },
        visionModelConfig: {
          baseUrl: configManager.getSettings().visionLlmBaseUrl,
          apiKey: configManager.getSettings().visionLlmApiKey,
          model: configManager.getSettings().visionLlmModel,
        },
        // 视觉识别总开关联动：visionEnabled=false 时主智能体多模态强制关闭（multimodalEnabled = visionEnabled && mainModelMultimodal）
        mainAgentMultimodalEnabled: configManager.getSettings().visionEnabled
          && configManager.getSettings().mainModelMultimodal,
        assistantMessageId: params.assistantMessageId,
        uploadedFiles,
        signal: abortController.signal,
      });

      return {
        messageId: result.messageId,
        conversationId,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);

      if (errMsg === ERR_ABORTED) {
        return {
          messageId,
          conversationId,
        };
      }

      throw error;
    } finally {
      finishConversationRun(conversationId);
      emitConversationUpdated(
        mainWindow,
        setConversationRunning(conversationId, false),
      );
    }
  });

  /**
   * chat:abort — 中止当前对话
   */
  ipcMain.on(IPC_CHAT.ABORT, (_event, conversationId: string) => {
    abortConversationRun(conversationId);

    // 更新对话状态
    emitConversationUpdated(
      mainWindow,
      setConversationRunning(conversationId, false),
    );

    // ★ P0-E3：emit main-agent:aborted 事件（统一在 IPC 转发段中转给前端 chat:aborted）
    // 对齐 E:\ai_fr chat.aborted 事件：触发前端 markRunningMessagesAborted + markRunningToolSnapshotsAborted
    eventBus.emit(MAIN_AGENT_ABORTED_EVENT, { conversationId });
  });

  // ================================================================
  // EventBus → IPC 事件转发（MainAgent 白名单事件）
  // ================================================================

  // main-agent:chunk → IPC chat:chunk
  eventBusCleanups.push(eventBus.on(MAIN_AGENT_CHUNK_EVENT, (payload) => {
    mainWindow.webContents.send(IPC_CHAT.CHUNK, payload);
  }));

  // main-agent:thinking → IPC chat:thinking
  eventBusCleanups.push(eventBus.on(MAIN_AGENT_THINKING_EVENT, (payload) => {
    mainWindow.webContents.send(IPC_CHAT.THINKING, payload);
  }));

  // main-agent:tool-call → IPC chat:tool-call
  eventBusCleanups.push(eventBus.on(MAIN_AGENT_TOOL_CALL_EVENT, (payload) => {
    mainWindow.webContents.send(IPC_CHAT.TOOL_CALL, payload);
  }));

  // main-agent:tool-result → IPC chat:tool-result
  eventBusCleanups.push(eventBus.on(MAIN_AGENT_TOOL_RESULT_EVENT, (payload) => {
    mainWindow.webContents.send(IPC_CHAT.TOOL_RESULT, payload);
  }));

  // main-agent:done → IPC chat:done
  eventBusCleanups.push(eventBus.on(MAIN_AGENT_DONE_EVENT, (payload) => {
    mainWindow.webContents.send(IPC_CHAT.DONE, payload);
  }));

  // main-agent:title → IPC chat:title（首轮标题生成完成后推送）
  eventBusCleanups.push(eventBus.on(MAIN_AGENT_TITLE_EVENT, (payload) => {
    mainWindow.webContents.send(IPC_CHAT.TITLE, payload);
  }));

  // main-agent:error → IPC chat:error
  eventBusCleanups.push(eventBus.on(MAIN_AGENT_ERROR_EVENT, (payload) => {
    mainWindow.webContents.send(IPC_CHAT.ERROR, payload);
  }));

  // ★ P0-E3：main-agent:aborted → IPC chat:aborted
  // 对齐 E:\ai_fr chat.aborted 事件，前端 useChat 的 unsubAborted 监听器负责归一化 abort 状态
  eventBusCleanups.push(eventBus.on(MAIN_AGENT_ABORTED_EVENT, (payload) => {
    mainWindow.webContents.send(IPC_CHAT.ABORTED, payload);
  }));

  // ★ P6 历史消息附件回显：user.message.created → IPC chat:user-message-created
  //   main-agent.ts 在 insertMessage(user) 后 emit,前端 useChat 收到后替换本地乐观 user 消息
  //   payload 含 conversationId + message{id, role, content, attachments, createdAt}
  eventBusCleanups.push(eventBus.on(USER_MESSAGE_CREATED_EVENT, (payload) => {
    mainWindow.webContents.send(IPC_CHAT.USER_MESSAGE_CREATED, payload);
  }));

  eventBusCleanups.push(eventBus.on(ASSISTANT_MESSAGE_STARTED_EVENT, (payload) => {
    mainWindow.webContents.send(IPC_CHAT.ASSISTANT_STARTED, payload);
  }));

  eventBusCleanups.push(eventBus.on(ASSISTANT_MESSAGE_DONE_EVENT, (payload) => {
    mainWindow.webContents.send(IPC_CHAT.ASSISTANT_DONE, payload);
  }));

  eventBusCleanups.push(eventBus.on(TOOL_MESSAGE_CREATED_EVENT, (payload) => {
    mainWindow.webContents.send(IPC_CHAT.TOOL_MESSAGE_CREATED, payload);
  }));

  // ★ S3（M4）：tool.batch.completed → IPC tool.batch.completed
  //   main-agent.ts 批次收口块在全中止判定之前 emit（含全中止批次），
  //   前端 useChat 按 isError 收口 running 快照（对齐 ai_fr route.ts:973-977 → chat-shell.tsx:2093-2099）
  eventBusCleanups.push(eventBus.on(TOOL_BATCH_COMPLETED_EVENT, (payload) => {
    mainWindow.webContents.send(IPC_CHAT.TOOL_BATCH_COMPLETED, payload);
  }));

  // executor:thinking → IPC executor:thinking（执行子智能体思考过程和工具调用进度）
  eventBusCleanups.push(eventBus.on('executor:thinking', (data) => {
    mainWindow.webContents.send(IPC_EXECUTOR.THINKING, data);
  }));

  // ★ 修复主/子智能体消息混淆：executor:tool-progress → IPC executor:tool-progress
  //   后端 main-agent.ts onToolCall / onToolResult 回调 emit 此事件
  //   前端 useChat.ts 订阅后按 taskId/taskName 聚合到 toolSnapshots 状态
  //   payload 含 source='executor' / taskName / 子智能体工具真实 callId
  eventBusCleanups.push(eventBus.on('executor:tool-progress', (data) => {
    mainWindow.webContents.send(IPC_EXECUTOR.TOOL_PROGRESS, data);
  }));

  eventBusCleanups.push(eventBus.on('executor:snapshot', (data) => {
    mainWindow.webContents.send(IPC_EXECUTOR.SNAPSHOT, data);
  }));

  // ================================================================
  // 配置处理器
  // ================================================================

  ipcMain.handle(IPC_CONFIG.GET, async (): Promise<ConfigGetResult> => {
    const settings = { ...configManager.getSettings() };
    return {
      configured: configManager.isConfigured(),
      model: settings.mainModelName,
      baseUrl: settings.mainModelBaseUrl,
      settings,
    };
  });

  ipcMain.handle(IPC_CONFIG.SAVE, async (_event, params: ConfigSaveParams): Promise<void> => {
    saveSetting(params.key, params.value);

    // 同步到 configManager
    const appSettings = configManager.getSettings();
    if (params.key in appSettings) {
      configManager.setSetting(
        params.key as keyof AppSettings,
        params.value as AppSettings[keyof AppSettings],
      );
    }
  });

  ipcMain.handle(IPC_CONFIG.RELOAD, async (): Promise<void> => {
    configManager.reload();
  });

  // ================================================================
  // 对话管理处理器
  // ================================================================

  ipcMain.handle(IPC_CONV.LIST, async (): Promise<ConversationListItem[]> => {
    return listConversations();
  });

  ipcMain.handle(IPC_CONV.CREATE, async (): Promise<ConversationListItem> => {
    return createConversationRecord();
  });

  ipcMain.handle(IPC_CONV.DELETE, async (_event, id: string): Promise<void> => {
    // 删会话时同步清理会话目录和输出文件
    //   - 先删 SQLite 记录(deleteConversationRecord)
    //   - 再删磁盘文件(removeConversationUploadDir + removeConversationOutputFiles)
    deleteConversationRecord(id);
    if (lastActiveConversationId === id) {
      lastActiveConversationId = null;
    }
    await removeConversationUploadDir(id).catch(() => undefined);
    await removeConversationOutputFiles(id).catch(() => undefined);
  });
  ipcMain.handle(GET_LAST_ACTIVE_CONVERSATION, async () => lastActiveConversationId);

type SnapshotFile = {
  thinking: string;
  toolCall: { toolCallId: string; name: string; arguments: string };
  createdAt: string;
  status: 'init' | 'running' | 'finished';
  finishedAt?: string;
  snapshot: StreamMessage;
};

function isSnapshotMessage(value: unknown): value is StreamMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const message = value as Partial<StreamMessage>;

  return (
    typeof message.id === 'string' &&
    typeof message.conversationId === 'string' &&
    message.role === 'tool' &&
    !!message.payload &&
    typeof message.payload === 'object'
  );
}

/**
 * 旧三字段快照兼容：无 snapshot 字段的旧文件构造最小 StreamMessage
 * 返回 null 表示无法构造（跳过）
 */
function tryBuildLegacySnapshotMessage(
  data: Partial<SnapshotFile>,
  conversationId: string,
): StreamMessage | null {
  if (!data.toolCall || typeof data.toolCall.toolCallId !== 'string') {
    return null;
  }
  const derivedStatus: 'init' | 'running' | 'finished' = data.finishedAt
    ? 'finished'
    : data.thinking && data.thinking.trim()
      ? 'running'
      : 'init';
  return {
    id: `snapshot-${data.toolCall.toolCallId}`,
    conversationId,
    role: 'tool',
    payload: {
      toolCallId: data.toolCall.toolCallId,
      name: data.toolCall.name,
      arguments: data.toolCall.arguments,
      result: '',
      thinking: data.thinking ?? '',
      startedAt: data.createdAt,
      ...(data.finishedAt ? { finishedAt: data.finishedAt } : {}),
    },
    status: derivedStatus === 'finished' ? 'success' : 'loading',
    createdAt: data.createdAt,
  };
}

async function loadSnapshotMessages(
  conversationId: string,
  existingToolCallIds: Set<string>,
): Promise<Array<{ toolCallId: string; message: StreamMessage }>> {
  try {
    const tasksDir = path.join(resolveConversationDir(conversationId), 'tasks');
    const entries = await readdir(tasksDir, { withFileTypes: true });
    const result: Array<{ toolCallId: string; message: StreamMessage }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = await readFile(
          path.join(tasksDir, entry.name, 'snapshot.json'),
          'utf-8',
        );
        const data = JSON.parse(raw) as Partial<SnapshotFile>;
        if (isSnapshotMessage(data.snapshot)) {
          // 去重键=快照内容中的 toolCallId（新目录名=toolCall.id；旧 taskId 命名目录靠内容提取兼容，对齐 ai_fr :103-108）
          const snapshotToolCallId = data.snapshot.payload.toolCallId;
          if (snapshotToolCallId && existingToolCallIds.has(snapshotToolCallId)) continue;
          result.push({ toolCallId: snapshotToolCallId || entry.name, message: data.snapshot });
        } else {
          // 旧三字段兼容（见规划书第 5 章）：构造最小快照消息，不再以假任务形态合并
          const legacy = tryBuildLegacySnapshotMessage(data, conversationId);
          if (legacy) {
            if (existingToolCallIds.has(legacy.payload.toolCallId)) continue;
            result.push({ toolCallId: legacy.payload.toolCallId, message: legacy });
          }
        }
      } catch { /* 损坏跳过 */ }
    }
    return result;
  } catch { return []; }
}

  /**
   * conv:get-messages — 获取对话的历史消息列表
   * 读取 messages 表，按 seq 升序排列，反序列化 payload_json 为 ChatMessage 数组
   * ★ P1-C3：若存在 runningAssistantMessages 中正在流式累积的 assistant 消息
   *   且该消息尚未入库（id 不在已读 rows 中），则附加到返回列表末尾
   *   确保前端 conv:get-messages 在流式过程中也能拉到正在累积的 assistant 消息
   */
  ipcMain.handle(IPC_CONV.GET_MESSAGES, async (_event, conversationId: string) => {
    const list = listRendererMessages(conversationId);
    const persistedIds = new Set(list.map((message) => message.id));

    // ★ P1-C3：附加正在流式累积的 assistant 消息
    const runningMsg = getRunningAssistantMessage(conversationId);
    if (runningMsg && !persistedIds.has(runningMsg.id)) {
      list.push(runningMsg as unknown as typeof list[number]);
    }

    // ★ S4（M5）恢复单源收敛（对齐 ai_fr [id]/route.ts:100-118）：
    //   已完成委派任务结果由 messages（tool 角色 payload 自足）承载，过渡态由 snapshot.json 承载，
    //   去重键=已持久化 tool 消息的 callId（=快照 payload.toolCallId）。
    const existingToolCallIds = new Set(
      list
        .filter((message) => message.role === 'tool')
        .map((message) => message.toolCall?.callId)
        .filter((v): v is string => typeof v === 'string' && !!v),
    );
    // 仅当会话运行中（is_running=true）才加载快照消息；is_running=false 时永不读取 tasks/*/snapshot.json
    const conversation = getConversationById(conversationId);
    const snapshotMessages = conversation?.isRunning
      ? await loadSnapshotMessages(conversationId, existingToolCallIds)
      : [];

    return {
      messages: list,
      snapshotMessages: snapshotMessages.map((item) => item.message),
    };
  });

  // ================================================================
  // 本地文件处理器
  // ================================================================

  ipcMain.handle(IPC_FILE.OPEN, async (_event, target: unknown): Promise<void> => {
    const localPath = resolveLocalOpenPath(target);
    const errorMessage = await shell.openPath(localPath);

    if (errorMessage) {
      throw new Error(errorMessage);
    }
  });

  // ===============================================================
  // P5 文件上传独立 IPC 通道
  // 对齐 E:\ai_fr app/api/uploads/route.ts 三件套（去除鉴权层）
  // ===============================================================

  /**
   * file:upload — 落盘单个文件到 conversations/{id}/uploads/{fileId}.ext
   * 原始展示名写入同名 .json 元数据，storageKey 不再携带用户上传文件名。
   * 文件数限制：基于现有 uploads/ 有效 meta 条目数 +1 不超过 MAX_UPLOAD_COUNT=10
   */
  ipcMain.handle(IPC_FILE.UPLOAD, async (_event, params: FileUploadParams): Promise<FileUploadResult> => {
    const conversationId = params.conversationId;
    const originalName = params.name || '';

    // 客户端上传直接写入当前会话 uploads/ 目录
    const uploadDir = resolveConversationUploadDir(conversationId);
    await mkdir(uploadDir, { recursive: true });

    // 文件数限制（基于 uploads/ 现有有效 meta 条目，与 file:list 同口径）
    const entries = await readdir(uploadDir).catch(() => [] as string[]);
    let existingFileCount = 0;
    for (const entryName of entries) {
      if (await readUploadFileMeta(path.join(uploadDir, entryName))) {
        existingFileCount += 1;
      }
    }
    if (existingFileCount >= MAX_UPLOAD_COUNT) {
      throw new Error(`最多上传 ${MAX_UPLOAD_COUNT} 个文件。`);
    }

    const fileId = uuidv4();
    const uploadedAt = new Date().toISOString();

    // 先转 buffer；客户端上传按原始文件内容落盘，不做图片压缩。
    const rawBuffer = fileInputToBuffer({
      name: originalName,
      data: params.data,
    });

    const declaredContentType =
      typeof params.contentType === 'string' && params.contentType.trim()
        ? params.contentType.trim()
        : '';
    const detectedContentType = getFileContentType(originalName, rawBuffer);
    const finalContentType = declaredContentType || detectedContentType;
    const storedName = buildUploadFileStoredName(fileId, originalName);
    const targetPath = path.join(uploadDir, storedName);

    await writeFile(targetPath, rawBuffer, { flag: 'wx' });
    await writeFile(
      resolveUploadMetaPath(targetPath),
      JSON.stringify({
        id: fileId,
        name: originalName,
        size: rawBuffer.byteLength,
        contentType: finalContentType,
        uploadedAt,
      } satisfies UploadFileMeta, null, 2),
      'utf8',
    );

    return {
      file: {
        id: fileId,
        name: originalName,
        size: rawBuffer.byteLength,
        contentType: finalContentType,
        storageKey: buildConversationUploadStorageKey(conversationId, storedName),
        uploadedAt,
      },
    };
  });

  /**
   * file:list — 扫描 conversations/{id}/uploads/ 目录，返回 ChatUploadedFile 列表
   *   - meta 文件与无有效 .json 元数据的孤儿文件自动跳过
   *   - 读取同名 .json 元数据作为展示名/MIME/id 来源
   *   - size 取 stat.size，uploadedAt 取 stat.mtime ISO
   */
  ipcMain.handle(IPC_FILE.LIST, async (_event, params: FileListParams): Promise<FileListResult> => {
    const conversationId = params.conversationId;

    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      throw new Error('缺少 conversationId。');
    }

    // 扫描当前会话 uploads/ 目录
    const uploadDir = resolveConversationUploadDir(conversationId);
    const entries = await readdir(uploadDir).catch(() => [] as string[]);
    const fileEntries = entries;

    const files: ChatUploadedFile[] = [];
    for (const entryName of fileEntries) {
      const filePath = path.join(uploadDir, entryName);
      const statResult = await stat(filePath).catch(() => null);
      if (!statResult || !statResult.isFile()) continue;
      const meta = await readUploadFileMeta(filePath);
      if (!meta) continue;

      files.push({
        id: meta.id,
        name: meta.name,
        size: statResult.size,
        contentType: meta.contentType,
        storageKey: buildConversationUploadStorageKey(conversationId, entryName),
        uploadedAt: meta.uploadedAt || statResult.mtime.toISOString(),
      });
    }

    // 按 uploadedAt 升序，与 ai_fr readTmpFileManifests 排序行为一致
    files.sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));

    return { files };
  });

  /**
   * file:delete — 删除 conversations/{id}/uploads/ 下单个文件
   * 校验 storageKey 前缀属于当前 conversationId 的 uploads/（防越权）
   * 同时清理 manifest 兜底文件（若存在）
   */
  ipcMain.handle(IPC_FILE.DELETE, async (_event, params: FileDeleteParams): Promise<FileDeleteResult> => {
    const conversationId = params.conversationId;
    const storageKey = params.storageKey;

    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      throw new Error('缺少必要参数');
    }
    if (typeof storageKey !== 'string' || storageKey.length === 0) {
      throw new Error('缺少必要参数');
    }

    // 校验 storageKey 前缀属于当前会话 uploads/
    const normalizedKey = normalizeStorageKey(storageKey);
    if (!isConversationUploadStorageKey(conversationId, normalizedKey)) {
      throw new Error('附件路径非法。');
    }

    const filePath = resolveStoragePath(normalizedKey);
    const metaPath = `${filePath}.json`;

    await Promise.all([
      rm(filePath, { force: true }),
      rm(metaPath, { force: true }),
    ]);

    return { success: true };
  });

  /**
   * file:read — 读取已上传文件的二进制内容(P7 切换会话恢复待发送文件)
   * 校验 storageKey 前缀属于当前 conversationId 的 uploads/(防越权)
   * 返回 ArrayBuffer + contentType + name + size,前端用 URL.createObjectURL(new Blob) 重建预览
   * 适配 Delepi 客户端:无 static token 鉴权,直接 IPC 读取已上传文件
   * 对齐 E:\ai_fr createRemoteUploadedFile (HTTP blob fetch → ObjectURL)
   */
  ipcMain.handle(IPC_FILE.READ, async (_event, params: FileReadParams): Promise<FileReadResult> => {
    const conversationId = params.conversationId;
    const storageKey = params.storageKey;

    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      throw new Error('缺少 conversationId。');
    }
    if (typeof storageKey !== 'string' || storageKey.length === 0) {
      throw new Error('缺少 storageKey。');
    }

    // 校验 storageKey 前缀属于当前会话 uploads/
    const normalizedKey = normalizeStorageKey(storageKey);
    if (!isConversationUploadStorageKey(conversationId, normalizedKey)) {
      throw new Error('附件路径非法。');
    }

    const filePath = resolveStoragePath(normalizedKey);
    const statResult = await stat(filePath).catch(() => null);
    if (!statResult || !statResult.isFile()) {
      throw new Error(`文件不存在: ${storageKey}`);
    }
    const meta = await readUploadFileMeta(filePath);
    if (!meta) {
      throw new Error(`文件元数据不存在: ${storageKey}`);
    }

    const buffer = await readFile(filePath);

    // ★ Phase 3 P3-3 后端基于 getFileContentType (扩展名 + magic number 探测) 推断 contentType
    // 前端可直接使用 readResult.contentType 作为 Blob type,不再依赖 file:list 二次关联
    return {
      data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      contentType: meta.contentType,
      name: meta.name,
      size: buffer.byteLength,
    };
  });

  /**
   * file:cleanup-orphans — P9 手动触发孤儿清理
   * 扫描 bin/conversations/ 目录,与 SQLite conversations 表比对
   * 删除 SQLite 中无引用的会话目录(含 uploads/ + tasks/ + manifest.json)
   */
  ipcMain.handle(
    IPC_FILE.CLEANUP_ORPHANS,
    async (_event, _params: FileCleanupOrphansParams): Promise<FileCleanupOrphansResult> => {
      // 读取 SQLite 当前所有 conversationId
      const existingConversations = listConversations();
      const existingIds = existingConversations.map((c) => c.id);

      const removedConversationIds = await removeOrphanConversationUploadDirs(existingIds);

      return {
        removedConversationIds,
        scannedCount: existingIds.length,
        removedCount: removedConversationIds.length,
      };
    },
  );

  // ================================================================
  // Python 环境处理器
  // ================================================================
  ipcMain.handle(IPC_PYTHON.GET_STATUS, async (): Promise<PythonStatus> => {
    return pythonManager.getStatus();
  });

  ipcMain.handle(IPC_PYTHON.DETECT_SYSTEM, async (): Promise<SystemPythonInfo> => {
    return await pythonManager.detectSystemPython();
  });

  ipcMain.handle(IPC_PYTHON.SELECT_CUSTOM, async (): Promise<SystemPythonInfo> => {
    return await pythonManager.selectCustomPythonPath();
  });

  ipcMain.handle(IPC_PYTHON.DOWNLOAD, async (): Promise<void> => {
    await pythonManager.downloadBuiltinPython();
  });

  ipcMain.handle(IPC_PYTHON.CANCEL, async (): Promise<{ success: boolean }> => {
    pythonManager.cancel();
    return { success: true };
  });

  // ================================================================
  // 依赖管理处理器
  // ================================================================
  ipcMain.handle(IPC_DEPS.INSTALL, async (_event, params: DepsInstallParams) => {
    try {
      const packages = await depsManager.installPackages(params);
      return { success: true, packages };
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) };
    }
  });

  ipcMain.handle(IPC_DEPS.CANCEL, async () => {
    try {
      await depsManager.cancelInstall();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) };
    }
  });

  ipcMain.handle(IPC_DEPS.EXPORT, async (_event, destPath?: string) => {
    try {
      const result = await depsManager.exportBundle(destPath);
      return result;
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) };
    }
  });

  ipcMain.handle(IPC_DEPS.IMPORT, async (_event, bundlePath: string) => {
    try {
      const result = await depsManager.importBundle(bundlePath);
      return result;
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) };
    }
  });
    ipcMain.handle(IPC_DEPS.GET_INSTALLED, async () => {
    try {
      const packages = depsManager.getInstalledPackages();
      return { success: true, packages };
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) };
    }
  });

  ipcMain.handle(IPC_DEPS.SELECT_EXPORT_PATH, async () => {
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win || win.isDestroyed()) {
        return { success: false, error: '无可用窗口' };
      }
      const result = await dialog.showSaveDialog(win, {
        title: '导出依赖包',
        defaultPath: 'deps-bundle.zip',
        filters: [
          { name: 'ZIP 文件', extensions: ['zip'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) {
        return { success: true, filePath: null };
      }
      return { success: true, filePath: result.filePath };
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) };
    }
  });

  ipcMain.handle(IPC_DEPS.GET_PACKAGES, async () => {
    try {
      const packages = depsManager.getInstalledPackages();
      if (!packages || packages.length === 0) {
        return [];
      }

      const pythonPath = pythonManager.getPythonPath();
      const result: { name: string; version: string; size: number }[] = [];
      for (const pkg of packages) {
        let size = -1;
        try {
          size = await (depsManager as any)._getPackageSize(pythonPath, pkg.name);
        } catch {
          // size remains -1
        }
        result.push({
          name: pkg.name,
          version: pkg.version ?? '',
          size,
        });
      }
      return result;
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC_DEPS.REFRESH, async () => {
    try {
      const changed = await depsManager.refreshInstalledPackages();
      return { changed };
    } catch (error: any) {
      return { changed: false, error: error?.message ?? String(error) };
    }
  });


  // 解析导入文件（.txt / .zip），返回解析出的依赖包列表
  ipcMain.handle(IPC_DEPS.PARSE_IMPORT_FILE, async (_event, filePath: string) => {
    return depsManager.parseImportFile(filePath);
  });

  // 文件选择对话框
  ipcMain.handle(IPC_DIALOG.SHOW_OPEN, async (_event, options: Electron.OpenDialogOptions) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) {
      return { canceled: true, filePaths: [] };
    }
    return dialog.showOpenDialog(win, options);
  });

console.log('[IPC] All handlers registered.');
}
