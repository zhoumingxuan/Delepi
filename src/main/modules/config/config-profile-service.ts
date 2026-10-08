import { randomUUID } from 'node:crypto';
import { DEFAULT_APP_SETTINGS } from '@shared/constants';
import type { AppSettings, ModelProfile } from '@shared/types/config';
import type { ProfileImportPreview, ProfileListResult } from '@shared/types/config-profile-io';
import { configManager, type ConfigManager } from './config-manager';

export const PROFILE_CONFIG_KEYS = [
  'mainModelBaseUrl', 'mainModelApiKey', 'mainModelName', 'mainModelMultimodal', 'mainThinkingLevel',
  'executorModelBaseUrl', 'executorModelApiKey', 'executorModelName', 'executorThinkingLevel',
  'visionLlmBaseUrl', 'visionLlmApiKey', 'visionLlmModel',
] as const;
export const PROFILE_SECRET_KEYS = ['mainModelApiKey', 'executorModelApiKey', 'visionLlmApiKey'] as const;
const PROFILE_URL_KEYS = ['mainModelBaseUrl', 'executorModelBaseUrl', 'visionLlmBaseUrl'] as const;
const THINKING_LEVELS = ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const RESERVED_KEYS = new Set(['modelProfiles', 'activeProfileId', 'customSkillTags']);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function validateSettingPatch(raw: unknown): Partial<AppSettings> {
  if (!record(raw) || !Object.keys(raw).length || Object.keys(raw).length > 24) throw new Error('配置更新为空或格式无效');
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULT_APP_SETTINGS, key) || RESERVED_KEYS.has(key)) throw new Error('配置键不允许直接修改');
    const defaultValue = (DEFAULT_APP_SETTINGS as unknown as Record<string, unknown>)[key];
    if (typeof value !== typeof defaultValue) throw new Error('配置值类型无效');
    if (typeof value === 'string' && (value.length > 16000 || value.includes('\0'))) throw new Error('配置值长度或字符无效');
    if ((key === 'mainThinkingLevel' || key === 'executorThinkingLevel') && !THINKING_LEVELS.includes(value as string)) throw new Error('思考档位无效');
    patch[key] = value;
  }
  return patch as Partial<AppSettings>;
}

function blankProfile(id: string, name: string): ModelProfile {
  const profile: Record<string, unknown> = { id, name };
  for (const key of PROFILE_CONFIG_KEYS) profile[key] = DEFAULT_APP_SETTINGS[key];
  return profile as unknown as ModelProfile;
}
function previewValue(key: string, value: unknown): string {
  if ((PROFILE_SECRET_KEYS as readonly string[]).includes(key)) return value ? '已提供（内容隐藏）' : '未提供';
  if (key.endsWith('BaseUrl') && typeof value === 'string') {
    try { const url = new URL(value); url.username = ''; url.password = ''; url.hash = ''; if (url.search) url.search = '?[隐藏参数]'; return url.href; }
    catch { return value ? '已提供（地址格式待核对）' : '未提供'; }
  }
  return value === '' ? '不设置' : String(value);
}
function containsProfileSecrets(profile: ModelProfile): boolean {
  return PROFILE_SECRET_KEYS.some(key => Boolean(profile[key])) || PROFILE_URL_KEYS.some(key => {
    const value = profile[key];
    if (!value) return false;
    try { const url = new URL(value); return Boolean(url.username || url.password || url.search || url.hash); }
    catch { return true; }
  });
}

interface PendingImport { ownerId: number; expiresAt: number; revision: number; profile: ModelProfile }

export class ConfigProfileService {
  private previews = new Map<string, PendingImport>();
  private receipts = new Map<string, { ownerId: number; expiresAt: number; profileName: string; revision: number; previewRevision: number }>();
  constructor(private readonly manager: ConfigManager = configManager) {}
  list(): ProfileListResult {
    const settings = this.manager.getSettings();
    return { profiles: settings.modelProfiles, activeProfileId: settings.activeProfileId, revision: this.manager.getRevision() };
  }
  saveSettings(raw: unknown, expectedRevision?: number): number {
    const patch = validateSettingPatch(raw);
    const settings = this.manager.getSettings();
    const profiles = settings.modelProfiles.map((p) => ({ ...p }));
    const active = profiles.find((p) => p.id === settings.activeProfileId);
    if (active) {
      for (const key of PROFILE_CONFIG_KEYS) {
        if (Object.hasOwn(patch, key) && active[key] === settings[key]) {
          (active as unknown as Record<string, unknown>)[key] = patch[key];
        }
      }
      patch.modelProfiles = profiles;
    }
    return this.manager.commitSettings(patch, expectedRevision);
  }
  saveProfile(nameInput: unknown, blank = false, expectedRevision?: number): ProfileListResult {
    if (typeof nameInput !== 'string' || !nameInput.trim() || nameInput.trim().length > 100 || nameInput.includes('\0')) throw new Error('方案名称无效');
    const name = nameInput.trim(), current = this.manager.getSettings();
    const profiles = current.modelProfiles.map((p) => ({ ...p }));
    const index = profiles.findIndex((p) => p.name === name);
    const profile = blankProfile(index >= 0 ? profiles[index].id : randomUUID(), name);
    if (!blank) for (const key of PROFILE_CONFIG_KEYS) (profile as unknown as Record<string, unknown>)[key] = current[key];
    if (index >= 0) profiles[index] = profile; else profiles.push(profile);
    if (profiles.length > 100) throw new Error('方案数量已达上限');
    this.manager.commitSettings({ modelProfiles: profiles, activeProfileId: current.activeProfileId || profile.id }, expectedRevision);
    return this.list();
  }
  switchProfile(id: string, expectedRevision?: number): { activeProfileId: string; profileName: string; revision: number } {
    const profile = this.manager.getSettings().modelProfiles.find((p) => p.id === id);
    if (!profile) throw new Error('方案不存在或已被删除');
    const patch: Partial<AppSettings> = { activeProfileId: id };
    for (const key of PROFILE_CONFIG_KEYS) if (profile[key] !== undefined) (patch as Record<string, unknown>)[key] = profile[key];
    const revision = this.manager.commitSettings(patch, expectedRevision);
    return { activeProfileId: id, profileName: profile.name, revision };
  }
  deleteProfile(id: string, expectedRevision?: number): ProfileListResult {
    const current = this.manager.getSettings(), profiles = current.modelProfiles.filter((p) => p.id !== id);
    if (profiles.length === current.modelProfiles.length) throw new Error('方案不存在或已被删除');
    const patch: Partial<AppSettings> = { modelProfiles: profiles };
    if (!profiles.some((p) => p.id === current.activeProfileId)) {
      patch.activeProfileId = profiles[0]?.id ?? '';
      if (profiles[0]) for (const key of PROFILE_CONFIG_KEYS) if (profiles[0][key] !== undefined) (patch as Record<string, unknown>)[key] = profiles[0][key];
    }
    this.manager.commitSettings(patch, expectedRevision);
    return this.list();
  }
  previewImport(rawText: string, ownerId: number): ProfileImportPreview {
    this.prune();
    if (Buffer.byteLength(rawText, 'utf8') > 1024 * 1024) throw new Error('配置文件超过 1 MB');
    let parsed: unknown;
    try { parsed = JSON.parse(rawText.replace(/^\uFEFF/, '')); } catch { throw new Error('文件不是有效 JSON'); }
    if (!record(parsed)) throw new Error('文件不是 Delepi 配置方案');
    if (parsed.format !== undefined && (parsed.format !== 'delepi-model-profile' || parsed.version !== 1)) throw new Error('配置文件格式或版本不支持');
    const source = parsed.format === 'delepi-model-profile' ? parsed.profile : parsed;
    if (!record(source)) throw new Error('配置方案内容无效');
    const profile = blankProfile(randomUUID(), '导入方案'), warnings: string[] = [];
    let valid = 0;
    for (const key of PROFILE_CONFIG_KEYS) {
      const value = source[key];
      if (value === undefined) continue;
      try {
        const patch = validateSettingPatch({ [key]: value });
        (profile as unknown as Record<string, unknown>)[key] = patch[key]; valid++;
      } catch { warnings.push(`${key} 无效，使用空值或默认档位`); }
    }
    if (!valid) throw new Error('文件未包含有效模型配置');
    if (typeof source.name === 'string' && source.name.trim()) profile.name = source.name.trim().slice(0, 100).replace(/\0/g, '');
    const names = new Set(this.manager.getSettings().modelProfiles.map((p) => p.name));
    const original = profile.name;
    for (let suffix = 2; names.has(profile.name); suffix++) profile.name = `${original}（导入 ${suffix}）`;
    if (profile.name !== original) warnings.push('同名方案将作为新方案导入，不覆盖已有方案');
    const containsSecrets = containsProfileSecrets(profile);
    if (!containsSecrets) warnings.push('不含密钥，导入后可在设置中手动填写');
    const token = randomUUID(), revision = this.manager.getRevision();
    if (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(token, { ownerId, expiresAt: Date.now() + 10 * 60 * 1000, revision, profile });
    return { token, revision, name: profile.name, containsSecrets, warnings, fields: PROFILE_CONFIG_KEYS.map((key) => ({ key, value: previewValue(key, profile[key]) })) };
  }
  commitImport(token: string, ownerId: number, expectedRevision: number): { profileName: string; revision: number } {
    this.prune();
    const receipt = this.receipts.get(token);
    if (receipt?.ownerId === ownerId && receipt.previewRevision === expectedRevision) return { profileName: receipt.profileName, revision: receipt.revision };
    const pending = this.previews.get(token);
    if (!pending || pending.ownerId !== ownerId || expectedRevision !== pending.revision) throw new Error('导入预览已失效，请重新选择文件');
    const current = this.manager.getSettings();
    if (current.modelProfiles.length >= 100) throw new Error('方案数量已达上限');
    const revision = this.manager.commitSettings({ modelProfiles: [...current.modelProfiles, pending.profile] }, expectedRevision);
    this.previews.delete(token);
    this.receipts.set(token, { ownerId, expiresAt: Date.now() + 10 * 60 * 1000, profileName: pending.profile.name, revision, previewRevision: expectedRevision });
    return { profileName: pending.profile.name, revision };
  }
  cancelImport(token: string, ownerId: number): void { if (this.previews.get(token)?.ownerId === ownerId) this.previews.delete(token); }
  exportProfile(id: string, includeSecrets = false): { json: string; name: string; containsSecrets: boolean } {
    const profile = this.manager.getSettings().modelProfiles.find((p) => p.id === id);
    if (!profile) throw new Error('方案不存在或已被删除');
    if (typeof profile.id !== 'string' || typeof profile.name !== 'string') throw new Error('配置方案标识或名称格式无效');
    // Stored legacy profiles may have extension fields. Export only this format's declared keys.
    const exported: Record<string, unknown> = { id: profile.id, name: profile.name };
    for (const key of PROFILE_CONFIG_KEYS) {
      if (profile[key] === undefined) continue;
      // A field allowlist alone cannot redact nested values in malformed legacy records.
      exported[key] = validateSettingPatch({ [key]: profile[key] })[key];
    }
    if (!includeSecrets) {
      for (const key of PROFILE_SECRET_KEYS) delete exported[key];
      for (const key of PROFILE_URL_KEYS) {
        const value = exported[key];
        if (typeof value !== 'string' || !value) continue;
        try {
          const url = new URL(value);
          url.username = ''; url.password = ''; url.search = ''; url.hash = '';
          exported[key] = url.href;
        } catch { exported[key] = ''; }
      }
    }
    const containsSecrets = includeSecrets && containsProfileSecrets(profile);
    return { name: profile.name, containsSecrets, json: JSON.stringify({ format: 'delepi-model-profile', version: 1, containsSecrets, profile: exported }, null, 2) };
  }
  private prune(): void {
    for (const [key, value] of this.previews) if (value.expiresAt <= Date.now()) this.previews.delete(key);
    for (const [key, value] of this.receipts) if (value.expiresAt <= Date.now()) this.receipts.delete(key);
    while (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value!);
  }
}

export const configProfileService = new ConfigProfileService();
