-- ============================================================================
-- SQLite 数据库 Schema
-- 自动生成，请勿手动编辑
-- 包含 4 张表和 4 条索引，全部使用 IF NOT EXISTS
-- 本文件为开发参考镜像，运行时以 src/main/db/sqlite-adapter.ts 内联 SCHEMA_SQL 为准（打包生效=内联版）
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
