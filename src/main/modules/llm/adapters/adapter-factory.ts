/**
 * createProtocolAdapter - 适配器工厂（两分支，无方言注册表）+ 协议探查降级链
 *
 * A3 定案重申：v1.0"门面+resolveAdapter 路由+方言表+归一化"组织方式已被推翻；
 * CC 方言差异由现状 buildThinkingParams 承载（openai-client.ts L161-188），方言化留待
 * CC 适配器内部未来演进。
 *
 * 协议探查降级链（目标三，用户拍板）：协议选择不再读取 settings.modelProtocol——
 * 先创建 ResponsesAdapter 并 await init（init 内 POST 探 {baseUrl}/responses），返回
 * 失败则创建 ChatCompletionsAdapter 并 await init（探 {baseUrl}/chat/completions）；
 * 两级均失败 = 请求大模型 API 完全失败，抛 ModelApiAbortError（携带两次探查失败
 * 原因）交调用方既有错误面处理。createProtocolAdapter 保留为纯构造入口（无网络、
 * 无探查，回归测试 harness 沿用）。
 *
 * Coding Plan 端点防呆（A3 RK-6）：protocol='responses' 且 baseUrl 含 coding 特征时
 * 输出警告日志——智谱官方声明 Coding Plan 暂只支持 CC 协议，误配将全量失败。
 */

import type { ProtocolAdapter, AdapterInitConfig } from './protocol-adapter';
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

/** 协议探查降级链结果：实际生效适配器 + 实际生效协议（warnCodingPlanMismatch 等消费） */
export interface AdapterProtocolSetup {
  adapter: ProtocolAdapter;
  protocol: AdapterProtocol;
}

/**
 * 协议探查降级链（目标三）：先 Responses 后 CC 两级 await init（init 内各自 POST 探
 * 端点，404=协议不支持=初始化失败）；任一成功即返回该实例；两级均失败 = 请求大模型
 * API 完全失败——抛 ModelApiAbortError（message 携带两次探查失败原因）交调用方既有
 * 错误面：主链路 runMainAgent catch → MAIN_AGENT_ERROR_EVENT；执行链路 runDelegatedTask
 * catch → saveExecutionLogOnError 后 rethrow → 主链路委派失败消息化。
 * 探查失败的实例立即 close 释放（幂等），不残留可用假象。
 */
export async function initAdapterWithFallback(config: AdapterInitConfig): Promise<AdapterProtocolSetup> {
  const responsesAdapter = new ResponsesAdapter();
  const responsesInit = await responsesAdapter.init(config);
  if (responsesInit.success) {
    return { adapter: responsesAdapter, protocol: 'responses' };
  }
  responsesAdapter.close();
  const ccAdapter = new ChatCompletionsAdapter();
  const ccInit = await ccAdapter.init(config);
  if (ccInit.success) {
    return { adapter: ccAdapter, protocol: 'cc' };
  }
  ccAdapter.close();
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
