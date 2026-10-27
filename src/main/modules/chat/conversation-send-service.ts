/**
 * conversation-send-service — 值守链路会话发送服务（阶段3）
 *
 * 职责（v3 §3.4 复用清单的落地；阶段3回执单轨调整后仍完全适用）：
 * - sendUserMessageIntoConversation(conversationId, message)：把 message 字符串
 *   【原样】作为单条 role='user' 消息写入目标会话并驱动主智能体——零加工原则
 *   （零前缀/零后缀/零包裹/零拼接，任何程序生成文本不得进入消息本体）；
 *   对大模型而言与用户在界面手动发送这条消息完全不可区分。
 * - 复刻 chat:send（ipc-handlers.ts ipcMain.handle(IPC_CHAT.SEND) 闭包，L347-468）
 *   的完整时序，但不改道、不复用该闭包（ipcMain.handle 闭包不可直接调用；本服务
 *   与其共用同一把会话闸门，互斥但互不污染）：
 *     1. beginConversationRun 取并发闸门（null → ERR_WATCH_CONVERSATION_RUNNING）
 *     2. 主模型 API Key 非空校验（→ ERR_WATCH_MAIN_MODEL_NOT_CONFIGURED）；
 *        阶段7 起该项与后续模型配置一律取「会话绑定方案优先」的本次 run 快照
 *        （conversation-model-profile.resolveConversationModelConfig）
 *     3. ensureConversation 确保会话存在（指令侧已校验，此处兜底）
 *     4. setConversationRunning(true) + 推送 IPC_CONV.UPDATED（emitConversationUpdated
 *        为 ipc-handlers 模块私有不可复用；本服务经 BrowserWindow.getAllWindows()
 *        向全部未销毁窗口发送同构载荷，单窗口应用行为等价）
 *     5. runMainAgent（传参与 chat:send 完全一致；uploadedFiles 为空数组；
 *        assistantMessageId 不传由 runMainAgent 内部生成）
 *     6. 取消语义：catch 中 ERR_ABORTED 或 signal.aborted 一律吞错收敛
 *     7. finally：finishConversationRun 实例归属校验通过后 setConversationRunning(false)
 *        + 推送（归属校验失败=条目已不归属本次 run，不得触碰 is_running 与列表态）
 *     8. 30 分钟硬超时（v3 §6.5 ERR_WATCH_EXEC_TIMEOUT）：经 abortConversationRun
 *        以同一 signal 触发（复用既有取消链路，runMainAgent 收敛为 ERR_ABORTED）。
 * - 回执单轨（时序1）：本服务只负责注入与执行，runMainAgent 终态后不做任何服务端
 *   回执动作；任务回执唯一通道=主智能体经 send_email 工具发送。
 * - 失败分类（供 watch-service 区分注入前协议层失败与执行期失败）：
 *   注入前：ERR_WATCH_CONVERSATION_RUNNING / ERR_WATCH_MAIN_MODEL_NOT_CONFIGURED
 *   执行期：ERR_WATCH_EXEC_ABORTED（含 30 分钟硬超时）/ ERR_WATCH_EXEC_FAILED
 */

import { BrowserWindow } from 'electron';
import { IPC_CONV } from '@shared/ipc-channels';
import { resolveConversationModelConfig } from '../config/conversation-model-profile';
import { ensureConversation, setConversationRunning } from '../../db';
import type { ConversationRecord } from '../../db/types';
import { runMainAgent } from '../main-agent/main-agent';
import {
  abortConversationRun,
  beginConversationRun,
  finishConversationRun,
} from './conversation-runtime';
import { ERR_ABORTED } from '../../constants';

/** 单轮执行硬超时（v3 §6.5：30 分钟） */
const WATCH_EXEC_HARD_TIMEOUT_MS = 30 * 60_000;

/** 值守链路发送结果（watch-service 消费） */
export type WatchSendMessageOutcome =
  | { ok: true; content: string; messageId: string; durationMs: number }
  | { ok: false; code: string; message: string };

/** 推送会话状态变化（与 ipc-handlers.emitConversationUpdated 同构：单窗口应用等价） */
function emitConversationUpdatedFromWatch(conversation: ConversationRecord | null): void {
  if (!conversation) {
    return;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CONV.UPDATED, { conversation });
    }
  }
}

/**
 * 把 message 原样写入指定会话并驱动主智能体（值守链路唯一注入入口）。
 * @param conversationId 目标会话 ID（调用方已校验存在）
 * @param message        指令邮件解析出的输入消息原文（原样传入，零加工）
 */
export async function sendUserMessageIntoConversation(
  conversationId: string,
  message: string,
): Promise<WatchSendMessageOutcome> {
  // 1. 并发闸门：与 chat:send 共用同一把（beginConversationRun），同会话互斥
  const abortController = beginConversationRun(conversationId);
  if (!abortController) {
    return { ok: false, code: 'ERR_WATCH_CONVERSATION_RUNNING', message: '目标会话正在运行中（会话闸门互斥），本轮指令未注入' };
  }

  // 30 分钟硬超时：经同一 signal 触发（abortConversationRun → controller.abort(ERR_ABORTED)）
  const hardTimeoutHandle = setTimeout(() => {
    abortConversationRun(conversationId);
  }, WATCH_EXEC_HARD_TIMEOUT_MS);

  try {
    // 2. 主模型 API Key 校验（对齐 chat:send：闸门之后、try 内，finally 统一释放）
    //    阶段7 目标1：按「会话绑定方案优先」解析本次 run 的配置快照；未绑定时懒绑定当前激活方案，
    //    无任何方案时回落全局 14 键（等价阶段6 行为）。快照语义 → 运行中切方案不影响本次 run。
    const modelResolution = resolveConversationModelConfig(conversationId);
    const runSettings = modelResolution.settings;
    const mainModelApiKey = runSettings.mainModelApiKey;
    if (!mainModelApiKey || mainModelApiKey.trim() === '') {
      return { ok: false, code: 'ERR_WATCH_MAIN_MODEL_NOT_CONFIGURED', message: '主模型 API Key 未配置，请在设置中配置 API Key' };
    }

    // 3. 确保会话存在（指令侧已按 conversations 表校验存在，此处幂等兜底）
    ensureConversation(conversationId);

    // 4. 标记运行态并推送（setConversationRunning(true) + IPC_CONV.UPDATED）
    emitConversationUpdatedFromWatch(setConversationRunning(conversationId, true));

    // 5. 执行主智能体（传参字段与取值来源与 chat:send 完全一致；uploadedFiles 为空数组；
    //    用户消息 = message 原文，单条 role='user'，零加工；模型配置取本次 run 的快照）
    const settings = runSettings;
    const result = await runMainAgent({
      conversationId,
      userMessage: message,
      modelConfig: {
        baseUrl: settings.mainModelBaseUrl,
        apiKey: settings.mainModelApiKey,
        model: settings.mainModelName,
      },
      assistantConfig: {
        mainModel: {
          baseUrl: settings.mainModelBaseUrl,
          apiKey: settings.mainModelApiKey,
          model: settings.mainModelName,
        },
        executorModel: {
          baseUrl: settings.executorModelBaseUrl,
          apiKey: settings.executorModelApiKey,
          model: settings.executorModelName,
        },
      },
      visionModelConfig: {
        baseUrl: settings.visionLlmBaseUrl,
        apiKey: settings.visionLlmApiKey,
        model: settings.visionLlmModel,
      },
      // 视觉识别总开关联动（对齐 chat:send：visionEnabled=false 时主智能体多模态强制关闭）
      mainAgentMultimodalEnabled: settings.visionEnabled && settings.mainModelMultimodal,
      uploadedFiles: [],
      signal: abortController.signal,
    });

    // 终态即返回（runMainAgent 返回值 MainAgentResult.content 是回执正文唯一可靠来源，
    // B27/B42：不能以 ASSISTANT_MESSAGE_DONE_EVENT 判完成）——服务端不做任何回执动作（单轨）
    return { ok: true, content: result.content, messageId: result.messageId, durationMs: result.durationMs };
  } catch (error) {
    // 6. 取消语义：ERR_ABORTED 或 signal.aborted 一律吞错收敛（对齐 chat:send catch；
    //    30 分钟硬超时同样经此路径收敛为中止）
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg === ERR_ABORTED || abortController.signal.aborted) {
      return { ok: false, code: 'ERR_WATCH_EXEC_ABORTED', message: '执行已中止（含 30 分钟硬超时触发），本轮未产生最终回复' };
    }
    return { ok: false, code: 'ERR_WATCH_EXEC_FAILED', message: errMsg };
  } finally {
    clearTimeout(hardTimeoutHandle);
    // 7. 闸门释放：实例归属校验通过才复位 is_running 并推送（对齐 chat:send finally）
    if (finishConversationRun(conversationId, abortController)) {
      emitConversationUpdatedFromWatch(setConversationRunning(conversationId, false));
    }
  }
}
