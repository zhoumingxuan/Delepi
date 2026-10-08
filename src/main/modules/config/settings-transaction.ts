import type Database from 'better-sqlite3';

export const CONFIG_REVISION_KEY = '_muse_config_revision';
export class ConfigRevisionConflict extends Error {
  readonly code = 'REVISION_CONFLICT';
  constructor(readonly currentRevision: number) { super('配置已变化，请重新预览后再确认'); }
}
export function readConfigRevision(db: Database.Database): number {
  const row = db.prepare('SELECT value_json FROM settings WHERE key=?').get(CONFIG_REVISION_KEY) as { value_json: string } | undefined;
  if (!row) return 0;
  const revision = JSON.parse(row.value_json);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('CONFIG_REVISION_INVALID');
  return revision;
}
/** No async work inside this transaction; a failed key/revision write rolls back every key. */
export function writeSettingsTransaction(db: Database.Database, patch: Record<string, unknown>, expectedRevision?: number): number {
  const serialized = Object.entries(patch).map(([key, value]) => {
    if (key === CONFIG_REVISION_KEY || value === undefined) throw new Error('CONFIG_PATCH_INVALID');
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error('CONFIG_PATCH_INVALID');
    return [key, json] as const;
  });
  return db.transaction(() => {
    const previous = readConfigRevision(db);
    if (expectedRevision !== undefined && previous !== expectedRevision) throw new ConfigRevisionConflict(previous);
    if (!serialized.length) return previous;
    const statement = db.prepare('INSERT OR REPLACE INTO settings(key,value_json,updated_at) VALUES(?,?,?)');
    const now = new Date().toISOString();
    for (const [key, json] of serialized) statement.run(key, json, now);
    const next = previous + 1;
    if (!Number.isSafeInteger(next)) throw new Error('CONFIG_REVISION_EXHAUSTED');
    statement.run(CONFIG_REVISION_KEY, JSON.stringify(next), now);
    return next;
  })();
}
