/**
 * SQLite 数据库适配器
 * 5 张表 DDL：conversations / messages / context_compressions / settings / conversation_tags
 * WAL 模式开启，无全文索引
 * Schema DDL 已内联，避免打包后路径解析问题
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import {
  DB_FILE_NAME,
  DATA_DIR_NAME,
} from '../constants';

/** 解析数据库路径 */
function resolveDbPath(): string {
  const isDev = !app.isPackaged;
  return isDev
    ? path.join(process.cwd(), DATA_DIR_NAME, DB_FILE_NAME)
    : path.join(app.getPath('userData'), DB_FILE_NAME);
}

const SCHEMA_SQL = `-- ============================================================================
-- SQLite 数据库 Schema
-- 自动生成，请勿手动编辑
-- 包含 5 张表和 5 条索引，全部使用 IF NOT EXISTS
-- ============================================================================

-- PRAGMA 配置（仅在新数据库创建时执行）
PRAGMA foreign_keys = OFF;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- ============================================================================
-- 1. 对话表
-- ============================================================================
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '新对话',
    is_running INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- ============================================================================
-- 2. 消息表（无全文索引）
-- ============================================================================
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    UNIQUE (conversation_id, seq)
);

-- ============================================================================
-- 3. 上下文压缩表
-- ============================================================================
CREATE TABLE IF NOT EXISTS context_compressions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    max_message_seq INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed')),
    context_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    finished_at TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    UNIQUE (conversation_id, max_message_seq)
);

-- ============================================================================
-- 4. 设置表（键值对存储用户可配配置项）
-- ============================================================================
-- ============================================================================
-- 5. 对话标签表（方向3：对话列表自定义标签，独立新表零迁移）
-- ============================================================================
CREATE TABLE IF NOT EXISTS conversation_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (conversation_id, tag)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    updated_at TEXT NOT NULL
);

-- ============================================================================
-- 索引
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_context_compressions_conversation_max_seq ON context_compressions(conversation_id, max_message_seq DESC);
CREATE INDEX IF NOT EXISTS idx_context_compressions_conversation_status ON context_compressions(conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_conversation_tags_conversation ON conversation_tags(conversation_id);
`;

/**
 * conversation_tags 建表 DDL（存量库就地补建用，与 SCHEMA_SQL 内定义逐字一致）
 * 背景：getDb 的 needsInit 仅检查 conversations 表，存量库会跳过全量 SCHEMA_SQL，
 *       新表必须在此单独补建（IF NOT EXISTS 幂等，重复执行安全）
 */
const CONVERSATION_TAGS_DDL = `-- conversation_tags（方向3：对话列表自定义标签）
CREATE TABLE IF NOT EXISTS conversation_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (conversation_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_conversation_tags_conversation ON conversation_tags(conversation_id);
`;

/** 数据库连接单例 */
let dbInstance: Database.Database | null = null;

/**
 * 检查指定表是否存在
 */
function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(tableName);
  return row !== undefined;
}

/**
 * 获取数据库实例（懒初始化）
 * - 数据库文件不存在 → 创建数据库并执行内联 DDL
 * - 数据库文件存在但 conversations 表不存在 → 执行 DDL 补建
 * - 数据库文件存在且 conversations 表存在 → 跳过 DDL，直接返回
 */
export function getDb(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = resolveDbPath();

  // 确保数据目录存在
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 检测数据库文件是否已存在
  const dbExists = fs.existsSync(dbPath);

  dbInstance = new Database(dbPath);

  // 检查核心表是否存在（处理数据库文件存在但表缺失的异常情况，
  // 例如打包产物中 schema.sql 缺失导致首次初始化失败留下空文件）
  const needsInit = !dbExists || !tableExists(dbInstance, 'conversations');

  if (needsInit) {
    // 使用内联的 schema SQL（避免打包后文件路径解析问题）
    dbInstance.exec(SCHEMA_SQL);

    if (!dbExists) {
      console.log(`[SQLite] Database created and initialized at: ${dbPath}`);
    } else {
      console.log(`[SQLite] Database file existed but tables missing, re-initialized at: ${dbPath}`);
    }
    console.log(`[SQLite] Tables: conversations, messages, context_compressions, settings, conversation_tags`);
  } else {
    console.log(`[SQLite] Database already exists, skipping DDL/PRAGMA: ${dbPath}`);

    // 方向3：存量库就地补建 conversation_tags（needsInit 仅检查 conversations 表，
    // 既有库不会执行全量 SCHEMA_SQL，新表在此单独补建；IF NOT EXISTS 幂等）
    if (!tableExists(dbInstance, 'conversation_tags')) {
      dbInstance.exec(CONVERSATION_TAGS_DDL);
      console.log('[SQLite] conversation_tags table created (in-place upgrade)');
    }
  }

  return dbInstance;
}

/**
 * 关闭数据库连接
 */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    console.log('[SQLite] Database connection closed.');
  }
}

/**
 * 获取数据库路径（用于调试）
 */
export function getDbPath(): string {
  return resolveDbPath();
}
