/** opt.1 values only tighten compatibility mode; they never create a public exploration grant. */
export const LEGACY_TOOL_GROUPS = ['shell', 'python', 'scriptTools', 'dynamicTools', 'localFiles'] as const;
export const LEGACY_OS_IDS = ['camera', 'microphone', 'screen', 'accessibility', 'inputMonitoring', 'automation', 'fullDiskAccess'] as const;
export type LegacyToolGroup = typeof LEGACY_TOOL_GROUPS[number];
export type LegacyOSId = typeof LEGACY_OS_IDS[number];
export interface LegacyDenyProjection {
  denyAll: boolean;
  assistantRequestsDenied: boolean;
  deniedToolGroups: LegacyToolGroup[];
  deniedOSUse: LegacyOSId[];
  deniedOSRequests: LegacyOSId[];
  warnings: string[];
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function normalizeLegacyDeny(raw: unknown): LegacyDenyProjection {
  const result: LegacyDenyProjection = { denyAll: false, assistantRequestsDenied: false, deniedToolGroups: [], deniedOSUse: [], deniedOSRequests: [], warnings: [] };
  if (raw === undefined) return result;
  if (!record(raw) || (raw.version !== undefined && raw.version !== 1)) {
    return { denyAll: true, assistantRequestsDenied: true, deniedToolGroups: [...LEGACY_TOOL_GROUPS], deniedOSUse: [...LEGACY_OS_IDS], deniedOSRequests: [...LEGACY_OS_IDS], warnings: ['旧权限策略格式无效，能力按关闭处理'] };
  }
  const denied = (value: unknown, label: string): boolean => {
    if (value === undefined || value === true) return false;
    if (value !== false) result.warnings.push(`${label} 格式无效，按关闭处理`);
    return true;
  };
  result.assistantRequestsDenied = denied(raw.assistantRequestsEnabled, 'assistantRequestsEnabled');
  for (const group of LEGACY_TOOL_GROUPS) {
    if (raw.tools === undefined) continue;
    if (!record(raw.tools) || denied(raw.tools[group], `tools.${group}`)) result.deniedToolGroups.push(group);
  }
  if (raw.tools !== undefined && !record(raw.tools)) result.warnings.push('旧工具策略格式无效');
  for (const id of LEGACY_OS_IDS) {
    if (raw.os === undefined) continue;
    if (!record(raw.os) || (raw.os[id] !== undefined && !record(raw.os[id]))) {
      result.deniedOSUse.push(id); result.deniedOSRequests.push(id); result.warnings.push('旧系统权限策略格式无效'); continue;
    }
    const row = raw.os[id];
    if (record(row)) {
      if (denied(row.useEnabled, `${id}.useEnabled`)) result.deniedOSUse.push(id);
      if (denied(row.requestEnabled, `${id}.requestEnabled`)) result.deniedOSRequests.push(id);
    }
  }
  result.warnings = [...new Set(result.warnings)];
  return result;
}
