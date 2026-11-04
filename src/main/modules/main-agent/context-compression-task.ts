/**
 * 上下文压缩任务层
 * 
 * 职责边界：
 *   1. 单用户架构：参数仅 conversationId
 *   2. 压缩阈值硬编码 64KB
 *   3. 本项目 context_compressions 表已存在，复用 schema
 *
 * 与 context-compression.ts 的区别：
 *   - context-compression.ts：核心压缩函数（无状态、无重试、无持久化）
 *   - context-compression-task.ts（本文件）：任务层（持久化 + 单次尝试 + 条件判断）
 */

import OpenAI from 'openai';
import {
  completeContextCompression,
  deleteContextCompression,
  getLatestCompletedContextCompression as getLatestCompletedContextCompressionRecord,
  startContextCompression,
} from '../../db';
import { compressMessagesToContext, countStringChars } from './context-compression';
import type { ModelConfig } from '../llm/openai-client';

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
  /** 中止信号：中止会话时立即终止本次压缩调用（单次尝试，无重试、无后台残留） */
  signal?: AbortSignal;
}

/**
 * 查询最新的已完成的压缩记录
 * 用于下次对话时构造 messages（构造 messages）
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
 * 
 *
 * 触发条件：
 *   1. 图片模式强制压缩：multimodalEnabled && currentInputHasImage
 *   2. 字符阈值触发：排除头两条消息（system_message+首个 user_message）后的消息字符数 > CONTEXT_COMPRESSION_THRESHOLD_CHARS
 * 持久化：写入 context_compressions 表
 * 失败语义：单次尝试，失败即终态（删除记录 + 记录日志），不做任何层级重试，
 *           待下次对话轮触发阈值时以新快照再压缩
 *
 * @param conversationId - 对话 ID
 * @param options.modelConfig - 主模型配置（用于压缩调用）
 * @param options.maxMessageSeq - 当前消息最大 seq
 * @param options.messages - 待压缩的消息列表
 * @param options.signal - 中止信号（中止会话时立即终止压缩调用）
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

  // 字符阈值触发计数口径（对齐 executor-context-compression 的 slice(2) 口径）：排除头两条消息
  // （index 0=system_message、index 1=首个 user_message），仅统计其余消息的字符总数；
  // slice(2) 只取计数快照，绝不改动 messages 数组本身（长度/顺序/元素内容与引用均不变）
  if (!forceByImage && countStringChars(options.messages.slice(2)) <= CONTEXT_COMPRESSION_THRESHOLD_CHARS) {
    return;
  }

  // 中止预检：会话已中止则不启动压缩（不落 running 行、不发起任何模型调用）
  if (options.signal?.aborted) {
    return;
  }

  // 单次尝试（失败即终态）：取号 → 单次压缩调用 → 成功置 completed 并结束；
  // 失败 = 删除记录 + 记录日志后直接结束，不做任何层级重试（无任务层循环、无 API 级重试），
  // 待下次对话轮触发阈值时以新快照再压缩。
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
      options.signal,
    );
    completeContextCompression(conversationId, compressionId, contextText);
  } catch (error) {
    deleteContextCompression(conversationId, compressionId);
    console.error(
      '[context-compression] 上下文压缩失败（单次尝试，不重试；已删除记录，待下次对话轮触发再压缩）:',
      error,
    );
  }
}
