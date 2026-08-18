/**
 * settings 表操作
 * 从 repository.ts 拆分
 */

import { getDb } from '../sqlite-adapter';
import { nowIso, parseUnknownJson, stringifyJson } from '../helpers';

export function listSettings(): Partial<Record<string, unknown>> {
  const db = getDb();
  const rows = db.prepare('SELECT key, value_json FROM settings').all() as Array<{
    key: string;
    value_json: string;
  }>;
  const settings: Partial<Record<string, unknown>> = {};
  for (const row of rows) {
    settings[row.key] = parseUnknownJson(row.value_json);
  }
  return settings;
}

export function saveSetting(key: string, value: unknown): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
  `).run(key, stringifyJson(value), nowIso());
}
