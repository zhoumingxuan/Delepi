/**
 * conversations 表操作
 * 从 repository.ts 拆分
 */

import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_CONVERSATION_TITLE } from '@shared/constants';
import { getDb } from '../sqlite-adapter';
import { nowIso } from '../helpers';
import type { ConversationRecord } from '../types';

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

export function listConversations(): ConversationRecord[] {
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
  return rows.map(mapConversationRow);
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
