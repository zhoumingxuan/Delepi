/**
 * createProtocolAdapter - 适配器工厂（两分支，无方言注册表）+ 协议选择（用户指定/探查降级）
 *
 * A3 定案重申：v1.0"门面+resolveAdapter 路由+方言表+归一化"组织方式已被推翻；
 * CC 方言差异由现状 buildThinkingParams 承载（openai-client.ts L161-188），方言化留待
 * CC 适配器内部未来演进。
 *
 * 协议选择（2026-10-08 用户拍板）：主/子智能体各自经 AppSettings.mainModelProtocol /
 * executorModelProtocol 显式指定协议（'cc'=Chat Completion，'responses'=Response API，
 * 默认 'cc'）——指定协议时按用户指定构造对应适配器并 await init，init 失败直接抛
 * ModelApiAbortError（禁止自动降级，用不了就换一个协议由用户自己换）；protocol 未
 * 传入/为空时保持原协议探查降级链——先创建 ResponsesAdapter 并 await init（init 内
 * POST 探 {baseUrl}/responses），返回失败则降级创建 ChatCompletionsAdapter 并 await
 * init（探 {baseUrl}/chat/completions）；两级均失败 = 请求大模型 API 完全失败，抛
 * ModelApiAbortError（携带两次探查失败原因）交调用方既有错误面处理。
 * createProtocolAdapter 保留为纯构造入口（无网络、无探查，回归测试 harness 沿用）。
 *
 * Coding Plan 端点防呆（A3 RK-6）：protocol='responses' 且 baseUrl 含 coding 特征时
 * 输出警告日志——智谱官方声明 Coding Plan 暂只支持 CC 协议，误配将全量失败。
 */

import type { ProtocolAdapter, AdapterInitConfig, AdapterInitResult } from './protocol-adapter';
import { ChatCompletionsAdapter } from './chat-completions-adapter';
import { ResponsesAdapter } from './responses-adapter';
import { ModelApiAbortError } from '../model-retry';

export type AdapterProtocol = 'cc' | 'responses';

export function createProtocolAdapter(
  protocol: AdapterProtocol | undefined,
): ProtocolAdapter {
  const resolved: AdapterProtocol = protocol ?? 'cc';
  if (resolved === 'responses') {
    return new ResponsesAdapter();
  }
  return new ChatCompletionsAdapter();
}

/** 协议初始化结果：实际生效适配器 + 实际生效协议（warnCodingPlanMismatch 等消费） */
export interface AdapterProtocolSetup {
  adapter: ProtocolAdapter;
  protocol: AdapterProtocol;
}

/**
 * 协议初始化（2026-10-08 用户拍板）：protocol 显式传入（'cc' | 'responses'）时按用户
 * 指定构造对应适配器并 await init（init 内 POST 探端点，404=协议不支持=初始化失败）；
 * init 失败即抛 ModelApiAbortError 交调用方既有错误面——禁止自动降级到另一协议（用户
 * 拍板：用不了就换一个协议，由用户自己换）。主链路 runMainAgent catch →
 * MAIN_AGENT_ERROR_EVENT；执行链路 runDelegatedTask catch → saveExecutionLogOnError
 * 后 rethrow → 主链路委派失败消息化。初始化失败的实例立即 close 释放（幂等），不残留
 * 可用假象。
 * protocol 未传入/为空时走原协议探查降级链：先 Responses 后 CC 两级 await init（init
 * 内各自 POST 探端点，404=协议不支持=初始化失败）；任一成功即返回该实例；两级均失败
 * = 请求大模型 API 完全失败——抛 ModelApiAbortError（message 携带两次探查失败原因）。
 */
export async function initAdapterWithFallback(
  config: AdapterInitConfig,
  protocol?: AdapterProtocol,
): Promise<AdapterProtocolSetup> {
  config?.signal?.throwIfAborted();
  const initCandidate = async (candidate: ProtocolAdapter): Promise<AdapterInitResult> => {
    try {
      const result = await candidate.init(config);
      config?.signal?.throwIfAborted();
      if (!result.success) candidate.close();
      return result;
    } catch (error) {
      candidate.close();
      throw error;
    }
  };
  if (protocol === 'cc' || protocol === 'responses') {
    // 用户指定协议：仅构造并 init 对应适配器（createProtocolAdapter 纯构造），init 失败
    // 即抛 ModelApiAbortError——禁止自动降级到另一协议，交调用方既有错误面处理
    const adapter = createProtocolAdapter(protocol);
    const init = await initCandidate(adapter);
    if (init.success) {
      return { adapter, protocol };
    }
    throw new ModelApiAbortError({
      cause: null,
      retryCount: 0,
      message: `请求大模型 API 失败：指定协议 ${protocol === 'cc' ? 'Chat Completion' : 'Response API'} 初始化未通过——${init.message ?? '未知原因'}（协议由用户在配置界面自选，不自动降级；用不了请更换协议）`,
    });
  }
  const responsesAdapter = new ResponsesAdapter();
  const responsesInit = await initCandidate(responsesAdapter);
  if (responsesInit.success) {
    return { adapter: responsesAdapter, protocol: 'responses' };
  }
  config?.signal?.throwIfAborted();
  const ccAdapter = new ChatCompletionsAdapter();
  const ccInit = await initCandidate(ccAdapter);
  if (ccInit.success) {
    return { adapter: ccAdapter, protocol: 'cc' };
  }
  throw new ModelApiAbortError({
    cause: null,
    retryCount: 0,
    message: `请求大模型 API 完全失败：协议探查降级链两级均未通过——Responses：${responsesInit.message ?? '未知原因'}；Chat Completions：${ccInit.message ?? '未知原因'}`,
  });
}

/** Coding Plan 端点防呆检查（工厂侧统一告警；返回是否命中警告） */
export function warnCodingPlanMismatch(
  protocol: AdapterProtocol | undefined,
  baseUrl: string,
): boolean {
  if (protocol === 'responses' && typeof baseUrl === 'string' && baseUrl.toLowerCase().includes('coding')) {
    // eslint-disable-next-line no-console
    console.warn(
      '[adapter-factory] 检测到 protocol=responses 且 baseUrl 含 coding 特征：智谱官方声明 Coding Plan 端点暂只支持 CC 协议，误配将全量失败（A3 RK-6）',
    );
    return true;
  }
  return false;
}
