import type { ModelProfile } from './config';
export interface ProfileListResult { profiles: ModelProfile[]; activeProfileId: string; revision: number }
export interface ProfileImportPreview {
  token: string; revision: number; name: string; fields: Array<{ key: string; value: string }>;
  warnings: string[]; containsSecrets: boolean;
}
export type ProfilePreviewResult = { ok: true; preview: ProfileImportPreview } | { ok: false; canceled?: boolean; error?: string };
export type ProfileImportCommitResult = { ok: true; profileName: string; revision: number } | { ok: false; code: string; error: string; currentRevision?: number };
export type ProfileExportResult = { ok: true; filePath: string; containsSecrets: boolean } | { ok: false; canceled?: boolean; error?: string };
