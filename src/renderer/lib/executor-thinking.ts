/**
 * 子智能体（ExecutorAgent）工具进度模式识别
 * Phase 3 P0-2 适配层：从 ChatMessageContent 提取为公共模块
 * 对齐 E:\ai_fr\components\chat-message-content.tsx L41-45 + L200-228
 *
 * ★ M15 切分策略统一：value.split(/\n{2,}/)（与主进程 executor-tool-progress.ts splitExecutorIntermediate
 * 完全一致；主进程分类窗已按 \n{2,} 语义标注 type，渲染端统一后与主进程分类逐段一致）
 * 任务验收用例：
 *   输入 "思考内容1\n正在调用read_file工具...\n思考内容2\nread_file工具完成，继续处理..."
 *   → thinking = "思考内容1\n思考内容2"
 *   → progress = "正在调用read_file工具...\nread_file工具完成，继续处理..."
 *
 * 用法：
 * - ToolCallCard 加载中：拆分 result 字段为 thinking / progress 两段
 * - ChatMessageContent：拆分 message.thinking 字段为 thinking / progress 两段
 */

import { EXECUTOR_TOOL_PROGRESS_PATTERNS, isExecutorToolProgressText } from '@shared/utils/executor-patterns';

/**
 * 拆分加载中工具内容为思考 / 进度两段
 * @param value 累积的 thinking 文本（多行以 \n 或 \n\n 分隔）
 * @returns { thinking, progress } 两段文本
 */
export function splitLoadingToolContent(value: string): {
  thinking: string;
  progress: string;
} {
  if (!value) {
    return { thinking: '', progress: '' };
  }
  const chunks = value
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const thinkingChunks: string[] = [];
  const progressChunks: string[] = [];
  for (const chunk of chunks) {
    if (isExecutorToolProgressText(chunk)) {
      progressChunks.push(chunk);
    } else {
      thinkingChunks.push(chunk);
    }
  }
  return {
    thinking: thinkingChunks.join('\n'),
    progress: progressChunks.join('\n'),
  };
}
/**
 * 取工具进度段最后一条非空进度行（显示用：仅最新一条，不累积）
 * @param value 累积的 thinking 文本（多行以 \n 或 \n\n 分隔）
 * @returns 最后一条非空进度行；无进度行时返回 ''
 */
export function latestToolProgressText(value: string): string {
  const { progress } = splitLoadingToolContent(value);
  const lines = progress.split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

// ============================================================
// ★ P04 executor 切分增量缓存（根因 R4：每增量对累积全文 O(n) 重复切分，全程 O(n²)
//   → 增量路径摊薄至 O(delta) + O(1) 摊销 join）
//
// 输出等价性（防回归核心）：
//   全量函数把 split 后的最后一段同样以 isExecutorToolProgressText 临时归类输出；
//   Cached 版仅把「已定界段」的结果持久化、把「最后一段（尾段）」照旧每次临时归类——
//   两者的分段边界（\n{2,}）、trim、filter(Boolean)、归类正则、join('\n') 完全一致，
//   故对任意相同输入，Cached 版输出 ≡ splitLoadingToolContent(value)（逐字一致）。
//   尾段以原文留存（不做 trim），仅输出时 trim——保证跨增量追加的字符串拼接无字符丢失
//   （尾随空白+后续增量场景与全量版逐字一致）。
//
// 正确性闸门：输入必须以已处理前缀为前缀（流式追加语义）；否则（M14 accumulated 全量
//   覆盖 / M13 重试复位回退 / 刷新后快照重建）前缀失配 → 全量重算重建缓存，
//   正确性优先于性能。
// ============================================================

interface SplitCacheEntry {
  /** 已确认处理过的输入前缀（= 上一轮完整输入原文；含已定界段 + 上一轮尾段原文） */
  processedPrefix: string;
  /** 已定界（后跟 \n{2,} 边界）的思考段（trim 后，与全量函数输出值一致） */
  doneThinking: string[];
  /** 已定界的进度段（trim 后） */
  doneProgress: string[];
  /** doneThinking.join('\n') 缓存（done 变化时才重算，join O(n) 摊薄） */
  joinedThinking: string;
  /** doneProgress.join('\n') 缓存 */
  joinedProgress: string;
  /** 未定界尾段原文（当前正在生成的段；内部不含 \n{2,}；输出时 trim 后临时归类） */
  tailText: string;
}

/** LRU 上限（按 cacheKey 计，防缓存无界增长；Map 迭代序即 LRU 序） */
const SPLIT_CACHE_LIMIT = 32;
const splitCache = new Map<string, SplitCacheEntry>();

function joinWith(base: string, tail: string): string {
  return base ? `${base}\n${tail}` : tail;
}

/**
 * 全量重算重建缓存（复用与 splitLoadingToolContent 完全同一的分段算法）
 * ★ tailText = split 后最后一个 raw 段原文（可为空串——value 以 \n{2,} 结尾时；
 *   此时全部非空段均已定界进 done，与全量函数 chunks 序列完全一致）
 */
function rebuildFromScratch(value: string): SplitCacheEntry {
  const rawChunks = value.split(/\n{2,}/);
  const doneThinking: string[] = [];
  const doneProgress: string[] = [];
  for (let i = 0; i < rawChunks.length - 1; i++) {
    const t = rawChunks[i].trim();
    if (!t) continue; // 与全量函数 filter(Boolean) 语义一致：空段丢弃
    if (isExecutorToolProgressText(t)) {
      doneProgress.push(t);
    } else {
      doneThinking.push(t);
    }
  }
  const tailText = rawChunks[rawChunks.length - 1] ?? '';
  return {
    processedPrefix: value,
    doneThinking,
    doneProgress,
    joinedThinking: doneThinking.join('\n'),
    joinedProgress: doneProgress.join('\n'),
    tailText,
  };
}

/** LRU 触碰 + 超限逐出（最旧先出） */
function touchLru(cacheKey: string): void {
  const entry = splitCache.get(cacheKey);
  if (entry) {
    splitCache.delete(cacheKey);
    splitCache.set(cacheKey, entry);
  }
  while (splitCache.size > SPLIT_CACHE_LIMIT) {
    const oldest = splitCache.keys().next().value;
    if (oldest === undefined) break;
    splitCache.delete(oldest);
  }
}

/**
 * ★ P04 splitLoadingToolContent 增量缓存版
 * @param cacheKey 流标识级缓存键（如 toolCall.callId / `snap-${taskId}`）——同一键的
 *                 不同轮次内容前缀失配自动全量重算，键复用安全
 * @param value 累积的 thinking 文本（多行以 \n 或 \n\n 分隔）
 * @returns { thinking, progress }——与 splitLoadingToolContent(value) 逐字一致
 */
export function splitLoadingToolContentCached(cacheKey: string, value: string): {
  thinking: string;
  progress: string;
} {
  if (!value) {
    splitCache.delete(cacheKey);
    return { thinking: '', progress: '' };
  }
  let entry = splitCache.get(cacheKey);
  if (!entry || !value.startsWith(entry.processedPrefix)) {
    // 前缀失配（或首次）：全量重算重建缓存
    entry = rebuildFromScratch(value);
    splitCache.set(cacheKey, entry);
    touchLru(cacheKey);
  } else {
    // 增量路径：仅处理新增部分（delta）
    const delta = value.slice(entry.processedPrefix.length);
    const mergedTail = entry.tailText + delta; // 尾段原文（含空串情形）+ 新增
    const rawSegs = mergedTail.split(/\n{2,}/);
    let doneThinking = entry.doneThinking;
    let doneProgress = entry.doneProgress;
    let joinedThinking = entry.joinedThinking;
    let joinedProgress = entry.joinedProgress;
    let settledCount = 0;
    for (let i = 0; i < rawSegs.length - 1; i++) {
      const t = rawSegs[i].trim();
      if (!t) continue; // 空段丢弃（与全量函数 filter(Boolean) 一致）
      settledCount++;
      if (isExecutorToolProgressText(t)) {
        doneProgress = [...doneProgress, t];
      } else {
        doneThinking = [...doneThinking, t];
      }
    }
    const newTail = rawSegs[rawSegs.length - 1] ?? ''; // 新尾段原文留存（输出时 trim）
    if (settledCount > 0) {
      joinedThinking = doneThinking.join('\n');
      joinedProgress = doneProgress.join('\n');
    }
    entry = {
      processedPrefix: value,
      doneThinking,
      doneProgress,
      joinedThinking,
      joinedProgress,
      tailText: newTail,
    };
    splitCache.set(cacheKey, entry);
    touchLru(cacheKey);
  }
  // 输出：尾段每次以当前完整原文 trim 后重新分类（临时归类），与全量函数同构
  const tail = entry.tailText.trim();
  const tailIsProgress = tail ? isExecutorToolProgressText(tail) : false;
  return {
    thinking: tail && !tailIsProgress ? joinWith(entry.joinedThinking, tail) : entry.joinedThinking,
    progress: tail && tailIsProgress ? joinWith(entry.joinedProgress, tail) : entry.joinedProgress,
  };
}

/**
 * ★ P04 latestToolProgressText 增量缓存版（与 splitLoadingToolContentCached 共享同一缓存条目）
 * @returns 最后一条非空进度行；无进度行时返回 ''（与全量版逐字等价）
 */
export function latestToolProgressTextCached(cacheKey: string, value: string): string {
  const { progress } = splitLoadingToolContentCached(cacheKey, value);
  const lines = progress.split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}
