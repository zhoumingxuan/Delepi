/**
 * 上下文压缩任务层
 * 适配自参考项目 E:\\ai_fr\\lib\\chat\\context-compression-task.ts
 * 适配：
 *   1. 本项目无 userId 概念，简化参数（仅 conversationId）
 *   2. 本项目无环境变量配置阈值，硬编码 64KB
 *   3. 本项目 context_compressions 表已存在，复用 schema
 *
 * 与 context-compression.ts 的区别：
 *   - context-compression.ts：核心压缩函数（无状态、无重试、无持久化）
 *   - context-compression-task.ts（本文件）：任务层（持久化 + 重试 + 条件判断）
 */

import OpenAI from 'openai';
import {
  completeContextCompression,
  deleteContextCompression,
  getLatestCompletedContextCompression as getLatestCompletedContextCompressionRecord,
  startContextCompression,
} from '../../db';
import { compressMessagesToContext, countStringChars } from './context-compression';
import { sleepBeforeRetry } from '../llm/model-retry';
import type { ModelConfig } from '../llm/openai-client';

/** 重试次数上限（适配 E:\\ai_fr） */
const CONTEXT_COMPRESSION_RETRY_LIMIT = 3;
/** 重试延迟（毫秒，适配 E:\\ai_fr） */
const CONTEXT_COMPRESSION_RETRY_DELAY_MS = 10_000;
/** 压缩阈值（字符数）—— 本项目硬编码 64KB */
export const CONTEXT_COMPRESSION_THRESHOLD_CHARS = 65536;

/** 上下文压缩触发选项 */
export interface RunCompressionOptions {
  /** 主模型配置（用于压缩调用） */
  modelConfig: ModelConfig;
  /** 当前消息最大 seq */
  maxMessageSeq: number;
  /** 待压缩的消息列表 */
  messages: readonly OpenAI.Chat.ChatCompletionMessageParam[];
  /** 是否启用多模态 */
  multimodalEnabled: boolean;
  /** 当前输入是否包含图片（用于图片模式强制压缩） */
  currentInputHasImage: boolean;
}

/**
 * 查询最新的已完成的压缩记录
 * 用于下次对话时构造 messages（替代 E:\\ai_fr 的 context_compressions 查询）
 *
 * @param conversationId - 对话 ID
 * @param beforeSeq - 查询的 seq 上界（必须 < 此 seq）
 * @returns 压缩记录或 null
 */
export function getLatestCompletedContextCompression(
  conversationId: string,
  beforeSeq: number,
): { id: string; maxMessageSeq: number; contextText: string } | null {
  return getLatestCompletedContextCompressionRecord(conversationId, beforeSeq);
}

/**
 * 触发上下文压缩（如需要）
 * 适配自 E:\\ai_fr\\lib\\chat\\context-compression-task.ts runContextCompressionIfNeeded
 *
 * 触发条件：
 *   1. 图片模式强制压缩：multimodalEnabled && currentInputHasImage
 *   2. 字符阈值触发：消息字符数 > CONTEXT_COMPRESSION_THRESHOLD_CHARS
 * 持久化：写入 context_compressions 表
 * 重试：失败时最多重试 3 次，间隔 10 秒
 *
 * @param conversationId - 对话 ID
 * @param options.modelConfig - 主模型配置（用于压缩调用）
 * @param options.maxMessageSeq - 当前消息最大 seq
 * @param options.messages - 待压缩的消息列表
 */
export async function runContextCompressionIfNeeded(
  conversationId: string,
  options: RunCompressionOptions,
): Promise<void> {
  if (!options.messages.length) {
    return;
  }

  // 图片模式强制压缩：多模态启用且当前输入包含图片 → 无条件触发
  const forceByImage = options.multimodalEnabled && options.currentInputHasImage;

  if (!forceByImage && countStringChars(options.messages) <= CONTEXT_COMPRESSION_THRESHOLD_CHARS) {
    return;
  }

  for (let attempt = 0; attempt <= CONTEXT_COMPRESSION_RETRY_LIMIT; attempt += 1) {
    const compressionId = startContextCompression(
      conversationId,
      options.maxMessageSeq,
    );

    if (!compressionId) {
      // 已有 completed 记录
      return;
    }

    try {
      const contextText = await compressMessagesToContext(
        options.messages,
        options.modelConfig,
        options.multimodalEnabled,
      );
      completeContextCompression(conversationId, compressionId, contextText);
      return;
    } catch (error) {
      deleteContextCompression(conversationId, compressionId);

      if (attempt >= CONTEXT_COMPRESSION_RETRY_LIMIT) {
        throw error;
      }

      await sleepBeforeRetry(CONTEXT_COMPRESSION_RETRY_DELAY_MS);
    }
  }
}
