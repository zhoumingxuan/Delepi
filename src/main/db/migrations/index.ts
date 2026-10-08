import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, chmod, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { RUNTIME_SCHEMA_SQL } from './runtime-schema';
import { ARTIFACT_SCHEMA_SQL } from '../../modules/artifacts/artifact-schema';
import { AUTONOMY_SCHEMA_SQL } from './autonomy-schema';
import { BROKER_STORAGE_SCHEMA_SQL } from './broker-storage-schema';
import { PUBLIC_INBOX_SCHEMA_SQL } from './public-inbox-schema';
import { BACKGROUND_SCHEMA_SQL } from './background-schema';
import { LEARNING_SCHEMA_SQL } from './learning-schema';

export interface MuseMigration {
  version: number;
  name: string;
  sql: string;
}
export const MUSE_MIGRATIONS: readonly MuseMigration[] = [
  { version: 1, name: 'muse-m1-runtime-and-artifacts', sql: RUNTIME_SCHEMA_SQL + ARTIFACT_SCHEMA_SQL },
  { version: 2, name: 'muse-m2-scopes-authority-budget', sql: AUTONOMY_SCHEMA_SQL },
  { version: 3, name: 'muse-m2-public-file-identities', sql: BROKER_STORAGE_SCHEMA_SQL },
  { version: 4, name: 'muse-m2-public-inbox-provenance', sql: PUBLIC_INBOX_SCHEMA_SQL },
  { version: 5, name: 'muse-background-public-learning', sql: BACKGROUND_SCHEMA_SQL + LEARNING_SCHEMA_SQL },
];
export interface MigrationReceipt {
  schemaVersion: number;
  checksum: string;
  backupPath: string;
  backupSha256: string;
  appliedAt: string;
  legacyCounts: Record<string, number>;
}

function checksum(sql: string | Uint8Array): string {
  return createHash('sha256').update(sql).digest('hex');
}
async function fileChecksum(filePath: string): Promise<string> {
  // A chat database can be large. Hash the consistent backup in bounded chunks.
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function legacyCounts(db: Database.Database): Record<string, number> {
  const result: Record<string, number> = {};
  for (const table of ['conversations', 'messages', 'settings', 'context_compressions', 'conversation_tags']) {
    if (tableExists(db, table)) result[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number}).n;
  }
  return result;
}

/** Await before any IPC registration. backup() includes committed WAL data. */
export async function applyMuseMigrations(
  db: Database.Database,
  options: {
    backupDir: string;
    migrations?: readonly MuseMigration[];
    /** Fault injection for isolated migration fixtures, never provided by renderer/model. */
    afterDdl?: (migration: MuseMigration) => void;
  },
): Promise<MigrationReceipt[]> {
  const migrations = options.migrations ?? MUSE_MIGRATIONS;
  const applied = tableExists(db, 'schema_migrations')
    ? db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Array<{version: number; checksum: string}>
    : [];
  for (const row of applied) {
    const expected = migrations.find(m => m.version === row.version);
    if (!expected || row.checksum !== checksum(expected.sql)) throw new Error('MUSE_MIGRATION_VERSION_OR_CHECKSUM_MISMATCH');
  }
  const pending = migrations.filter(m => !applied.some(a => a.version === m.version));
  if (pending.length === 0) return [];
  if (new Set(migrations.map(m => m.version)).size !== migrations.length || migrations.some((m, i) => m.version !== i + 1)) {
    throw new Error('MUSE_MIGRATION_SEQUENCE_INVALID');
  }
  await mkdir(options.backupDir, { recursive: true, mode: 0o700 });
  await chmod(options.backupDir, 0o700);
  const backupPath = path.join(options.backupDir, `before-muse-v${pending[pending.length-1].version}-${randomUUID()}.sqlite3`);
  await db.backup(backupPath);
  await chmod(backupPath, 0o600);
  const backupSha256 = await fileChecksum(backupPath);
  const counts = legacyCounts(db);
  const receipts: MigrationReceipt[] = [];
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL, backup_path TEXT NOT NULL, backup_sha256 TEXT NOT NULL
    );`);
    for (const migration of pending) {
      db.exec(migration.sql);
      options.afterDdl?.(migration);
      const appliedAt = new Date().toISOString();
      const hash = checksum(migration.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?,?,?)')
        .run(migration.version, migration.name, hash, appliedAt, backupPath, backupSha256);
      receipts.push({schemaVersion: migration.version, checksum: hash, backupPath, backupSha256, appliedAt, legacyCounts: counts});
    }
    if (JSON.stringify(legacyCounts(db)) !== JSON.stringify(counts)) throw new Error('MUSE_MIGRATION_LEGACY_COUNTS_CHANGED');
  })();
  const receiptPath = `${backupPath}.receipt.json`;
  const tempPath = `${receiptPath}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(receipts, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    await rename(tempPath, receiptPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    // The durable schema_migrations row remains the receipt if filesystem reporting fails.
    throw error;
  }
  return receipts;
}
