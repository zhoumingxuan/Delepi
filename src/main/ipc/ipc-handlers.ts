/**
 * IPC 处理器注册
 * 实现核心 IPC 通道：chat:send、chat:abort
 *
 * 事件流（v1.2）：
 * MainAgent 事件 → EventBus → IPC → 前端
 * ExecutorAgent 事件 → EventBus → IPC（executor 三通道）→ 前端
 */

import { app, ipcMain, BrowserWindow, dialog, shell } from 'electron';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_CHAT, IPC_CONFIG, IPC_CONV, IPC_EXECUTOR, IPC_FILE, IPC_PYTHON, IPC_DIALOG, IPC_SKILLS, IPC_TOOLS, IPC_LOG, IPC_WATCH, IPC_UPDATE } from '@shared/ipc-channels';
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
import type {
  UpdateCheckParams,
  UpdateDownloadParams,
  UpdateInstallParams,
} from '@shared/types/update';
import { eventBus } from '../modules/event-bus/event-bus';
import { getRunningAssistantMessage } from '../modules/main-agent/running-assistant-message-map';
import {
  queryExecutorTaskRecord,
  clearExecutorTaskRecords,
  stopExecutorTask,
  sendTaskUserMessage,
  countRunningExecutorTasks,
} from '../modules/executor-agent/executor-task-record-store';
import { EXECUTOR_RECORD_SIGNAL_EVENT } from '../constants/events';
import { runMainAgent, abortTitleGeneration } from '../modules/main-agent/main-agent';
import { refreshMainTools } from '../modules/main-agent/prompt';
import {
  deleteBuiltinOverride,
  isValidCustomSkillSlug,
  listCustomSkillTagMeta,
  readCustomSkillTemplateContent,
  removeCustomSkillTemplateDir,
  validateCustomSkillTagInput,
  writeBuiltinOverride,
  writeCustomSkillTemplate,
} from '../modules/executor-agent/executor-workflow-templates';
import {
  getBuiltinSkillTemplateMeta,
  listBuiltinSkillTemplateFileNames,
  readBuiltinSkillTemplateContent,
} from '../modules/skill-system/skill-registry';
import { truncateConversationTitle } from '../modules/main-agent/title-generation';
import { configManager } from '../modules/config/config-manager';
import { updateManager } from '../modules/update/update-manager';
import {
  applyProfileToSettings,
  bindConversationToProfile,
  inspectConversationModelProfile,
  resolveConversationModelConfig,
  type ConversationModelProfileView,
} from '../modules/config/conversation-model-profile';
import {
  loadDynamicTools,
  reloadDynamicTools,
  listDynamicTools,
  type DynToolsLoadResult,
  type DynToolInfo,
} from '../tools/dyn-tool-loader';
import { pythonManager, type SystemPythonInfo } from '../modules/python';

import {
  getWatchStatus,
  setWatchEnabledChangeNotifier,
  startWatch,
  startWatchService,
  stopWatch,
  type WatchStartResult,
  type WatchStatusResult,
  type WatchStopResult,
} from '../modules/watch/watch-service';
import {
  createConversation as createConversationRecord,
  deleteConversation as deleteConversationRecord,
  ensureConversation,
  clearConversationModelProfileBindings,
  getConversationById,
  getConversationModelProfileId,
  getDb,
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

import type { ConversationCleanupOptions } from '@shared/types/conversation-cleanup';
import { DEFAULT_APP_SETTINGS } from '@shared/constants';
import {
  computeConversationCleanupPreview,
  executeConversationCleanup,
} from '../utils/conversation-cleanup';

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

/**
 * 启动链/运行期日志：写入 userData/logs/main.log（含时间戳与环节名）。
 * - 同步落盘，保证崩溃/异常场景下日志已写入；
 * - 日志写入失败（目录不可写等）绝不影响应用主流程；
 * - 自 main/index.ts 移入并导出（R3/R5 修复配套）：IPC handler 层错误与
 *   log:renderer 渲染端转发共用同一持久日志出口；detail 提取兼容
 *   Error 实例与 { message, stack } 普通对象（渲染端经 IPC 结构化克隆后无 Error 原型）。
 */
export function writeMainLog(level: 'INFO' | 'WARN' | 'ERROR', stage: string, message: string, err?: unknown): void {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    mkdirSync(logDir, { recursive: true });
    const ts = new Date().toISOString();
    let detail = '';
    if (err instanceof Error) {
      detail = `${err.message}${err.stack ? `\n${err.stack}` : ''}`;
    } else if (err !== undefined) {
      const maybeErr = err as { message?: unknown; stack?: unknown };
      if (maybeErr !== null && typeof maybeErr.message === 'string') {
        detail = `${maybeErr.message}${typeof maybeErr.stack === 'string' ? `\n${maybeErr.stack}` : ''}`;
      } else {
        detail = String(err);
      }
    }
    appendFileSync(
      path.join(logDir, 'main.log'),
      `[${ts}] [${level}] [${stage}] ${message}${detail ? ` :: ${detail}` : ''}\n`,
      'utf8',
    );
  } catch {
    // 忽略：日志写入失败不影响应用主流程
  }
}

function fileInputToBuffer(file: {
  name?: string;
  data?: string | ArrayBuffer | Uint8Array | number[];
}): Buffer {
  const data = file.data;

  // H1 防御：渲染端改传 Base64 字符串（IPC 结构化克隆纯字符串，规避 ArrayBuffer 序列化断点）
  if (typeof data === 'string') {
    return Buffer.from(data, 'base64');
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  if (Array.isArray(data)) {
    return Buffer.from(data);
  }

  throw new Error(`[ERR_FILE_UPLOAD_INVALID_DATA] 文件 ${file.name || '(未命名)'} 数据无效`);
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
/** 自动更新 IPC 注册的清理函数（mac activate 二次注册时先精确清理上一轮订阅） */
let updateIpcDispose: (() => void) | null = null;

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  // P1-02: 精确清理上次注册的 EventBus 监听器
  for (const cleanup of eventBusCleanups) {
    cleanup();
  }
  eventBusCleanups = [];
  // 方向2：启动链中 configManager.reload() 先于本函数执行（index.ts），此处刷新一次
  // MAIN_TOOLS 使主智能体 query_skill enum 含已持久化的启用自定义标签（live binding，main-agent 零改动）。
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

    const messageId = uuidv4();

    // AbortController 已由 beginConversationRun 创建

    // ★ 缺陷②根因修复（闸门全路径释放）：API Key 校验移入 try——原实现位于
    //   beginConversationRun 成功之后、try 之前，mainModelApiKey 为空时 throw
    //   不经过 finally，闸门条目永久泄漏，该会话后续所有发送被
    //   ERR_CONVERSATION_RUNNING 拒绝（showCancel=false 无停止按钮，仅重启可恢复）。
    //   移入 try 后该早期退出路径与其余退出路径统一由 finally 的
    //   finishConversationRun 释放闸门；校验仍先于 ensureConversation /
    //   persistUploadedFiles / runMainAgent，可观察语义顺序不变。
    //   注意：begin 与 try 之间禁止再插入任何可抛出的语句（此处仅 null 判定，
    //   防止新的闸门旁路泄漏）。
    try {
      // 【阶段7 目标1】本次 run 的模型配置快照：会话绑定方案优先；未绑定则懒绑定当前激活方案；
      // 无任何方案时回落全局 14 键（等价阶段6 行为）。快照语义 → 运行中切换方案不影响本次 run。
      const modelResolution = resolveConversationModelConfig(conversationId);
      for (const warning of modelResolution.warnings) {
        writeMainLog('WARN', 'chat.model-profile', `conversationId=${conversationId} ${warning}`);
      }
      const runSettings = modelResolution.settings;
      // 校验主模型 API Key 非空（按本次 run 生效配置判定：绑定方案可能自带可用 key）
      const mainModelApiKey = runSettings.mainModelApiKey;
      if (!mainModelApiKey || mainModelApiKey.trim() === '') {
        throw new Error('主模型 API Key 未配置，请在设置中配置 API Key');
      }

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
          baseUrl: runSettings.mainModelBaseUrl,
          apiKey: runSettings.mainModelApiKey,
          model: runSettings.mainModelName,
        },
        assistantConfig: {
          mainModel: {
            baseUrl: runSettings.mainModelBaseUrl,
            apiKey: runSettings.mainModelApiKey,
            model: runSettings.mainModelName,
          },
          executorModel: {
            baseUrl: runSettings.executorModelBaseUrl,
            apiKey: runSettings.executorModelApiKey,
            model: runSettings.executorModelName,
          },
        },
        visionModelConfig: {
          baseUrl: runSettings.visionLlmBaseUrl,
          apiKey: runSettings.visionLlmApiKey,
          model: runSettings.visionLlmModel,
        },
        // 视觉识别总开关联动：visionEnabled=false 时主智能体多模态强制关闭（multimodalEnabled = visionEnabled && mainModelMultimodal）
        mainAgentMultimodalEnabled: runSettings.visionEnabled && runSettings.mainModelMultimodal,
        // 【F-4·R4 运行期快照】六键快照（主/子思考档位、主/子协议、压缩阈值、视觉总开关）随本次
        // run 传入；main-agent/executor-agent 运行期一律读该快照，不再直读 configManager 全局——
        // 运行中他处切换方案不影响本次 run（快照语义，INV-3）。与 conversation-send-service 入口同步。
        runtimeSettingsSnapshot: {
          mainThinkingLevel: runSettings.mainThinkingLevel,
          mainModelProtocol: runSettings.mainModelProtocol,
          executorThinkingLevel: runSettings.executorThinkingLevel,
          executorModelProtocol: runSettings.executorModelProtocol,
          executorContextCompressionThreshold: runSettings.executorContextCompressionThreshold,
          visionEnabled: runSettings.visionEnabled,
        },
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

      // ★ 取消态统一吞错（同机制补齐）：本 run 的 abortController.signal.aborted=true 时，
      //   runMainAgent 抛出的一切错误一律按取消收敛（取消提示已由 chat:abort →
      //   MAIN_AGENT_ABORTED_EVENT 先行时序 + 渲染层归一化气泡单独承担）——覆盖取消+API
      //   错误竞态（取消瞬间恰逢 ModelApiAbortError，如重试耗尽/探查降级链失败并发取消：
      //   主 catch 已不发事件，此处不再让其 message≠'ABORTED' 的错误漏到渲染层错误条）；
      //   非取消场景（signal.aborted=false）仅保留原 ERR_ABORTED 精确匹配，行为不变。
      if (errMsg === ERR_ABORTED || abortController.signal.aborted) {
        return {
          messageId,
          conversationId,
        };
      }

      throw error;
    } finally {
      // ★ 缺陷①③根因修复：闸门释放与 is_running 复位收敛到 run 真实 settle 出口，
      //   且以实例归属校验为前置——runMainAgent 返回/抛出（含 ERR_ABORTED）后
      //   finally 才执行，此处即本 run 的真实退出点；finishConversationRun 返回
      //   false = 条目已被替换/释放（本 run 已无闸门所有权），此时不得触碰
      //   is_running 与列表态（旧 run 退出不得踩踏新 run 的控制器与状态）。
      if (finishConversationRun(conversationId, abortController)) {
        emitConversationUpdated(
          mainWindow,
          setConversationRunning(conversationId, false),
        );
      }
    }
  });

  /**
   * chat:abort — 中止当前对话
   */
  ipcMain.on(IPC_CHAT.ABORT, (_event, conversationId: string) => {
    // ★ 缺陷①③根因修复说明：abortConversationRun 现仅触发控制器 abort，不再删除
    //   闸门条目（条目由 run 真实 settle 时经实例归属校验释放）——取消-settle 窗口内
    //   同会话新 chat:send 被 beginConversationRun 并发拒绝，杜绝旧 run 退出错杀
    //   新 run 控制器/踩踏其 is_running；渲染层"取消后立刻重发"由取消待收口队列在
    //   settle 时刻（flightKey 与闸门同点释放）自动重发，体验不变。
    //   finally 的立即复位 is_running + conv:updated 推送 + MAIN_AGENT_ABORTED_EVENT
    //   语义保持不变：渲染层 showCancel 即刻解锁（发送不再退化为停止手势）与消息
    //   abort 归一化依赖该时序，不得移除（已排除路径第 1/3 项）。
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

  // ★ 新版方案 §5.2-A4：executor:record-signal 白名单转发（主→渲染，极小信号）；
  //   守卫模式与上方既有转发一致（isDestroyed + conversationId 存在性 + send 容错）
  eventBusCleanups.push(eventBus.on(EXECUTOR_RECORD_SIGNAL_EVENT, (data) => {
    if (!data?.conversationId) {
      return;
    }
    if (mainWindow.isDestroyed()) {
      return;
    }
    try {
      mainWindow.webContents.send(IPC_EXECUTOR.RECORD_SIGNAL, data);
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

  /**
   * 【结构性根治·写入目标随数据携带】config:save 扩展参数：在既有 ConfigSaveParams（src/main/types/ipc.ts）
   * 基础上增加可选 conversationId / profileId；preload 的 save 通道按 unknown 透传，旧调用方不携带
   * 新字段时全部回落旧行为（向后兼容，INV-6）。profileId = 编辑发起时的上下文方案身份（前端
   * displayProfileId 在保存发起时捕获并随载荷上传），保存到达时直接按该 id 定位目标方案写入，
   * 不读到达时刻的任何可变状态（activeProfileId / 会话绑定）——迟到的保存天然写回其发起时的
   * 上下文方案，无需 prevValue 双通道守卫与切换窗口丢弃。
   */
  type ConfigSaveParamsWithContext = ConfigSaveParams & {
    /** 发起编辑的会话 id（兜底通道：profileId 缺失时按该会话当前绑定解析写入目标） */
    conversationId?: string;
    /** 编辑发起时的上下文方案 id（首选通道：保存到达时直接定位该方案写入） */
    profileId?: string;
  };

  ipcMain.handle(IPC_CONFIG.SAVE, async (_event, params: ConfigSaveParamsWithContext): Promise<void> => {
    // 【值守开关守卫（v3 §4.4）】watchEnabled 是"用户意图+运行态"双载体，仅允许
    // watch:start / watch:stop / 自动恢复回落三个服务侧出口写回；config:save 直写该键
    // 会造成"开关与轮询状态不一致"的绕过态，一律拒绝。
    if (params.key === 'watchEnabled') {
      throw new Error(
        'ERR_WATCH_ENABLED_DIRECT_WRITE_FORBIDDEN：watchEnabled 不允许经 config:save 直接写入；请经 watch:start / watch:stop 调整值守开关',
      );
    }
    // 【结构性根治·链路C】方案键（PROFILE_CONFIG_KEYS 15 键）写入目标 = 编辑发起时随载荷固定的
    // profileId，解析优先级：① 载荷 profileId 有效（存在于 modelProfiles）→ 无条件写入该方案
    // （身份明确，无需「现值===基准」一致性守卫）；② 载荷缺失（旧调用方/防御）→ 按会话绑定
    // （conversationId）解析；③ 均无 → 回落全局 activeProfileId（旧行为，INV-6 列表态兼容）。
    // 全局 15 键运行时单键写入仅在「写入目标 = 当前全局激活方案」时执行（运行时=激活方案的投影）；
    // 写入目标 ≠ 激活方案（迟到保存 / 会话绑定方案非激活）时零全局运行时写入——结构上杜绝
    // 「把方案 A 上下文的编辑写进方案 B 的运行时」。非方案键（visionEnabled 等）走旧行为。
    // 注：PROFILE_CONFIG_KEYS 在本函数后续定义，handler 回调异步执行时已初始化，无 TDZ 问题。
    if ((PROFILE_CONFIG_KEYS as readonly string[]).includes(params.key)) {
      const s = configManager.getSettings();
      const ctxProfileId = typeof params.profileId === 'string' ? params.profileId.trim() : '';
      const ctxConversationId = typeof params.conversationId === 'string' ? params.conversationId.trim() : '';
      let targetId = ctxProfileId && s.modelProfiles.some((item) => item.id === ctxProfileId)
        ? ctxProfileId
        : '';
      if (!targetId) {
        const boundProfileId = ctxConversationId && getConversationById(ctxConversationId)
          ? getConversationModelProfileId(ctxConversationId)
          : '';
        targetId = boundProfileId && s.modelProfiles.some((item) => item.id === boundProfileId)
          ? boundProfileId
          : s.activeProfileId;
      }
      if (targetId) {
        const profiles = [...s.modelProfiles];
        const idx = profiles.findIndex((item) => item.id === targetId);
        if (idx >= 0) {
          // 无条件写入目标方案：写入身份由载荷固定（随数据携带），旧「目标方案现值 === 运行时旧值/
          // 前端基准」双通道一致性守卫随双状态源错位一起移除——写入目标不再取自到达时刻的可变
          // 全局状态，守卫失去存在前提（结构性替代，非拦截式放宽）。
          const next = { ...profiles[idx] } as ModelProfile & Record<string, unknown>;
          next[params.key] = params.value;
          profiles[idx] = next as ModelProfile;
          saveSetting('modelProfiles', profiles);
          configManager.setSetting('modelProfiles', profiles);
        }
        // 运行时投影：仅当写入目标 = 当前全局激活方案时同步 15 键运行时单键，保持
        // 「全局默认方案存储 = 全局运行时」一致；否则零全局运行时写入（不污染默认方案运行时）
        if (targetId === s.activeProfileId) {
          saveSetting(params.key, params.value);
          const appSettings = configManager.getSettings();
          if (params.key in appSettings) {
            configManager.setSetting(
              params.key as keyof AppSettings,
              params.value as AppSettings[keyof AppSettings],
            );
          }
        }
        return;
      }
      // 无任何方案（targetId=''，无方案回退态）：旧行为——仅写全局运行时单键（此时全局运行时
      // 是唯一配置源，等价 resolver global-fallback 分支的读取口径）
      saveSetting(params.key, params.value);
      const fallbackSettings = configManager.getSettings();
      if (params.key in fallbackSettings) {
        configManager.setSetting(
          params.key as keyof AppSettings,
          params.value as AppSettings[keyof AppSettings],
        );
      }
      return;
    }
    // 非方案键：旧行为（写运行时单键 + 客户端更新联动；无方案身份、不入档）
    saveSetting(params.key, params.value);
    const appSettings = configManager.getSettings();
    if (params.key in appSettings) {
      configManager.setSetting(
        params.key as keyof AppSettings,
        params.value as AppSettings[keyof AppSettings],
      );
    }
    // 客户端自动更新：开关即时生效 / 地址变更重置状态（仅两个更新配置键，其它键零影响）
    if (params.key === 'updateAutoCheckEnabled' || params.key === 'updateBaseUrl') {
      updateManager.notifyConfigChanged(params.key);
    }
  });

  ipcMain.handle(IPC_CONFIG.RELOAD, async (): Promise<void> => {
    configManager.reload();
    // 方向2：reload 可能恢复/变更 customSkillTags，同步刷新主智能体 query_skill enum
    refreshMainTools();
  });

  // ================================================================
  // 模型档案处理器（多槽位 + 一键切换 + 兼容未来新模型：档案值始终自由文本快照）
  // ================================================================

  /**
   * 方案列表结果（阶段7：新增 conversationProfile 只读视图）
   * - conversationProfile 仅在调用方带 conversationId 时返回（配置抽屉展示「当前对话使用方案」）
   */
  type ProfileListResult = {
    profiles: ModelProfile[];
    activeProfileId: string;
    conversationProfile?: ConversationModelProfileView | null;
  };
  type ProfileListParams = { conversationId?: string } | undefined;
  // 【F-8·R7 封口】非 blank 分支=以主进程全局当前值为快照覆盖同名方案——在「会话绑定≠全局激活」
  // 错位态下这正是「把全局（可能=A）配置写进 B」的直接串扰形态；当前无任何前端调用方（前端仅
  // blank:true 新建）。封口：非 blank 必须显式携带 mode:'snapshot-overwrite' 才放行，否则拒绝。
  type ProfileSaveParams = { name: string; blank?: boolean; mode?: 'snapshot-overwrite' };
  type ProfileDeleteParams = { id: string };
  /** 切换参数：conversationId 存在时只把该会话绑定到新方案（不再只写全局 14 键） */
  type ProfileSwitchParams = { id: string; conversationId?: string };
  type ProfileSwitchResult = {
    activeProfileId: string;
    profileName: string;
    /** 切换后该会话的绑定方案 id（未传 conversationId 时为 ''） */
    conversationProfileId: string;
    /**
     * 带 conversationId 分支返回的新方案合成配置（= 全局设置 + 新方案 15 键覆盖，
     * applyProfileToSettings 口径），供前端会话分支回填表单（不再 onReload 回灌全局值）；
     * 未带 conversationId 时不返回该字段（列表态全局切换，旧行为）。
     */
    resolvedSettings?: AppSettings;
  };

  /** 档案切换批量写回的配置键全集（三组九键 + mainModelMultimodal + mainThinkingLevel + mainModelProtocol + executorThinkingLevel + executorModelProtocol + executorContextCompressionThreshold；visionEnabled 总开关不入档） */
  const PROFILE_CONFIG_KEYS = [
    'mainModelBaseUrl',
    'mainModelApiKey',
    'mainModelName',
    'mainModelMultimodal',
    'mainThinkingLevel',
    'mainModelProtocol',
    'executorModelBaseUrl',
    'executorModelApiKey',
    'executorModelName',
    'executorThinkingLevel',
    'executorContextCompressionThreshold',
    'executorModelProtocol',
    'visionLlmBaseUrl',
    'visionLlmApiKey',
    'visionLlmModel',
  ] as const;

  ipcMain.handle(IPC_CONFIG.PROFILES_LIST, async (_event, params?: ProfileListParams): Promise<ProfileListResult> => {
    const settings = configManager.getSettings();
    const conversationId = typeof params?.conversationId === 'string' ? params.conversationId.trim() : '';
    const conversationProfile = conversationId && getConversationById(conversationId)
      ? inspectConversationModelProfile(conversationId)
      : null;
    return {
      profiles: settings.modelProfiles,
      activeProfileId: settings.activeProfileId,
      conversationProfile,
    };
  });

  ipcMain.handle(IPC_CONFIG.PROFILES_SAVE, async (_event, params: ProfileSaveParams): Promise<ProfileListResult> => {
    const name = typeof params?.name === 'string' ? params.name.trim() : '';
    if (!name) {
      throw new Error('档案名称不能为空');
    }
    // 另存为：以主进程当前生效配置（九键+开关/档位/协议）为权威快照源；同名档案覆盖并保留原 id。
    // blank=true：新建空白方案——9 个文本键取空串，开关/档位取 DEFAULT_APP_SETTINGS 默认值
    // （禁止存空串：config-manager reload() 过滤空串，重启后默认值回填会造成方案内容漂移）；
    // 【F-8】blank 非 true（原"复制全局快照"另存为语义）已封口：必须显式 mode:'snapshot-overwrite'
    // 才放行（见下方守卫），默认一律拒绝——防止错位态下把全局值写入非上下文方案。
    const blank = params.blank === true;
    // 【F-8·R7 封口】非 blank（全局快照覆盖）分支：未显式携带 mode:'snapshot-overwrite' 一律拒绝
    if (!blank && params.mode !== 'snapshot-overwrite') {
      throw new Error(
        'PROFILES_SAVE 非 blank 分支已封口：该分支以全局当前值快照覆盖方案存储，在「会话绑定≠全局激活」错位态下会把非上下文方案的内容写入目标方案；确需该语义必须显式传 mode:"snapshot-overwrite"（接入 UI 前须先落地 F-1/F-2 会话上下文对齐）',
      );
    }
    const settings = configManager.getSettings();
    const profiles = [...settings.modelProfiles];
    const existingIndex = profiles.findIndex((item) => item.name === name);
    const profile: ModelProfile = blank
      ? {
          id: existingIndex >= 0 ? profiles[existingIndex].id : uuidv4(),
          name,
          mainModelBaseUrl: '',
          mainModelApiKey: '',
          mainModelName: '',
          mainModelMultimodal: DEFAULT_APP_SETTINGS.mainModelMultimodal,
          mainThinkingLevel: DEFAULT_APP_SETTINGS.mainThinkingLevel,
          mainModelProtocol: DEFAULT_APP_SETTINGS.mainModelProtocol,
          executorModelBaseUrl: '',
          executorModelApiKey: '',
          executorModelName: '',
          executorThinkingLevel: DEFAULT_APP_SETTINGS.executorThinkingLevel,
          executorContextCompressionThreshold: DEFAULT_APP_SETTINGS.executorContextCompressionThreshold,
          executorModelProtocol: DEFAULT_APP_SETTINGS.executorModelProtocol,
          visionLlmBaseUrl: '',
          visionLlmApiKey: '',
          visionLlmModel: '',
        }
      : {
          id: existingIndex >= 0 ? profiles[existingIndex].id : uuidv4(),
          name,
          mainModelBaseUrl: settings.mainModelBaseUrl,
          mainModelApiKey: settings.mainModelApiKey,
          mainModelName: settings.mainModelName,
          mainModelMultimodal: settings.mainModelMultimodal,
          mainThinkingLevel: settings.mainThinkingLevel,
          mainModelProtocol: settings.mainModelProtocol,
          executorModelBaseUrl: settings.executorModelBaseUrl,
          executorModelApiKey: settings.executorModelApiKey,
          executorModelName: settings.executorModelName,
          executorThinkingLevel: settings.executorThinkingLevel,
          executorContextCompressionThreshold: settings.executorContextCompressionThreshold,
          executorModelProtocol: settings.executorModelProtocol,
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
    // 【模型配置方案使能】删除激活方案后的激活态转移：剩余非空时自动补选第一个为 activeProfileId，
    // 并在写 activeProfileId 之前按新激活方案以 PROFILES_SWITCH 同语义应用其 14 键
    //（逐键 if value===undefined continue; saveSetting; setSetting），使「激活方案」与「运行时九键」
    // 始终一致，杜绝「激活=满配置方案、运行时=旧值」错位态经链路C 污染其他方案存储；
    // 剩余为空（activeProfileId===''）时不应用任何键，九键保持现状且不报错；
    // 激活 id 为空或悬空（指向已不存在的方案）时同样统一补选，禁止本分支静默失效。
    if (!profiles.some((item) => item.id === activeProfileId)) {
      activeProfileId = profiles.length > 0 ? profiles[0].id : '';
      if (activeProfileId) {
        const nextActiveProfile = profiles[0];
        for (const key of PROFILE_CONFIG_KEYS) {
          const value = nextActiveProfile[key];
          // 协议键/压缩阈值键缺键回填：转移到的档案缺该键时以 DEFAULT_APP_SETTINGS 默认值落库并即时生效，杜绝残留已删档案旧值
          if (
            value === undefined &&
            (key === 'mainModelProtocol' || key === 'executorModelProtocol' || key === 'executorContextCompressionThreshold')
          ) {
            const fallbackValue = DEFAULT_APP_SETTINGS[key];
            saveSetting(key, fallbackValue);
            configManager.setSetting(key, fallbackValue);
            continue;
          }
          if (value === undefined) continue;
          saveSetting(key, value);
          configManager.setSetting(key, value);
        }
      }
      saveSetting('activeProfileId', activeProfileId);
      configManager.setSetting('activeProfileId', activeProfileId);
    }
    saveSetting('modelProfiles', profiles);
    configManager.setSetting('modelProfiles', profiles);
    // 【阶段7 目标1】删除方案后清空所有指向它的会话绑定（悬空绑定自愈的主动侧；
    // 运行期 resolver 仍有第二道兜底：绑定失效即清空并回落激活方案）
    const clearedBindings = clearConversationModelProfileBindings(params.id);
    if (clearedBindings > 0) {
      writeMainLog(
        'WARN',
        'config.profile',
        `方案 ${params.id} 已删除：清空 ${clearedBindings} 个会话的模型方案绑定`,
      );
    }
    return { profiles, activeProfileId };
  });

  ipcMain.handle(IPC_CONFIG.PROFILES_SWITCH, async (_event, params: ProfileSwitchParams): Promise<ProfileSwitchResult> => {
    const settings = configManager.getSettings();
    const profile = settings.modelProfiles.find((item) => item.id === params.id);
    if (!profile) {
      throw new Error('档案不存在或已被删除');
    }
    const targetConversationId = typeof params?.conversationId === 'string' ? params.conversationId.trim() : '';

    if (targetConversationId) {
      // 【结构性根治·会话级切换 = 纯会话绑定变更】只写 conversations.model_profile_id（单条 UPDATE，
      // 天然原子），零全局写入——不写全局 15 键运行时、不写 activeProfileId。全局①②从此收缩为
      // 「默认方案/列表态」单一语义（仅列表态切换 / PROFILES_DELETE 激活转移 / PROFILES_SAVE 空位
      // 补位 / reload 补选时写入），会话级切换不再制造「全局运行时 = 非默认方案值」的双状态源错位
      // （上一轮 F-3 保守变体的无条件全局写入已按根治设计移除）。
      // 返回 resolvedSettings（= 全局设置 + 新方案 15 键覆盖，applyProfileToSettings 口径）供前端
      // 会话分支回填表单；activeProfileId 返回当前真实全局激活（本次未改写）。
      if (!getConversationById(targetConversationId)) {
        throw new Error('会话不存在或已被删除，无法切换该对话的方案绑定');
      }
      bindConversationToProfile(targetConversationId, profile.id);
      const resolvedSettings = applyProfileToSettings(configManager.getSettings(), profile);
      writeMainLog(
        'INFO',
        'config.profile',
        `方案切换已绑定会话（零全局写入）：conversationId=${targetConversationId} profileId=${profile.id} profileName=${profile.name}`,
      );
      return {
        activeProfileId: settings.activeProfileId,
        profileName: profile.name,
        conversationProfileId: profile.id,
        resolvedSettings,
      };
    }

    // 列表态（无会话上下文）＝应用默认方案：全局 15 键 + activeProfileId 写入保持旧行为（INV-6）。
    // 切换流程：逐键「saveSetting 落库」。【F-6·R5】15 键循环 + activeProfileId 写入整体包入
    // getDb().transaction（参照 conversation.repo.ts deleteConversationGuarded 事务范式）——任一键
    // 失败即整体回滚，DB 恒为「全成或全不改」，杜绝「半个 B」错乱态；configManager 内存同步统一
    // 延后到事务提交成功后回放（内存永不超前于已提交的库状态，回滚后内存/库保持一致）。
    const errors: string[] = [];
    const appliedKv: Array<[string, unknown]> = [];
    try {
      getDb().transaction(() => {
        for (const key of PROFILE_CONFIG_KEYS) {
          try {
            const value = profile[key];
            // 兜底：存量档案缺 mainThinkingLevel 时 value=undefined（stringifyJson(undefined)=undefined 经 better-sqlite3 绑定 NULL，触发 value_json NOT NULL 约束抛错）；
            // 跳过 undefined 键，保持当前生效档位不动（对齐 visionEnabled 不入档语义）
            // 协议键/压缩阈值键缺键回填：存量档案缺该键时以 DEFAULT_APP_SETTINGS 默认值落库并即时生效，杜绝切换后残留上一档案值
            if (
              value === undefined &&
              (key === 'mainModelProtocol' || key === 'executorModelProtocol' || key === 'executorContextCompressionThreshold')
            ) {
              const fallbackValue = DEFAULT_APP_SETTINGS[key];
              saveSetting(key, fallbackValue);
              appliedKv.push([key, fallbackValue]);
              continue;
            }
            if (value === undefined) continue;
            saveSetting(key, value);
            appliedKv.push([key, value]);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            errors.push(`${key}: ${msg}`);
          }
        }
        if (errors.length > 0) {
          // 抛出以触发事务回滚（better-sqlite3：transaction 函数抛错即 ROLLBACK，DB 恢复切换前状态）
          throw new Error('__PROFILE_SWITCH_TX_ROLLBACK__');
        }
        saveSetting('activeProfileId', profile.id);
      })();
    } catch (txError) {
      if (errors.length > 0) {
        // 已整体回滚：全局运行时（库+内存）保持切换前状态；重试切换可自愈
        throw new Error(`切换档案「${profile.name}」部分失败（${errors.length}/${PROFILE_CONFIG_KEYS.length} 键写入失败，事务已整体回滚，全局配置保持切换前状态；重试切换可自愈）：${errors.join('；')}`);
      }
      throw txError;
    }
    // 事务提交成功：统一同步 configManager 内存（逐键 setSetting，提交后内存态与旧版一致）
    for (const [key, value] of appliedKv) {
      configManager.setSetting(key as keyof AppSettings, value as AppSettings[keyof AppSettings]);
    }
    configManager.setSetting('activeProfileId', profile.id);
    return { activeProfileId: profile.id, profileName: profile.name, conversationProfileId: '', resolvedSettings: undefined };
  });

  // ---- 方案导出/导入（文件 IO）：导出=ModelProfile 原样序列化落盘（密钥明文）；导入=白名单容错提取+补位，新档案追加不激活 ----
  type ProfileExportParams = { profileId: string };
  type ProfileExportResult =
    | { ok: true; filePath: string }
    | { ok: false; canceled?: boolean; error?: string };
  type ProfileImportParams = { filePath: string };
  type ProfileImportResult =
    | {
        ok: true;
        profile: ModelProfile;
        profiles: ModelProfile[];
        activeProfileId: string;
        importedCount: number;
        skippedCount: number;
        renamed: boolean;
      }
    | { ok: false; code: 'READ_ERROR' | 'INVALID_JSON' | 'NOT_A_PROFILE'; error?: string };

  ipcMain.handle(IPC_CONFIG.PROFILES_EXPORT, async (_event, params: ProfileExportParams): Promise<ProfileExportResult> => {
    const settings = configManager.getSettings();
    const profile = settings.modelProfiles.find((item) => item.id === params?.profileId);
    if (!profile) {
      return { ok: false, error: '方案不存在或已被删除' };
    }
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) {
      return { ok: false, error: '窗口不可用，无法导出' };
    }
    // 默认文件名：方案名替换 Windows 非法字符 [\\/:*?"<>|] 为 '-'（空名兜底 '方案'）
    const safeName = profile.name.replace(/[\\/:*?"<>|]/g, '-').trim() || '方案';
    const result = await dialog.showSaveDialog(win, {
      title: '导出配置方案',
      defaultPath: `${safeName}.json`,
      filters: [{ name: 'Delepi 配置方案', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true };
    }
    try {
      // ModelProfile 原样序列化（2 空格缩进、UTF-8 无 BOM）：三处 API Key 为明文原值，不脱敏/不截断/不掩码
      await writeFile(result.filePath, JSON.stringify(profile, null, 2), 'utf-8');
      return { ok: true, filePath: result.filePath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC_CONFIG.PROFILES_IMPORT, async (_event, params: ProfileImportParams): Promise<ProfileImportResult> => {
    let rawText = '';
    try {
      rawText = await readFile(params?.filePath, 'utf-8');
    } catch (error) {
      return { ok: false, code: 'READ_ERROR', error: error instanceof Error ? error.message : String(error) };
    }
    let parsed: unknown = null;
    try {
      // 先剥离 UTF-8 BOM（旧版记事本保存的 JSON 常带 BOM，属编码噪声而非内容错误）
      parsed = JSON.parse(rawText.replace(/^\uFEFF/, ''));
    } catch {
      return { ok: false, code: 'INVALID_JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, code: 'NOT_A_PROFILE' };
    }
    const source = parsed as Record<string, unknown>;
    // 「有什么则导入什么」：15 配置键白名单容错提取——类型合法取文件值，缺失/非法按补位规则
    //（9 文本键 ''、开关/档位/协议/压缩阈值取 DEFAULT_APP_SETTINGS 实值；档位禁存空串：'' 与缺失/非法同等对待，
    //  防 config-manager reload() 空串过滤+默认值回填造成方案内容漂移；压缩阈值 '' 为不设置默认值、与空串过滤
    //  相容无漂移，属合法取值）。文件 id 一律忽略，恒新 uuid。
    const validThinkingLevels: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const validModelProtocols: readonly string[] = ['cc', 'responses'];
    // 压缩阈值档位：'' 为不设置默认值（与 reload 空串过滤相容、无漂移），与 64K/128K/256K 同为合法取值
    const validCompressionThresholds: readonly string[] = ['', '64K', '128K', '256K'];
    const newProfile: ModelProfile = {
      id: uuidv4(),
      name: '',
      mainModelBaseUrl: '',
      mainModelApiKey: '',
      mainModelName: '',
      mainModelMultimodal: DEFAULT_APP_SETTINGS.mainModelMultimodal,
      mainThinkingLevel: DEFAULT_APP_SETTINGS.mainThinkingLevel,
      mainModelProtocol: DEFAULT_APP_SETTINGS.mainModelProtocol,
      executorModelBaseUrl: '',
      executorModelApiKey: '',
      executorModelName: '',
      executorThinkingLevel: DEFAULT_APP_SETTINGS.executorThinkingLevel,
      executorContextCompressionThreshold: DEFAULT_APP_SETTINGS.executorContextCompressionThreshold,
      executorModelProtocol: DEFAULT_APP_SETTINGS.executorModelProtocol,
      visionLlmBaseUrl: '',
      visionLlmApiKey: '',
      visionLlmModel: '',
    };
    let importedCount = 0;
    let skippedCount = 0;
    const textConfigKeys = [
      'mainModelBaseUrl',
      'mainModelApiKey',
      'mainModelName',
      'executorModelBaseUrl',
      'executorModelApiKey',
      'executorModelName',
      'visionLlmBaseUrl',
      'visionLlmApiKey',
      'visionLlmModel',
    ] as const;
    for (const key of textConfigKeys) {
      const value = source[key];
      if (typeof value === 'string') {
        newProfile[key] = value;
        importedCount += 1;
      } else if (key in source) {
        skippedCount += 1;
      }
    }
    if (typeof source.mainModelMultimodal === 'boolean') {
      newProfile.mainModelMultimodal = source.mainModelMultimodal;
      importedCount += 1;
    } else if ('mainModelMultimodal' in source) {
      skippedCount += 1;
    }
    const readValidThinkingLevel = (value: unknown): ModelProfile['mainThinkingLevel'] | null =>
      typeof value === 'string' && validThinkingLevels.includes(value)
        ? (value as ModelProfile['mainThinkingLevel'])
        : null;
    const readValidModelProtocol = (value: unknown): ModelProfile['mainModelProtocol'] | null =>
      typeof value === 'string' && validModelProtocols.includes(value)
        ? (value as ModelProfile['mainModelProtocol'])
        : null;
    const readValidCompressionThreshold = (value: unknown): ModelProfile['executorContextCompressionThreshold'] | null =>
      typeof value === 'string' && validCompressionThresholds.includes(value)
        ? (value as ModelProfile['executorContextCompressionThreshold'])
        : null;
    const mainThinkingLevel = readValidThinkingLevel(source.mainThinkingLevel);
    if (mainThinkingLevel !== null) {
      newProfile.mainThinkingLevel = mainThinkingLevel;
      importedCount += 1;
    } else if ('mainThinkingLevel' in source) {
      skippedCount += 1;
    }
    const executorThinkingLevel = readValidThinkingLevel(source.executorThinkingLevel);
    if (executorThinkingLevel !== null) {
      newProfile.executorThinkingLevel = executorThinkingLevel;
      importedCount += 1;
    } else if ('executorThinkingLevel' in source) {
      skippedCount += 1;
    }
    const executorContextCompressionThreshold = readValidCompressionThreshold(source.executorContextCompressionThreshold);
    if (executorContextCompressionThreshold !== null) {
      newProfile.executorContextCompressionThreshold = executorContextCompressionThreshold;
      importedCount += 1;
    } else if ('executorContextCompressionThreshold' in source) {
      skippedCount += 1;
    }
    const mainModelProtocol = readValidModelProtocol(source.mainModelProtocol);
    if (mainModelProtocol !== null) {
      newProfile.mainModelProtocol = mainModelProtocol;
      importedCount += 1;
    } else if ('mainModelProtocol' in source) {
      skippedCount += 1;
    }
    const executorModelProtocol = readValidModelProtocol(source.executorModelProtocol);
    if (executorModelProtocol !== null) {
      newProfile.executorModelProtocol = executorModelProtocol;
      importedCount += 1;
    } else if ('executorModelProtocol' in source) {
      skippedCount += 1;
    }
    // 有效性判据：15 配置键中 ≥1 个存在且类型合法才视为方案文件（拦截 {} / 误选 package.json 等）
    if (importedCount === 0) {
      return { ok: false, code: 'NOT_A_PROFILE' };
    }
    // name：文件值（trim 非空）优先，否则文件名去扩展兜底，再空则 '导入方案'
    const fileValueName = typeof source.name === 'string' ? source.name.trim() : '';
    let name = fileValueName || path.basename(params.filePath, '.json').trim() || '导入方案';
    // 重名：自动追加序号（glm-5.3 → glm-5.3-2 → 再撞 -3 递增，上限 100 次防御），零覆盖既有方案
    const settings = configManager.getSettings();
    const profiles = [...settings.modelProfiles];
    let renamed = false;
    if (profiles.some((item) => item.name === name)) {
      renamed = true;
      let suffix = 2;
      while (suffix <= 100 && profiles.some((item) => item.name === `${name}-${suffix}`)) {
        suffix += 1;
      }
      name = `${name}-${suffix}`;
    }
    newProfile.name = name;
    profiles.push(newProfile);
    saveSetting('modelProfiles', profiles);
    configManager.setSetting('modelProfiles', profiles);
    // 防御性激活补位：仅 activeProfileId 为空时指向新方案（正常态由 config-manager.reload() 保证非空）
    let activeProfileId = settings.activeProfileId;
    if (activeProfileId === '') {
      activeProfileId = newProfile.id;
      saveSetting('activeProfileId', activeProfileId);
      configManager.setSetting('activeProfileId', activeProfileId);
    }
    return { ok: true, profile: newProfile, profiles, activeProfileId, importedCount, skippedCount, renamed };
  });
  // ================================================================
  // 自定义技能处理器（方向2：skills 五通道；内置12标签（主3+执行9）只读锁定，自定义标签/模板管理）
  // ================================================================

  type SkillBuiltinItem = { name: string; title: string; description: string; fileName: string; owner: 'main' | 'executor' };
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
    owner?: string;
    templateContent: string;
  };
  type SkillsMutationResult = { custom: CustomSkillTag[] };
  type SkillDeleteParams = { name: string };

  ipcMain.handle(IPC_SKILLS.LIST, async (): Promise<SkillsListResult> => {
    // 内置13标签只读展示（主4+执行9：按归属分别从主源/执行源注册表组装，含归属字段，不含自定义来源）
    const builtin: SkillBuiltinItem[] = BUILTIN_TASK_TAGS.map((name) => {
      const template = getBuiltinSkillTemplateMeta(name);
      if (!template) {
        throw new Error(`内置技能标签「${name}」未在主源/执行源任一注册表中登记`);
      }
      return {
        name,
        title: template.title,
        description: template.description,
        fileName: template.fileName,
        owner: template.owner,
      };
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
    // owner 归一（缺省/非法值按 'executor' 兜底，与存量懒归一口径一致；枚举硬校验在 validate 内）
    const owner = params?.owner === 'main' ? 'main' : 'executor';
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
      { name, title, description, enabled, owner, templateContent },
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

    const entry: CustomSkillTag = { name, slug, title, description, enabled, owner };
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
        // 内置分支：fileName 必须命中内置模板白名单（主4+执行9 双源合并；防路径穿越；fileName 含同构子目录）
        const allowedFileNames = new Set(listBuiltinSkillTemplateFileNames());
        if (!allowedFileNames.has(key)) {
          return { success: false, error: `内置模板文件名不在白名单内: ${key}` };
        }
        try {
          // 覆写优先：userData/builtin-skill-overrides/<fileName> 存在则读覆写，否则读归属对应内置目录（主源 main-skills／执行源 skills）
          return { success: true, content: await readBuiltinSkillTemplateContent(key) };
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
      // fileName 白名单校验（主4+执行9 双源合并；防路径穿越；仅允许内置13模板的既定 fileName）
      const allowedFileNames = new Set(listBuiltinSkillTemplateFileNames());
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
    // ★ 新版方案 §5.2：任务记录会话随会话删除同步清理（幂等；文件侧随会话目录整体删除）
    clearExecutorTaskRecords(id);
    if (lastActiveConversationId === id) {
      lastActiveConversationId = null;
    }
    await removeConversationUploadDir(id).catch(() => undefined);
    await removeConversationOutputFiles(id).catch(() => undefined);
  });

  // ================================================================
  // 清理对话（会话批量清理）：预览统计 + 执行清理（薄封装）
  // ================================================================

  ipcMain.handle(
    IPC_CONV.CLEANUP_PREVIEW,
    async (_event, params: ConversationCleanupOptions) =>
      computeConversationCleanupPreview(params),
  );

  ipcMain.handle(
    IPC_CONV.CLEANUP,
    async (_event, params: ConversationCleanupOptions) =>
      executeConversationCleanup(params, (id) => {
        // 与 conv:delete 同模式：被清理会话为 lastActive 时置空（重启后返回 null → 场景C退化）
        if (lastActiveConversationId === id) {
          lastActiveConversationId = null;
        }
      }),
  );

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
   * ★ P1-C3：若存在 runningAssistantMessages 中正在流式累积的 assistant 消息，
   *   则附加到返回列表末尾
   *   确保前端 conv:get-messages 在流式过程中也能拉到正在累积的 assistant 消息
   * ★ 分时机落库 D8（方案③3.6/⑥#18）：running 恒优先——running 存在时先从已读列表移除
   *   同 id 库行再附加 running（T-A 落库后库行已含 assistantMessageId，原『id 不在已读行中
   *   才附加』条件会跳过 running，前端只能读到 T-A 半成品库行，流式窗口内丢失实时视图）
   */
  ipcMain.handle(IPC_CONV.GET_MESSAGES, async (_event, conversationId: string) => {
    const list = listRendererMessages(conversationId);

    // ★ P1-C3 + 分时机落库 D8（⑥#18）：running 恒优先替换同 id 库行
    const runningMsg = getRunningAssistantMessage(conversationId);
    if (runningMsg) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if (list[index].id === runningMsg.id) {
          list.splice(index, 1);
        }
      }
      list.push(runningMsg as unknown as typeof list[number]);
    }

    return {
      messages: list,
    };
  });

  /**
   * executor:get-task-record — 任务记录增量查询（新版方案 §5.2-B3；渲染→主，invoke）
   * 无 isRunning 门禁：终态记录在轮末清理前均可查（完成后回看窗口）。
   * 增量规则：seq > sinceSeq 条目 ∪ 当前 running 思考草稿（恒返最新全文）；
   * 服务端 latestSeq < sinceSeq → reset=true（前端整体重置）。
   */
  ipcMain.handle(
    IPC_EXECUTOR.GET_TASK_RECORD,
    (_event, params: import('../types/ipc').ExecutorTaskRecordQueryParams) =>
      queryExecutorTaskRecord(params),
  );

  /**
   * executor:stop-task — 任务级隔离停止（渲染→主，invoke）
   * 双防线校验（session 存在且 running 且 controller 未 aborted）通过后：
   * 同步写入停止文案条目 → 冻结 → 收敛任务终态 → abort 任务级 controller（仅目标任务）。
   *
   * ★ 整体执行收尾判定（右侧任务面板停止入口专属；仅在本会话本次执行内生效）：
   *   - 停止成功后统计同一 conversationId 内仍处于 running 的任务数（stopExecutorTask 已把
   *     被停止任务 markTerminal('aborted')，故该值 = 本次整体执行内剩余未终态任务数）；
   *   - 归零才收尾：经会话级终态通道 abortConversationRun（仅本会话控制器）+
   *     setConversationRunning(false) + conv:updated + MAIN_AGENT_ABORTED_EVENT（→ chat:aborted，
   *     渲染层 useChat / useExecutorTaskRecords 既有终态双保险守卫完成 loading/执行态归一化）；
   *   - 仍有 running 任务时保持整体运行（多任务陆续停止语义：仅最后一个停止才收尾）；
   *   - 重复点击/任务已终态：stopExecutorTask 返回 stopped=false，本判定不执行（幂等）；
   *   - 作用域严格限定 params.conversationId：其他并发会话的任务与执行流零影响；
   *   - 返回契约不变：仍为 { stopped, taskName }（渲染层不消费额外字段）。
   */
  ipcMain.handle(
    IPC_EXECUTOR.STOP_TASK,
    (_event, params: { conversationId: string; delegateCallId: string }) => {
      const result = stopExecutorTask(params.conversationId, params.delegateCallId);
      if (result.stopped && countRunningExecutorTasks(params.conversationId) === 0) {
        // 本次整体执行内已无未终态任务：复用 chat:abort 的会话级终态收敛序列
        // （先 abort 控制器、再复位 is_running 并推送、最后发 aborted 终态信号），
        // 保证渲染层终止态先于 main-agent 真实 settle 到达，杜绝 loading 悬挂。
        if (abortConversationRun(params.conversationId)) {
          emitConversationUpdated(
            mainWindow,
            setConversationRunning(params.conversationId, false),
          );
          eventBus.emit(MAIN_AGENT_ABORTED_EVENT, { conversationId: params.conversationId });
        }
      }
      return result;
    },
  );

  /**
   * executor:send-task-message — 任务级交互消息（渲染→主，invoke）
   * 参数校验 + 会话寻址 + enqueueUserMessage 内聚守卫后入队（时间线排队中条目 + 立即信号）；
   * 注入时机由安全点机制决定（思考段结束/工具批次结束），任务终态未注入消息由 markTerminal 清扫为未送达。
   * 与 stopExecutorTask 同构 (conversationId, delegateCallId) 寻址，不触碰任何会话级事件。
   */
  ipcMain.handle(
    IPC_EXECUTOR.SEND_TASK_MESSAGE,
    (_event, params: { conversationId: string; delegateCallId: string; message: string }) =>
      sendTaskUserMessage(params.conversationId, params.delegateCallId, params.message),
  );

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
   * log:renderer — 渲染端日志转发（R3 修复配套）
   * 渲染端上传失败等异常经此通道落 userData/logs/main.log 持久日志（ERROR 级含 err.message/stack），
   * 不再止于打包版不可见的 console.error。参数做白名单校验，异常不外抛（日志通道自身绝不放大故障）。
   */
  ipcMain.handle(IPC_LOG.RENDERER, async (_event, params: unknown): Promise<void> => {
    const payload = (params ?? {}) as {
      level?: unknown;
      stage?: unknown;
      message?: unknown;
      err?: unknown;
    };
    const level =
      payload.level === 'INFO' || payload.level === 'WARN' || payload.level === 'ERROR'
        ? payload.level
        : 'INFO';
    const stage = typeof payload.stage === 'string' && payload.stage.trim() ? payload.stage.trim().slice(0, 200) : 'renderer';
    const message =
      typeof payload.message === 'string' && payload.message.length ? payload.message : '(empty message)';
    let err: unknown = payload.err;
    if (err !== null && typeof err === 'object' && !('message' in (err as object))) {
      err = undefined; // 无法提取 message 的对象不落 detail，避免 '[object Object]' 噪声
    }
    writeMainLog(level, stage, message, err);
  });

  /**
   * file:upload — 落盘单个文件到 conversations/{id}/uploads/{fileId}.ext
   * 原始展示名写入同名 .json 元数据，storageKey 不再携带用户上传文件名。
   * 文件数限制：单次请求（当前待发送附件列表）上限 MAX_UPLOAD_COUNT=10，由渲染端预检拦截；主进程不按 uploads 目录累计存量拒绝。
   */
  ipcMain.handle(IPC_FILE.UPLOAD, async (_event, params: FileUploadParams): Promise<FileUploadResult> => {
    try {
      // R5：入口非空校验（对齐 ipc-channels.ts 注释承诺；可预期错误带稳定错误码）
      const conversationId =
        typeof params?.conversationId === 'string' ? params.conversationId.trim() : '';
      const originalName =
        typeof params?.name === 'string' ? params.name.trim() : '';
      const data = params?.data;
      const dataEmpty =
        data === undefined ||
        data === null ||
        (typeof data === 'string' && data.length === 0) ||
        (data instanceof ArrayBuffer && data.byteLength === 0) ||
        (ArrayBuffer.isView(data) && data.byteLength === 0) ||
        (Array.isArray(data) && data.length === 0);
      if (!conversationId) {
        throw new Error('[ERR_FILE_UPLOAD_INVALID_PARAMS] conversationId 不能为空');
      }
      if (!originalName) {
        throw new Error('[ERR_FILE_UPLOAD_INVALID_PARAMS] name 不能为空');
      }
      if (dataEmpty) {
        throw new Error('[ERR_FILE_UPLOAD_INVALID_PARAMS] data 不能为空');
      }

      // 客户端上传直接写入当前会话 uploads/ 目录
      const uploadDir = resolveConversationUploadDir(conversationId);
      await mkdir(uploadDir, { recursive: true });

      const fileId = uuidv4();
      const uploadedAt = new Date().toISOString();

      // 先转 buffer；客户端上传按原始文件内容落盘，不做图片压缩。
      // H1 防御：data 为 Base64 字符串时在此解码（兼容旧 ArrayBuffer/Uint8Array/number[] 入参）。
      const rawBuffer = fileInputToBuffer({
        name: originalName,
        data,
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
    } catch (err) {
      // R5：任何一层失败均写入主进程持久日志（ERROR 级）后 rethrow，杜绝静默失败
      writeMainLog(
        'ERROR',
        'file:upload',
        `上传失败 name=${typeof params?.name === 'string' ? params.name : '(unknown)'} conversationId=${typeof params?.conversationId === 'string' ? params.conversationId : '(unknown)'}`,
        err,
      );
      throw err;
    }
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

  // ================================================================
  // 值守模式处理器（阶段2：真实自检 + IMAP 轮询 + list_conversations 查询闭环）
  // ================================================================

  ipcMain.handle(IPC_WATCH.STATUS, async (): Promise<WatchStatusResult> => {
    // 状态反馈数据源：status / enabled / lastError / 水位 / 下次轮询时间 / 已处理数
    return getWatchStatus();
  });

  ipcMain.handle(IPC_WATCH.START, async (): Promise<WatchStartResult> => {
    // 真实自检（IMAP+SMTP）→ 水位初始化 → 写回 watchEnabled=true → 启动递归轮询
    const result = await startWatch();
    // v3 §4.4：无论成败统一刷新主智能体工具清单（阶段3 send_email 工具可见性随此联动）
    refreshMainTools();
    return result;
  });

  ipcMain.handle(IPC_WATCH.STOP, async (): Promise<WatchStopResult> => {
    // 幂等关闭：清定时器、写回 watchEnabled=false、复位状态
    const result = await stopWatch();
    refreshMainTools();
    return result;
  });

  // 值守服务启动入口（app ready 后随 registerIpcHandlers 调用，幂等）：
  // 读 watchEnabled——false 保持关闭零副作用；true 走真实自检（IMAP/SMTP）：
  // 通过则自动恢复运行（INFO watch.resume），失败回落关闭并写 ERROR 日志（watch.resume）。
  // watchEnabled 的服务侧写回经此 notifier 同步刷新主智能体工具清单（v3 §4.4）。
  setWatchEnabledChangeNotifier(() => refreshMainTools());
  startWatchService();

  // 文件选择对话框
  ipcMain.handle(IPC_DIALOG.SHOW_OPEN, async (_event, options: Electron.OpenDialogOptions) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) {
      return { canceled: true, filePaths: [] };
    }
    return dialog.showOpenDialog(win, options);
  });

  // ================================================================
  // 客户端自动更新处理器（v1：检查 / 下载 / 取消 / 安装 / 快照 + 状态推送）
  // 通道字面量：update:check / update:download / update:cancel / update:install / update:get-state / update:state-changed
  // 先 removeHandler 再 handle：mac activate 且窗口为 0 时 registerIpcHandlers 会二次调用，
  // ipcMain.handle 对同一通道重复注册会抛 "second handler"，因此必须幂等注册。
  // ================================================================
  if (updateIpcDispose) {
    updateIpcDispose();
    updateIpcDispose = null;
  }
  const updateChannels = [
    IPC_UPDATE.CHECK,
    IPC_UPDATE.DOWNLOAD,
    IPC_UPDATE.CANCEL,
    IPC_UPDATE.INSTALL,
    IPC_UPDATE.GET_STATE,
  ] as const;
  for (const channel of updateChannels) {
    ipcMain.removeHandler(channel);
  }

  ipcMain.handle(IPC_UPDATE.CHECK, async (_event, params?: UpdateCheckParams) =>
    updateManager.check(params));
  ipcMain.handle(IPC_UPDATE.DOWNLOAD, async (_event, params?: UpdateDownloadParams) =>
    updateManager.download(params));
  ipcMain.handle(IPC_UPDATE.CANCEL, async () => updateManager.cancel());
  ipcMain.handle(IPC_UPDATE.INSTALL, async (_event, params?: UpdateInstallParams) =>
    updateManager.install(params));
  ipcMain.handle(IPC_UPDATE.GET_STATE, async () => updateManager.getSnapshot());

  const unsubscribeUpdateState = updateManager.subscribe((snapshot) => {
    try {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_UPDATE.STATE_CHANGED, snapshot);
      }
    } catch {
      // 窗口销毁瞬间 send 可能抛错，静默忽略（下次注册会重新订阅）
    }
  });
  updateIpcDispose = () => {
    for (const channel of updateChannels) {
      ipcMain.removeHandler(channel);
    }
    unsubscribeUpdateState();
  };

  console.log('[IPC] All handlers registered.');
}
