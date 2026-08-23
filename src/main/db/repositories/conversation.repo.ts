/**
 * conversations 表操作
 * 从 repository.ts 拆分
 */

import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_CONVERSATION_TITLE } from '@shared/constants';
import { getDb } from '../sqlite-adapter';
import { nowIso } from '../helpers';
import type { ConversationRecord } from '../types';

/**
 * 会话记录 + 聚合标签（方向3）
 * 向后兼容：既有五字段不动，仅在 listConversations 返回结构上叠加 tags
 */
export type ConversationWithTags = ConversationRecord & { tags: string[] };

function mapConversationRow(row: {
  id: string;
  title: string;
  is_running: number;
  created_at: string;
  updated_at: string;
}): ConversationRecord {
  return {
    id: row.id,
    title: row.title,
    isRunning: row.is_running === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listConversations(): ConversationWithTags[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, title, is_running, created_at, updated_at
    FROM conversations
    ORDER BY updated_at DESC, created_at DESC
  `).all() as Array<{
    id: string;
    title: string;
    is_running: number;
    created_at: string;
    updated_at: string;
  }>;

  // 方向3：一次性聚合全部会话标签（conversation_tags 独立新表，内存按会话分组，
  // 避免逐会话 N+1 查询；既有五字段经 mapConversationRow 保持不动，仅叠加 tags）
  const tagRows = db.prepare(`
    SELECT conversation_id, tag FROM conversation_tags ORDER BY id
  `).all() as Array<{ conversation_id: string; tag: string }>;
  const tagsByConversation = new Map<string, string[]>();
  for (const row of tagRows) {
    const existing = tagsByConversation.get(row.conversation_id);
    if (existing) {
      existing.push(row.tag);
    } else {
      tagsByConversation.set(row.conversation_id, [row.tag]);
    }
  }

  return rows.map((row) => ({
    ...mapConversationRow(row),
    tags: tagsByConversation.get(row.id) ?? [],
  }));
}

export function createConversation(title = DEFAULT_CONVERSATION_TITLE): ConversationRecord {
  const id = uuidv4();
  const createdAt = nowIso();
  const db = getDb();
  db.prepare(`
    INSERT INTO conversations (id, title, is_running, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?)
  `).run(id, title, createdAt, createdAt);
  return {
    id,
    title,
    isRunning: false,
    createdAt,
    updatedAt: createdAt,
  };
}

export function ensureConversation(conversationId: string): void {
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM conversations WHERE id = ?')
    .get(conversationId);
  if (existing) return;

  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO conversations (id, title, is_running, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?)
  `).run(conversationId, DEFAULT_CONVERSATION_TITLE, createdAt, createdAt);
}

export function getConversationById(conversationId: string): ConversationRecord | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, title, is_running, created_at, updated_at
    FROM conversations
    WHERE id = ?
  `).get(conversationId) as {
    id: string;
    title: string;
    is_running: number;
    created_at: string;
    updated_at: string;
  } | undefined;

  return row ? mapConversationRow(row) : null;
}

export function deleteConversation(conversationId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM context_compressions WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM conversation_tags WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);
}

export function setConversationRunning(
  conversationId: string,
  isRunning: boolean,
): ConversationRecord | null {
  const db = getDb();
  db.prepare(`
    UPDATE conversations SET is_running = ? WHERE id = ?
  `).run(isRunning ? 1 : 0, conversationId);
  return getConversationById(conversationId);
}

export function touchConversation(conversationId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE conversations SET updated_at = ?, is_running = 0 WHERE id = ?
  `).run(nowIso(), conversationId);
}

export function updateConversationTitle(conversationId: string, title: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?
  `).run(title, nowIso(), conversationId);
}

// ============================================================
// 方向3：conversation_tags 标签仓储 + 自定义重命名
// （独立新表，UNIQUE(conversation_id, tag) 约束去重；
//   标签与重命名均不触碰 updated_at / is_running —— 规划 A3-5）
// ============================================================

/** 列出会话的全部标签（按写入顺序） */
export function listTags(conversationId: string): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT tag FROM conversation_tags WHERE conversation_id = ? ORDER BY id
  `).all(conversationId) as Array<{ tag: string }>;
  return rows.map((row) => row.tag);
}

/** 删除标签 */
export function removeTag(conversationId: string, tag: string): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM conversation_tags WHERE conversation_id = ? AND tag = ?
  `).run(conversationId, tag);
}

/**
 * 自定义重命名（方向3 conv:rename 专用）
 * 仅更新 title：不更新 updated_at（避免对话被顶到列表顶部）、不改 is_running
 * （区别于 updateConversationTitle：自动标题生成沿用既有函数保持现状行为）
 */
export function renameConversationTitle(conversationId: string, title: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE conversations SET title = ? WHERE id = ?
  `).run(title, conversationId);
}

/**
 * 条件更新标题（方向3 A3-3 原子版本检查·最终防线）
 * 仅当当前 title 仍等于 expectedTitle（生成期间的基线）时写入——
 * 把"读检查→写入"两步合并为单条原子 UPDATE（CAS 语义），
 * 彻底消除版本检查与入库之间的微时序窗口（期间被 conv:rename 改写则 changes=0 放弃）
 * @returns 是否实际写入（false = 期间标题已被自定义写入，调用方应放弃 emit）
 */
export function updateConversationTitleIfUnchanged(
  conversationId: string,
  expectedTitle: string,
  newTitle: string,
): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND title = ?
  `).run(newTitle, nowIso(), conversationId, expectedTitle);
  return result.changes > 0;
}
