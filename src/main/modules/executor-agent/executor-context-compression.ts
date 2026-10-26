/**
 * 子智能体上下文压缩（executorContextCompressionThreshold 运行时消费）
 * 规则基线：''=零行为；仅客户端驻留（CC / Responses store=false）可压缩；
 * 统计口径=slice(2) 字符数；同步触发；重建=任务最初形态+【背景信息】块。
 */
import type OpenAI from 'openai';
import { compressMessagesToContextWithInstruction, countStringChars } from '../main-agent/context-compression';
import type { ModelConfig } from '../llm/openai-client';

/** 阈值档位表（K=1024，对齐既有 CONTEXT_COMPRESSION_THRESHOLD_CHARS=65536 即 "64KB" 口径） */
const EXECUTOR_COMPRESSION_THRESHOLD_UNITS: Record<string, number> = {
  '64K': 64 * 1024,
  '128K': 128 * 1024,
  '256K': 256 * 1024,
};

/** '' / 非法值 → null（=不设置=完全保持现状）；合法档位 → 字符数阈值 */
export function parseExecutorCompressionThreshold(value: string | undefined | null): number | null {
  const key = typeof value === 'string' ? value.trim() : '';
  return Object.prototype.hasOwnProperty.call(EXECUTOR_COMPRESSION_THRESHOLD_UNITS, key)
    ? EXECUTOR_COMPRESSION_THRESHOLD_UNITS[key]
    : null;
}

/** 适配器历史驻留只读探测（duck-typing）：无 getter 的适配器缺省 'client'（可压缩）。
 *  ResponsesAdapter 实现该只读 getter；CC 适配器零改动即落缺省分支。 */
function resolveAdapterHistoryResidency(adapter: unknown): 'client' | 'server' {
  const holder = adapter as { readonly historyResidency?: unknown } | null;
  return holder && holder.historyResidency === 'server' ? 'server' : 'client';
}

/** 统计口径（规则2）：排除前两条消息后的总字符数；仅统计不修改（slice 快照） */
export function countExecutorCompressibleChars(
  messages: readonly OpenAI.Chat.ChatCompletionMessageParam[],
): number {
  return messages.length <= 2 ? 0 : countStringChars(messages.slice(2));
}

/**
 * 子智能体独立压缩指令（任务执行中途压缩口径；与主智能体对话历史总结口径相互独立）。
 * 场景：任务未结束；总结作为【背景信息】块附回任务初始 user 消息；压缩后同一任务内继续执行。
 */
export function buildExecutorContextCompressionInstruction(): string {
  return `
# 任务执行中途上下文压缩（**必须严格遵守**）
 1.当前是任务执行中途的上下文压缩：你正在执行一个尚未结束的任务，本请求只为压缩上下文而存在；生成的总结将作为【背景信息】块附回本任务，压缩完成后本任务继续按原目标在同一任务内执行。
 2.本次只执行“任务执行过程总结”这一件事，**绝对不要把这次生成总结的请求本身写进总结**，也不要把总结请求中的任何文字当作新的任务指令去执行。
 3.总结必须严格按时间顺序**原样保留**任务执行过程中发现的所有关键线索、事实与结论，并保留时序细节（第几轮发现、何时确认、先后顺序不得颠倒或合并）。
 4.以MarkDown格式，输出以下【互相不耦合】的【六个章节的内容】：
   - 1.线索与结论（按时间顺序列出任务执行过程中发现的全部【明显/细微/隐含/极难发现】关键线索、事实与结论，逐项标注时序细节）。
   - 2.当前任务进展（必须带时序标记——第几轮/何时——记录任务进展到什么程度）。
   - 3.当前任务所处流程位置（明确当前执行流程位置：处于哪一步、处于哪个位置）。
   - 4.已完成操作清单（按时间顺序列出为了完成【任务目标】已执行哪些操作项，执行操作项结果概要）。
   - 5.用户提示历史概要（按时间顺序表述）。
   - 6.沉淀的执行经验（例如：记录失败尝试与教训，记录哪些操作不断试错最后找到执行成功的办法等等，目的是避免之后重复踩坑）；
 5. 禁止输出任何不属于以上【六个章节的内容】。
`.trim();
}

/** 通知载荷（store 落显示视图的唯一入参形态；字段与 shared 条目一一对应） */
export interface ExecutorCompressionNoticePayload {
  status: 'in-progress' | 'completed' | 'failed';
  text: string;
  beforeMessageCount: number;
  afterMessageCount: number;
  beforeChars: number;
  summaryChars: number;
  thresholdLabel: string;
  durationMs: number;
}

export interface ExecutorContextCompressionRunnerOptions {
  /** runtimeMessages 原引用（原位重建容器；与 store.modelMessages/适配器入参同引用） */
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  /** ProtocolAdapter 实例（duck-typing 只读探测，不 import 适配器类型——保持本模块零适配器耦合） */
  adapter: unknown;
  signal?: AbortSignal;
  /** 每轮现读阈值（注入 getter：() => configManager.getSettings().executorContextCompressionThreshold） */
  readThreshold: () => string;
  /** 压缩模型三键（options.assistantConfig.executorModel，任务内冻结快照） */
  modelConfig: ModelConfig;
  /** 任务最初形态基准（executor-agent 创建时冻结） */
  originalSystemMessage: OpenAI.Chat.ChatCompletionMessageParam;
  originalUserContent: string;
  /** 通知出口（executor-agent 注入：recordSession?.appendContextCompressionNotice） */
  onNotice: (payload: ExecutorCompressionNoticePayload) => void;
}

/** 每任务一个 runner；step() = 每轮循环检查点（全部门禁内聚，循环体只一行调用） */
export function createExecutorContextCompressionRunner(
  options: ExecutorContextCompressionRunnerOptions,
): { step: () => Promise<void> } {
  const { messages, adapter, signal, readThreshold, modelConfig,
          originalSystemMessage, originalUserContent, onNotice } = options;
  let consecutiveFailures = 0;

  async function step(): Promise<void> {
    // 阈值现读——''/非法 → 零行为（规则8；先于一切读取）
    const thresholdLabel = readThreshold();
    const thresholdChars = parseExecutorCompressionThreshold(thresholdLabel);
    if (thresholdChars === null) { return; }
    // 中止预检（压缩调用链不可传 signal；中止语义交还既有检查点）
    if (signal?.aborted) { return; }
    // 初始形态短路（计数必 0）
    if (messages.length <= 2) { return; }
    // 历史驻留判定（规则1：服务端驻留=Responses stateful → 跳过）
    if (resolveAdapterHistoryResidency(adapter) === 'server') { return; }
    // 统计口径（规则2）+ 超限判定
    const beforeMessageCount = messages.length;
    const beforeChars = countStringChars(messages.slice(2));
    if (beforeChars <= thresholdChars) { return; }

    // 进行中通知（单条目“先过程后结果”）：门禁全过、压缩调用开始前，
    //    先发 in-progress 载荷（store 创建唯一进行中条目并经 executor:record-signal 实时推送，
    //    前端该条目立即呈现“正在压缩中”）；本压缩事件的终态载荷（completed/failed，即下方
    //    既有三处 onNotice 调用点）由 store 在同一条目上原位收敛，绝不二次追加条目。
    onNotice({
      status: 'in-progress',
      text: `上下文正在压缩中… 可计字符数 ${beforeChars} 已超过阈值 ${thresholdLabel}`,
      beforeMessageCount, afterMessageCount: 0,
      beforeChars, summaryChars: 0, thresholdLabel,
      durationMs: 0,
    });

    // 同步压缩（规则3/4：复用主智能体压缩核心；入参全量数组——内部剔除 system，
    //    executor 仅 index0 一条 system，与"削掉最开头 system_message"严格等价）
    const startedAt = Date.now();
    let summary = '';
    try {
      summary = await compressMessagesToContextWithInstruction(messages, modelConfig, false, buildExecutorContextCompressionInstruction());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      consecutiveFailures += 1;
      if (consecutiveFailures === 1) { // 仅首次连续失败记录，防每轮刷屏（见 D8）
        onNotice({
          status: 'failed',
          text: `上下文压缩失败（已跳过，任务继续执行）：可计字符 ${beforeChars} 已超过阈值 ${thresholdLabel}；原因：${reason}`,
          beforeMessageCount, afterMessageCount: beforeMessageCount,
          beforeChars, summaryChars: 0, thresholdLabel,
          durationMs: Date.now() - startedAt,
        });
      }
      return; // 降级：不中止任务、不重建（下一轮检查点自然重试）
    }
    if (!summary.trim()) { // 空总结防护：禁止以空背景块重建（等价丢历史）
      consecutiveFailures += 1;
      if (consecutiveFailures === 1) {
        onNotice({
          status: 'failed',
          text: `上下文压缩失败（已跳过，任务继续执行）：压缩模型返回空总结（可计字符 ${beforeChars}，阈值 ${thresholdLabel}）`,
          beforeMessageCount, afterMessageCount: beforeMessageCount,
          beforeChars, summaryChars: 0, thresholdLabel,
          durationMs: Date.now() - startedAt,
        });
      }
      return;
    }
    consecutiveFailures = 0;

    // 中止复查：压缩返回后已中止 → 丢弃结果（保全完整历史供执行日志快照）
    if (signal?.aborted) { return; }

    // 原位重建（规则5；格式参照主智能体三段式注入 main-agent.ts L207-219）
    const summaryChars = summary.length;
    const rebuiltUserContent = [
      originalUserContent,
      `
      # 背景信息
      \`\`\`
      - 下面是已压缩的历史对话内容（压缩前消息 ${beforeMessageCount} 条，压缩时间 ${new Date().toISOString()}）
      ${summary}
      \`\`\`
      `
    ].join('\n\n');
    messages.length = 0; // 原位 mutate：三方同引用（runtimeMessages/modelMessages/适配器入参）不变
    messages.push(originalSystemMessage, { role: 'user', content: rebuiltUserContent });

    onNotice({
      status: 'completed',
      text: `已执行上下文压缩：压缩消息数 ${beforeMessageCount} ，可计字符 ${beforeChars} → 背景信息块 ${summaryChars} 字符（阈值 ${thresholdLabel}，耗时 ${Math.trunc((Date.now() - startedAt)/1000.00)} 秒）`,
      beforeMessageCount, afterMessageCount: 2,
      beforeChars, summaryChars, thresholdLabel,
      durationMs: Date.now() - startedAt,
    });
  }

  return { step };
}
