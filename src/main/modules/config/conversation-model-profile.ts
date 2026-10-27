/**
 * conversation-model-profile — 会话级模型方案解析（阶段7 目标1：模型配置方案 × 对话隔离 BUG 修复）
 *
 * BUG 根因（代码级）：
 * 1) 只有全局单键 activeProfileId（shared/constants.ts DEFAULT_APP_SETTINGS）承载「当前方案」；
 * 2) 方案切换处理器把方案 14 键批量写进全局 settings，再写全局 activeProfileId
 *    （ipc-handlers PROFILES_SWITCH）——这是**进程级**状态，与对话无关；
 * 3) 运行期（chat:send / 值守注入）直接读 configManager.getSettings() 的同一批全局键
 *    （ipc-handlers chat:send、conversation-send-service）；
 * 4) 会话表没有「我用的哪个方案」字段 —— 于是「对话 A 用方案 A 跑、对话 B 用方案 B 跑，
 *    再切回 A」时，A 的运行只能读到最后一次切换写进全局的 B。
 *
 * 修复设计：
 * - 持久化：conversations.model_profile_id（仅 ADD COLUMN，存量行回填空串）；
 * - 读取优先级：会话绑定方案（有效） → 当前激活方案（懒绑定后生效） → 全局 14 键（无任何方案）；
 * - 写绑定时机：① 会话首次运行时懒绑定当前激活方案；② 用户在配置抽屉里主动切换方案
 *   （PROFILES_SWITCH 带 conversationId → 只改该会话绑定）；③ 绑定方案被删除时清空悬空绑定；
 * - 运行期读取：chat:send 与值守注入都经 resolveConversationModelConfig() 取「本次 run 的快照」，
 *   因此「运行中切换方案」不会改变已在跑的 run（快照语义），只影响下一次 run。
 *
 * 本模块不 import electron，可被 harness 直接驱动（config-manager 与 repo 均可桩化/隔离库）。
 */

import type { AppSettings, ModelProfile } from '@shared/types/config';
import { configManager } from './config-manager';
import {
  getConversationModelProfileId,
  setConversationModelProfileId,
} from '../../db/repositories/conversation.repo';

/**
 * 方案字段全集（与 ipc-handlers.ts 的 PROFILE_CONFIG_KEYS 逐键一致；
 * visionEnabled 为全局总开关，不入档、不参与会话级覆盖）
 */
export const PROFILE_CONFIG_KEYS = [
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

export type ProfileConfigKey = (typeof PROFILE_CONFIG_KEYS)[number];

/** 生效配置来源（用于日志与前端提示） */
export type ConversationModelConfigSource =
  | 'conversation'      // 会话绑定方案（权威快照）
  | 'global-active'     // 会话未绑定 → 懒绑定当前激活方案（首次运行）
  | 'global-fallback';  // 系统中无任何方案 → 直接用全局 14 键（等价阶段6 行为）

/** 解析结果：本次 run 使用的模型配置快照 + 判定来源 */
export interface ResolvedConversationModelConfig {
  /** 生效方案 id（'' = 无绑定且无可用方案） */
  profileId: string;
  profileName: string;
  source: ConversationModelConfigSource;
  /** 生效设置（source='conversation' 时为「全局设置 + 方案 14 键覆盖」的新对象，绝不改全局对象） */
  settings: AppSettings;
  /** 非阻断告警（悬空绑定自愈、无方案回退等），调用方写 WARN 日志 */
  warnings: string[];
}

/** 会话模型方案绑定只读视图（前端配置抽屉展示用，不产生任何写入） */
export interface ConversationModelProfileView {
  conversationId: string;
  /** 会话绑定的方案 id（'' = 未绑定） */
  boundProfileId: string;
  /** 绑定方案名（绑定失效时为空串） */
  boundProfileName: string;
  /** 绑定是否仍有效 */
  boundProfileValid: boolean;
  /** 当前全局激活方案 id（'' = 无激活方案） */
  activeProfileId: string;
  activeProfileName: string;
}

/** 按 id 取方案（不存在返回 null） */
export function getModelProfileById(profileId: string): ModelProfile | null {
  if (!profileId) {
    return null;
  }
  return configManager.getSettings().modelProfiles.find((item) => item.id === profileId) ?? null;
}

/**
 * 把方案 14 键覆盖到设置副本上（返回新对象；缺失键/undefined 键跳过，保持基准值）。
 * 与 PROFILES_SWITCH 的「逐键 if (value === undefined) continue」语义一致。
 */
export function applyProfileToSettings(base: AppSettings, profile: ModelProfile): AppSettings {
  const next: AppSettings = { ...base };
  const target = next as unknown as Record<string, unknown>;
  const source = profile as unknown as Record<string, unknown>;
  for (const key of PROFILE_CONFIG_KEYS) {
    const value = source[key];
    if (value === undefined) {
      continue;
    }
    target[key] = value;
  }
  return next;
}

/**
 * 解析某个会话本次 run 使用的模型配置（**运行期唯一读取点**）。
 *
 * 6 个边界行为（与报告第 3 章行为表逐条对应）：
 * 1) 历史会话从未绑定过方案：绑定为空 → 懒绑定当前激活方案（写库），本次用全局/激活方案配置；
 * 2) 绑定的方案被删除：清空悬空绑定 + 告警，回落当前激活方案（若还有方案），否则回落全局 14 键；
 * 3) 该会话正在运行中用户切换方案：本次 run 已持有快照，不受影响；绑定按切换决定，下一次 run 生效；
 * 4) 新建会话：绑定为空，首次运行时懒绑定（与 1 同路径）；
 * 5) 值守邮件触发新建会话：与 4 完全一致（createConversation → 注入时懒绑定）；
 * 6) 系统中一个方案都没有：不写绑定，直接用全局 14 键（等价阶段6 行为），不报错。
 */
export function resolveConversationModelConfig(conversationId: string | null): ResolvedConversationModelConfig {
  const globalSettings = configManager.getSettings();
  const profiles = globalSettings.modelProfiles;
  const activeProfile = profiles.find((item) => item.id === globalSettings.activeProfileId) ?? null;
  const warnings: string[] = [];

  if (!conversationId) {
    // 无会话上下文（防御性分支）：等价「未绑定」，不写任何绑定
    return {
      profileId: activeProfile?.id ?? '',
      profileName: activeProfile?.name ?? '',
      source: activeProfile ? 'global-active' : 'global-fallback',
      settings: globalSettings,
      warnings,
    };
  }

  const boundId = getConversationModelProfileId(conversationId);
  if (boundId) {
    const boundProfile = profiles.find((item) => item.id === boundId) ?? null;
    if (boundProfile) {
      return {
        profileId: boundProfile.id,
        profileName: boundProfile.name,
        source: 'conversation',
        settings: applyProfileToSettings(globalSettings, boundProfile),
        warnings,
      };
    }
    // 边界 2：绑定方案已被删除 → 自愈清空绑定（不阻断本次运行）
    warnings.push(`会话绑定的方案 ${boundId} 已不存在：已清除该会话的悬空绑定，按当前激活方案运行`);
    try {
      setConversationModelProfileId(conversationId, '');
    } catch (err) {
      warnings.push(`悬空绑定清理失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (activeProfile) {
    // 边界 1/4/5：未绑定（或刚被清空）→ 懒绑定当前激活方案，本次 run 行为与阶段6 完全一致
    try {
      setConversationModelProfileId(conversationId, activeProfile.id);
    } catch (err) {
      warnings.push(`会话懒绑定写入失败（本次运行继续使用全局配置）：${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      profileId: activeProfile.id,
      profileName: activeProfile.name,
      source: 'global-active',
      settings: globalSettings,
      warnings,
    };
  }

  // 边界 6：系统中没有任何方案 → 全局 14 键，不写绑定
  warnings.push('系统中没有任何模型方案：本次运行使用全局模型配置（不写会话绑定）');
  return {
    profileId: '',
    profileName: '',
    source: 'global-fallback',
    settings: globalSettings,
    warnings,
  };
}

/** 读取会话绑定视图（只读，不写库；供配置抽屉展示「当前对话使用方案」） */
export function inspectConversationModelProfile(conversationId: string): ConversationModelProfileView {
  const settings = configManager.getSettings();
  const boundProfileId = getConversationModelProfileId(conversationId);
  const boundProfile = settings.modelProfiles.find((item) => item.id === boundProfileId) ?? null;
  const activeProfile = settings.modelProfiles.find((item) => item.id === settings.activeProfileId) ?? null;
  return {
    conversationId,
    boundProfileId,
    boundProfileName: boundProfile?.name ?? '',
    boundProfileValid: Boolean(boundProfile),
    activeProfileId: activeProfile?.id ?? '',
    activeProfileName: activeProfile?.name ?? '',
  };
}

/**
 * 把会话绑定到指定方案（PROFILES_SWITCH 带 conversationId 时调用）。
 * profileId='' 表示解绑。返回是否命中会话行。
 */
export function bindConversationToProfile(conversationId: string, profileId: string): boolean {
  return setConversationModelProfileId(conversationId, profileId);
}
