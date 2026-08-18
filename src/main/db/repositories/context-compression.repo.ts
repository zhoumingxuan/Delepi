/**
 * context_compressions 表操作
 * 从 repository.ts 拆分
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../sqlite-adapter';
import { nowIso } from '../helpers';
import type { ContextCompressionRecord } from '../types';

export function getLatestCompletedContextCompression(
  conversationId: string,
  beforeSeq: number,
): ContextCompressionRecord | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, conversation_id, max_message_seq, context_text
    FROM context_compressions
    WHERE conversation_id = ? AND status = 'completed' AND max_message_seq < ?
    ORDER BY max_message_seq DESC LIMIT 1
  `).get(conversationId, beforeSeq) as {
    id: string;
    conversation_id: string;
    max_message_seq: number;
    context_text: string;
  } | undefined;
  return row
    ? {
        id: row.id,
        conversationId: row.conversation_id,
        maxMessageSeq: row.max_message_seq,
        contextText: row.context_text,
      }
    : null;
}

export function startContextCompression(
  conversationId: string,
  maxMessageSeq: number,
): string | null {
  const db = getDb();
  const existing = db.prepare(`
    SELECT id FROM context_compressions
    WHERE conversation_id = ? AND max_message_seq = ? AND status = 'completed'
  `).get(conversationId, maxMessageSeq);
  if (existing) return null;

  const id = uuidv4();
  db.prepare(`
    INSERT OR REPLACE INTO context_compressions
      (id, conversation_id, max_message_seq, status, context_text, created_at, finished_at)
    VALUES (?, ?, ?, 'running', '', ?, NULL)
  `).run(id, conversationId, maxMessageSeq, nowIso());
  return id;
}

export function completeContextCompression(
  conversationId: string,
  compressionId: string,
  contextText: string,
): void {
  const db = getDb();
  db.prepare(`
    UPDATE context_compressions
    SET status = 'completed', context_text = ?, finished_at = ?
    WHERE id = ? AND conversation_id = ?
  `).run(contextText, nowIso(), compressionId, conversationId);
}

export function deleteContextCompression(
  conversationId: string,
  compressionId: string,
): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM context_compressions WHERE id = ? AND conversation_id = ?
  `).run(compressionId, conversationId);
}
