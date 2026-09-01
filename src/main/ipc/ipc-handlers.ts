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
import { IPC_CHAT, IPC_CONFIG, IPC_CONV, IPC_EXECUTOR, IPC_FILE, IPC_PYTHON, IPC_DIALOG, IPC_SKILLS, IPC_TOOLS } from '@shared/ipc-channels';
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
import type { ConfigGetResult, ModelProfile, CustomSkillTag } from '@shared/types/config';
import { eventBus } from '../modules/event-bus/event-bus';
import { getRunningAssistantMessage } from '../modules/main-agent/running-assistant-message-map';
import { clearSnapshotSession, getRunningSnapshotEntries } from '../modules/main-agent/snapshot-session-map';
import { runMainAgent, abortTitleGeneration } from '../modules/main-agent/main-agent';
import { refreshMainTools } from '../modules/main-agent/prompt';
import {
  EXECUTOR_WORKFLOW_TEMPLATES,
  TASK_TAG_WORKFLOW_TEMPLATE_ID,
  deleteBuiltinOverride,
  isValidCustomSkillSlug,
  listCustomSkillTagMeta,
  readBuiltinTemplateContent,
  readCustomSkillTemplateContent,
  removeCustomSkillTemplateDir,
  validateCustomSkillTagInput,
  writeBuiltinOverride,
  writeCustomSkillTemplate,
} from '../modules/executor-agent/executor-workflow-templates';
import { truncateConversationTitle } from '../modules/main-agent/title-generation';
import { configManager } from '../modules/config/config-manager';
import {
  loadDynamicTools,
  reloadDynamicTools,
  listDynamicTools,
  type DynToolsLoadResult,
  type DynToolInfo,
} from '../tools/dyn-tool-loader';
import { pythonManager, type SystemPythonInfo } from '../modules/python';
import {
  createConversation as createConversationRecord,
  deleteConversation as deleteConversationRecord,
  ensureConversation,
  getConversationById,
  listConversations,
  listRendererMessages,
  listTags,
  removeTag,
  renameConversationTitle,
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
  MAX_CONVERSATION_TITLE_LENGTH,
  BUILTIN_TASK_TAGS,
  TASK_TAG_SET,
  CUSTOM_TASK_TAG_LIMIT,
  CUSTOM_TEMPLATE_MAX_LENGTH,
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
  // 方向2：启动链中 configManager.reload() 先于本函数执行（index.ts），此处刷新一次
  // MAIN_TOOLS 使主智能体 skills enum 含已持久化的启用自定义标签（live binding，main-agent 零改动）。
  refreshMainTools();
  // 方向5：启动扫描注册动态工具（userData/dyn-tools/<tool_name>/{manifest.json,main.py}）。
  // 异步 fire-and-forget：单目录校验失败仅告警不阻塞启动（A5-2 启动扫描语义；
  // 重载入口=tools:dyn-reload，运行期任意时刻可手动触发补扫）。
  void loadDynamicTools().catch((error: unknown) => {
    console.warn('[ipc-handlers] 动态工具启动扫描失败（不阻塞启动）：', error);
  });
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
    try {
      abortConversationRun(conversationId);
    }
    finally {
      emitConversationUpdated(
        mainWindow,
        setConversationRunning(conversationId, false),
      );
      eventBus.emit(MAIN_AGENT_ABORTED_EVENT, { conversationId });
    }
  });

  // ================================================================
  // EventBus → IPC 事件转发（MainAgent 白名单事件）
  // ================================================================

  // main-agent:chunk → IPC chat:chunk
  eventBusCleanups.push(eventBus.on(MAIN_AGENT_CHUNK_EVENT, (payload) => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    try {
      mainWindow.webContents.send(IPC_CHAT.CHUNK, payload);
    } catch {
      // renderer frame 已销毁时 send 会抛错，静默吞掉
    }
  }));

  // main-agent:thinking → IPC chat:thinking
  eventBusCleanups.push(eventBus.on(MAIN_AGENT_THINKING_EVENT, (payload) => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    try {
      mainWindow.webContents.send(IPC_CHAT.THINKING, payload);
    } catch {
      // renderer frame 已销毁时 send 会抛错，静默吞掉
    }
  }));

  // main-agent:tool-call → IPC chat:tool-call
  eventBusCleanups.push(eventBus.on(MAIN_AGENT_TOOL_CALL_EVENT, (payload) => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    try {
      mainWindow.webContents.send(IPC_CHAT.TOOL_CALL, payload);
    } catch {
      // renderer frame 已销毁时 send 会抛错，静默吞掉
    }
  }));

  // main-agent:tool-result → IPC chat:tool-result
  eventBusCleanups.push(eventBus.on(MAIN_AGENT_TOOL_RESULT_EVENT, (payload) => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    try {
      mainWindow.webContents.send(IPC_CHAT.TOOL_RESULT, payload);
    } catch {
      // renderer frame 已销毁时 send 会抛错，静默吞掉
    }
  }));

  // main-agent:done → IPC chat:done
  eventBusCleanups.push(eventBus.on(MAIN_AGENT_DONE_EVENT, (payload) => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    try {
      mainWindow.webContents.send(IPC_CHAT.DONE, payload);
    } catch {
      // renderer frame 已销毁时 send 会抛错，静默吞掉
    }
  }));

  // main-agent:title → IPC chat:title（首轮标题生成完成后推送）
  eventBusCleanups.push(eventBus.on(MAIN_AGENT_TITLE_EVENT, (payload) => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    try {
      mainWindow.webContents.send(IPC_CHAT.TITLE, payload);
    } catch {
      // renderer frame 已销毁时 send 会抛错，静默吞掉
    }
  }));

  // main-agent:error → IPC chat:error
  eventBusCleanups.push(eventBus.on(MAIN_AGENT_ERROR_EVENT, (payload) => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    try {
      mainWindow.webContents.send(IPC_CHAT.ERROR, payload);
    } catch {
      // renderer frame 已销毁时 send 会抛错，静默吞掉
    }
  }));

  // ★ P0-E3：main-agent:aborted → IPC chat:aborted
  // 对齐 E:\ai_fr chat.aborted 事件，前端 useChat 的 unsubAborted 监听器负责归一化 abort 状态
  eventBusCleanups.push(eventBus.on(MAIN_AGENT_ABORTED_EVENT, (payload) => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    try {
      mainWindow.webContents.send(IPC_CHAT.ABORTED, payload);
    } catch {
      // renderer frame 已销毁时 send 会抛错，静默吞掉
    }
  }));

  // ★ P6 历史消息附件回显：user.message.created → IPC chat:user-message-created
  //   main-agent.ts 在 insertMessage(user) 后 emit,前端 useChat 收到后替换本地乐观 user 消息
  //   payload 含 conversationId + message{id, role, content, attachments, createdAt}
  eventBusCleanups.push(eventBus.on(USER_MESSAGE_CREATED_EVENT, (payload) => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    try {
      mainWindow.webContents.send(IPC_CHAT.USER_MESSAGE_CREATED, payload);
    } catch {
      // renderer frame 已销毁时 send 会抛错，静默吞掉
    }
  }));

  eventBusCleanups.push(eventBus.on(ASSISTANT_MESSAGE_STARTED_EVENT, (payload) => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    try {
      mainWindow.webContents.send(IPC_CHAT.ASSISTANT_STARTED, payload);
    } catch {
      // renderer frame 已销毁时 send 会抛错，静默吞掉
    }
  }));

  eventBusCleanups.push(eventBus.on(ASSISTANT_MESSAGE_DONE_EVENT, (payload) => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    try {
      mainWindow.webContents.send(IPC_CHAT.ASSISTANT_DONE, payload);
    } catch {
      // renderer frame 已销毁时 send 会抛错，静默吞掉
    }
  }));

  eventBusCleanups.push(eventBus.on(TOOL_MESSAGE_CREATED_EVENT, (payload) => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    try {
      mainWindow.webContents.send(IPC_CHAT.TOOL_MESSAGE_CREATED, payload);
    } catch {
      // renderer frame 已销毁时 send 会抛错，静默吞掉
    }
  }));

  // ★ S3（M4）：tool.batch.completed → IPC tool.batch.completed
  //   main-agent.ts 批次收口块在全中止判定之前 emit（含全中止批次），
  //   前端 useChat 按 isError 收口 running 快照（对齐 ai_fr route.ts:973-977 → chat-shell.tsx:2093-2099）
  eventBusCleanups.push(eventBus.on(TOOL_BATCH_COMPLETED_EVENT, (payload) => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    try {
      mainWindow.webContents.send(IPC_CHAT.TOOL_BATCH_COMPLETED, payload);
    } catch {
      // renderer frame 已销毁时 send 会抛错，静默吞掉
    }
  }));

  eventBusCleanups.push(eventBus.on('executor:snapshot', (data) => {
    if (mainWindow.isDestroyed()) {
      return;
    }
    try {
      mainWindow.webContents.send(IPC_EXECUTOR.SNAPSHOT, data);
    } catch {
      // renderer frame 已销毁时 send 会抛错，静默吞掉
    }
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

    // 【链路C】当前加载了方案（activeProfileId 存在）时，模型配置修改后同步更新该方案在
    // modelProfiles 中的对应字段；方案字段全集 = PROFILE_CONFIG_KEYS（visionEnabled 等非方案键不入档，不同步）。
    // 注：PROFILE_CONFIG_KEYS 在本函数后续定义，handler 回调异步执行时已初始化，无 TDZ 问题。
    if ((PROFILE_CONFIG_KEYS as readonly string[]).includes(params.key)) {
      const s = configManager.getSettings();
      const activeId = s.activeProfileId;
      if (activeId) {
        const profiles = [...s.modelProfiles];
        const idx = profiles.findIndex((item) => item.id === activeId);
        if (idx >= 0) {
          const next = { ...profiles[idx] } as ModelProfile & Record<string, unknown>;
          next[params.key] = params.value;
          profiles[idx] = next as ModelProfile;
          saveSetting('modelProfiles', profiles);
          configManager.setSetting('modelProfiles', profiles);
        }
      }
    }
  });

  ipcMain.handle(IPC_CONFIG.RELOAD, async (): Promise<void> => {
    configManager.reload();
    // 方向2：reload 可能恢复/变更 customSkillTags，同步刷新主智能体 skills enum
    refreshMainTools();
  });

  // ================================================================
  // 模型档案处理器（多槽位 + 一键切换 + 兼容未来新模型：档案值始终自由文本快照）
  // ================================================================

  type ProfileListResult = { profiles: ModelProfile[]; activeProfileId: string };
  type ProfileSaveParams = { name: string };
  type ProfileDeleteParams = { id: string };
  type ProfileSwitchParams = { id: string };
  type ProfileSwitchResult = { activeProfileId: string; profileName: string };

  /** 档案切换批量写回的配置键全集（三组九键 + mainModelMultimodal + mainThinkingLevel + executorThinkingLevel；visionEnabled 总开关不入档） */
  const PROFILE_CONFIG_KEYS = [
    'mainModelBaseUrl',
    'mainModelApiKey',
    'mainModelName',
    'mainModelMultimodal',
    'mainThinkingLevel',
    'executorModelBaseUrl',
    'executorModelApiKey',
    'executorModelName',
    'executorThinkingLevel',
    'visionLlmBaseUrl',
    'visionLlmApiKey',
    'visionLlmModel',
  ] as const;

  ipcMain.handle(IPC_CONFIG.PROFILES_LIST, async (): Promise<ProfileListResult> => {
    const settings = configManager.getSettings();
    return { profiles: settings.modelProfiles, activeProfileId: settings.activeProfileId };
  });

  ipcMain.handle(IPC_CONFIG.PROFILES_SAVE, async (_event, params: ProfileSaveParams): Promise<ProfileListResult> => {
    const name = typeof params?.name === 'string' ? params.name.trim() : '';
    if (!name) {
      throw new Error('档案名称不能为空');
    }
    // 另存为：以主进程当前生效配置（九键+开关/档位）为权威快照源；同名档案覆盖并保留原 id
    const settings = configManager.getSettings();
    const profiles = [...settings.modelProfiles];
    const existingIndex = profiles.findIndex((item) => item.name === name);
    const profile: ModelProfile = {
      id: existingIndex >= 0 ? profiles[existingIndex].id : uuidv4(),
      name,
      mainModelBaseUrl: settings.mainModelBaseUrl,
      mainModelApiKey: settings.mainModelApiKey,
      mainModelName: settings.mainModelName,
      mainModelMultimodal: settings.mainModelMultimodal,
      mainThinkingLevel: settings.mainThinkingLevel,
      executorModelBaseUrl: settings.executorModelBaseUrl,
      executorModelApiKey: settings.executorModelApiKey,
      executorModelName: settings.executorModelName,
      executorThinkingLevel: settings.executorThinkingLevel,
      visionLlmBaseUrl: settings.visionLlmBaseUrl,
      visionLlmApiKey: settings.visionLlmApiKey,
      visionLlmModel: settings.visionLlmModel,
    };
    if (existingIndex >= 0) {
      profiles[existingIndex] = profile;
    } else {
      profiles.push(profile);
    }
    saveSetting('modelProfiles', profiles);
    configManager.setSetting('modelProfiles', profiles);
    // 首次保存自动激活：仅当前无激活方案（activeProfileId===''）时补写激活键，防止同名覆盖既有
    // 非激活方案时错切激活标记；返回实际激活 id——空时补写后即新档案 id，非空保持原值
    let activeProfileId = settings.activeProfileId;
    if (activeProfileId === '') {
      activeProfileId = profile.id;
      saveSetting('activeProfileId', activeProfileId);
      configManager.setSetting('activeProfileId', activeProfileId);
    }
    return { profiles, activeProfileId };
  });

  ipcMain.handle(IPC_CONFIG.PROFILES_DELETE, async (_event, params: ProfileDeleteParams): Promise<ProfileListResult> => {
    const settings = configManager.getSettings();
    const profiles = settings.modelProfiles.filter((item) => item.id !== params.id);
    let activeProfileId = settings.activeProfileId;
    // 【模型配置方案使能】删除激活方案后的激活态转移：剩余非空时自动补选第一个为 activeProfileId
    // （当前生效九键保持不变，链路C 修改写回链路继续生效）；剩余为空时置空且不报错；
    // 激活 id 为空或悬空（指向已不存在的方案）时同样统一补选，禁止本分支静默失效。
    if (!profiles.some((item) => item.id === activeProfileId)) {
      activeProfileId = profiles.length > 0 ? profiles[0].id : '';
      saveSetting('activeProfileId', activeProfileId);
      configManager.setSetting('activeProfileId', activeProfileId);
    }
    saveSetting('modelProfiles', profiles);
    configManager.setSetting('modelProfiles', profiles);
    return { profiles, activeProfileId };
  });

  ipcMain.handle(IPC_CONFIG.PROFILES_SWITCH, async (_event, params: ProfileSwitchParams): Promise<ProfileSwitchResult> => {
    const settings = configManager.getSettings();
    const profile = settings.modelProfiles.find((item) => item.id === params.id);
    if (!profile) {
      throw new Error('档案不存在或已被删除');
    }
    // 切换流程：逐键「saveSetting 落库 + setSetting 即时生效」（对齐既有 config:save 模式）；
    // 任一键失败：汇总错误返回且不回滚已写键（settings INSERT OR REPLACE 幂等，重试切换即自愈）；
    // 全部成功后再写 activeProfileId。
    const errors: string[] = [];
    for (const key of PROFILE_CONFIG_KEYS) {
      try {
        const value = profile[key];
        // 兜底：存量档案缺 mainThinkingLevel 时 value=undefined（stringifyJson(undefined)=undefined 经 better-sqlite3 绑定 NULL，触发 value_json NOT NULL 约束抛错）；
        // 跳过 undefined 键，保持当前生效档位不动（对齐 visionEnabled 不入档语义）
        if (value === undefined) continue;
        saveSetting(key, value);
        configManager.setSetting(key, value);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`${key}: ${msg}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(`切换档案「${profile.name}」部分失败（${PROFILE_CONFIG_KEYS.length - errors.length}/${PROFILE_CONFIG_KEYS.length} 键已写入，未回滚；重试切换可自愈）：${errors.join('；')}`);
    }
    saveSetting('activeProfileId', profile.id);
    configManager.setSetting('activeProfileId', profile.id);
    return { activeProfileId: profile.id, profileName: profile.name };
  });

  // ================================================================
  // 自定义技能处理器（方向2：skills 三通道；内置8标签只读锁定，自定义标签/模板管理）
  // ================================================================

  type SkillBuiltinItem = { name: string; title: string; description: string; fileName: string };
  type SkillsListResult = {
    builtin: SkillBuiltinItem[];
    custom: CustomSkillTag[];
    limit: number;
    templateMaxLength: number;
  };
  type SkillSaveParams = {
    originalName?: string;
    name: string;
    title: string;
    description?: string;
    enabled?: boolean;
    templateContent: string;
  };
  type SkillsMutationResult = { custom: CustomSkillTag[] };
  type SkillDeleteParams = { name: string };

  ipcMain.handle(IPC_SKILLS.LIST, async (): Promise<SkillsListResult> => {
    // 内置8标签只读展示（从内置注册表组装，不含自定义来源）
    const builtin: SkillBuiltinItem[] = BUILTIN_TASK_TAGS.map((name) => {
      const template = EXECUTOR_WORKFLOW_TEMPLATES[TASK_TAG_WORKFLOW_TEMPLATE_ID[name]];
      return { name, title: template.title, description: template.description, fileName: template.fileName };
    });
    return {
      builtin,
      custom: listCustomSkillTagMeta(),
      limit: CUSTOM_TASK_TAG_LIMIT,
      templateMaxLength: CUSTOM_TEMPLATE_MAX_LENGTH,
    };
  });

  ipcMain.handle(IPC_SKILLS.SAVE, async (_event, params: SkillSaveParams): Promise<SkillsMutationResult> => {
    const originalName = typeof params?.originalName === 'string' && params.originalName.trim()
      ? params.originalName.trim()
      : '';
    const name = typeof params?.name === 'string' ? params.name.trim() : '';
    const title = typeof params?.title === 'string' ? params.title.trim() : '';
    const description = typeof params?.description === 'string' ? params.description.trim() : '';
    const enabled = params?.enabled !== false;
    // templateContent 缺省 = 保持现有模板文件不变（编辑元数据/启停场景；新建时必填由 validate 保证）
    const templateContent = typeof params?.templateContent === 'string' ? params.templateContent : null;

    const existing = listCustomSkillTagMeta();
    const current = originalName ? existing.find((item) => item.name === originalName) : undefined;
    if (originalName && !current) {
      throw new Error(`待编辑的自定义技能标签不存在: ${originalName}`);
    }
    // 校验（编辑场景排除自身；内置重名/数量上限/模板长度等硬约束在 validateCustomSkillTagInput 内）
    const others = existing.filter((item) => item !== current);
    const issues = validateCustomSkillTagInput(
      { name, title, description, enabled, templateContent },
      others,
      { isCreate: !current },
    );
    if (issues.length > 0) {
      throw new Error(issues.join('；'));
    }

    // slug：新建生成（短随机后缀规避中文名目录风险）；编辑锁定原 slug（模板目录不漂移）
    const slug = current ? current.slug : `skill-${uuidv4().replace(/-/g, '').slice(0, 8)}`;
    if (!isValidCustomSkillSlug(slug)) {
      throw new Error(`自定义技能模板目录 slug 非法: ${slug}`);
    }

    if (templateContent !== null) {
      await writeCustomSkillTemplate(slug, templateContent);
    }

    const entry: CustomSkillTag = { name, slug, title, description, enabled };
    const next = current
      ? existing.map((item) => (item === current ? entry : item))
      : [...existing, entry];
    saveSetting('customSkillTags', next);
    configManager.setSetting('customSkillTags', next);
    // enum 运行时刷新（ES live binding；放行链在每次委派时从 configManager 读取，无需另行刷新）
    refreshMainTools();
    return { custom: next };
  });

  ipcMain.handle(IPC_SKILLS.DELETE, async (_event, params: SkillDeleteParams): Promise<SkillsMutationResult> => {
    const name = typeof params?.name === 'string' ? params.name.trim() : '';
    if (TASK_TAG_SET.has(name)) {
      throw new Error('内置技能标签只读锁定，不可删除');
    }
    const existing = listCustomSkillTagMeta();
    const target = existing.find((item) => item.name === name);
    if (!target) {
      throw new Error(`自定义技能标签不存在: ${name}`);
    }
    await removeCustomSkillTemplateDir(target.slug);
    const next = existing.filter((item) => item.name !== name);
    saveSetting('customSkillTags', next);
    configManager.setSetting('customSkillTags', next);
    refreshMainTools();
    return { custom: next };
  });

  ipcMain.handle(
    IPC_SKILLS.READ_TEMPLATE,
    async (_event, params: { source?: string; key?: string }): Promise<{ success: boolean; content?: string; error?: string }> => {
      const source = typeof params?.source === 'string' ? params.source : '';
      const key = typeof params?.key === 'string' ? params.key.trim() : '';
      if (source === 'builtin') {
        // 内置分支：fileName 必须命中内置模板白名单（防路径穿越；fileName 含同构子目录）
        const allowedFileNames = new Set(Object.values(EXECUTOR_WORKFLOW_TEMPLATES).map((template) => template.fileName));
        if (!allowedFileNames.has(key)) {
          return { success: false, error: `内置模板文件名不在白名单内: ${key}` };
        }
        try {
          // 覆写优先：userData/builtin-skill-overrides/<fileName> 存在则读覆写，否则读内置目录
          return { success: true, content: await readBuiltinTemplateContent(key) };
        } catch (error) {
          return { success: false, error: `读取内置模板内容失败: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      if (source === 'custom') {
        // 自定义分支：key 须 slug 形态（[a-z0-9-] 且非空，防路径穿越）；文件不存在返回空串（从未写过模板的自定义技能回显空）
        if (!isValidCustomSkillSlug(key)) {
          return { success: false, error: `自定义技能模板 slug 非法: ${key}` };
        }
        try {
          return { success: true, content: await readCustomSkillTemplateContent(key) };
        } catch (error) {
          const errCode = error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'
            ? (error as NodeJS.ErrnoException).code
            : '';
          if (errCode === 'ENOENT') {
            return { success: true, content: '' };
          }
          return { success: false, error: `读取自定义模板内容失败: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      return { success: false, error: `未知的模板来源: ${source}` };
    },
  );

  ipcMain.handle(
    IPC_SKILLS.SAVE_BUILTIN_OVERRIDE,
    async (_event, params: { fileName?: string; content?: string | null }): Promise<{ success: boolean; error?: string }> => {
      const fileName = typeof params?.fileName === 'string' ? params.fileName.trim() : '';
      // fileName 白名单校验（防路径穿越；仅允许内置8模板的既定 fileName）
      const allowedFileNames = new Set(Object.values(EXECUTOR_WORKFLOW_TEMPLATES).map((template) => template.fileName));
      if (!allowedFileNames.has(fileName)) {
        return { success: false, error: `内置模板文件名不在白名单内: ${fileName}` };
      }
      try {
        if (params?.content === null) {
          // content=null：删除覆写文件（恢复默认语义；覆写不存在则 no-op）
          await deleteBuiltinOverride(fileName);
        } else {
          const content = typeof params?.content === 'string' ? params.content : '';
          if (!content.trim()) {
            return { success: false, error: '模板内容不能为空' };
          }
          await writeBuiltinOverride(fileName, content);
        }
        return { success: true };
      } catch (error) {
        return { success: false, error: `保存内置模板覆写失败: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  );

  // ================================================================
  // 动态工具处理器（方向5：tools:dyn-reload / tools:dyn-list 两通道；内置3工具锁定）
  // ================================================================

  ipcMain.handle(IPC_TOOLS.DYN_RELOAD, async (): Promise<DynToolsLoadResult> => {
    // 手动重载：先注销全部动态注册，再重扫 dyn-tools 目录（幂等；失败目录告警并进 failed 列表）
    return reloadDynamicTools();
  });

  ipcMain.handle(IPC_TOOLS.DYN_LIST, async (): Promise<{ tools: DynToolInfo[] }> => {
    return { tools: listDynamicTools() };
  });

  // ================================================================
  // 对话管理处理器
  // ================================================================

  // ★ 方向3：listConversations 已聚合 conversation_tags（既有五字段不动，叠加 tags 字段）
  ipcMain.handle(IPC_CONV.LIST, async (): Promise<Array<ConversationListItem & { tags: string[] }>> => {
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
    // 快照内存 session 随会话删除同步清理（文件侧随会话目录整体删除）
    clearSnapshotSession(id);
    if (lastActiveConversationId === id) {
      lastActiveConversationId = null;
    }
    await removeConversationUploadDir(id).catch(() => undefined);
    await removeConversationOutputFiles(id).catch(() => undefined);
  });

  // ================================================================
  // 方向3：对话重命名 + 标签（自定义标题安全关闭 / conversation_tags）
  // ================================================================

  type ConvRenameParams = { id: string; title: string };
  type ConvTagParams = { id: string; tag: string };
  type ConvWithTags = ConversationListItem & { tags: string[] };

  /**
   * conv:rename — 自定义标题写入（安全关闭在途标题生成三保险的第一环）
   * ① abortTitleGeneration：独立句柄取消在途标题生成（不影响会话运行）
   * ② renameConversationTitle：写库（不更新 updated_at、不改 is_running —— 规划 A3-5）
   * ③ emitConversationUpdated + chat:title(source=manual)：前端无条件更新并建立 manual 标志
   */
  ipcMain.handle(IPC_CONV.RENAME, async (_event, params: ConvRenameParams): Promise<ConvWithTags | null> => {
    if (!params?.id || typeof params.title !== 'string') {
      throw new Error('重命名参数无效');
    }
    const trimmedTitle = params.title.trim();
    if (!trimmedTitle) {
      throw new Error('标题不能为空');
    }
    const finalTitle = truncateConversationTitle(trimmedTitle, MAX_CONVERSATION_TITLE_LENGTH);

    // ① 安全关闭在途标题生成（titleAbortRegistry 独立取消）
    abortTitleGeneration(params.id);
    // ② 写入自定义标题
    renameConversationTitle(params.id, finalTitle);
    // ③ 推送列表态 + manual 标题事件（前端据此无条件更新并丢弃晚到的 generated）
    const conversation = getConversationById(params.id);
    if (!conversation) {
      return null;
    }
    const payload: ConvWithTags = { ...conversation, tags: listTags(params.id) };
    emitConversationUpdated(mainWindow, payload);
    const titlePayload = {
      conversationId: params.id,
      title: finalTitle,
      source: 'manual' as const,
    };
    eventBus.emit(MAIN_AGENT_TITLE_EVENT, titlePayload);
    return payload;
  });

  /** conv:tag-remove — 移除标签 */
  ipcMain.handle(IPC_CONV.TAG_REMOVE, async (_event, params: ConvTagParams): Promise<ConvWithTags | null> => {
    const tag = (params?.tag ?? '').trim();
    if (!params?.id || !tag) {
      throw new Error('标签参数无效');
    }
    removeTag(params.id, tag);
    const conversation = getConversationById(params.id);
    if (!conversation) {
      return null;
    }
    const payload: ConvWithTags = { ...conversation, tags: listTags(params.id) };
    emitConversationUpdated(mainWindow, payload);
    return payload;
  });

  ipcMain.handle(GET_LAST_ACTIVE_CONVERSATION, async () => lastActiveConversationId);

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

    return {
      messages: list,
    };
  });

  /**
   * conv:get-running-snapshots — 轻量快照查询（11:41:49 裁决①）
   * 返回该对话当前内存中的任务快照条目（未随 clearSnapshotSession 清理前均外流）；
   * 不读 messages 表、不返回历史消息、不去重读库。
   * is_running=false 时返回空数组（门禁语义与 conv:get-messages 一致，纯内存判断）。
   */
  ipcMain.handle(IPC_CONV.GET_RUNNING_SNAPSHOTS, (_event, conversationId: string) => {
    const conversation = getConversationById(conversationId);
    if (!conversation?.isRunning) return [];
    return getRunningSnapshotEntries(conversationId);
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

  ipcMain.handle(IPC_PYTHON.SELECT_CUSTOM, async (): Promise<SystemPythonInfo> => {
    return await pythonManager.selectCustomPythonPath();
  });

  ipcMain.handle(IPC_PYTHON.DOWNLOAD, async (): Promise<void> => {
    await pythonManager.downloadBuiltinPython();
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
