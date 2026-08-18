/**
 * messages 表操作
 * 从 repository.ts 拆分
 * 批量入口 insertMessages = 批次末配对写入专用（对齐 ai_fr sqlite-adapter.ts insertMessages）
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../sqlite-adapter';
import {
  nowIso,
  parseJsonObject,
  stringifyJson,
  payloadAttachments,
  buildUserPayloadDisplayText,
} from '../helpers';
import type {
  MessageRole,
  StoredMessageRecord,
  RendererChatMessage,
  AssistantMessageSegment,
} from '../types';

export function getNextMessageSeq(conversationId: string): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
    FROM messages
    WHERE conversation_id = ?
  `).get(conversationId) as { next_seq: number };
  return row.next_seq;
}

export function insertMessage(input: {
  conversationId: string;
  id?: string;
  seq?: number;
  role: MessageRole;
  payload: Record<string, unknown>;
  createdAt?: string;
}): StoredMessageRecord {
  const id = input.id ?? uuidv4();
  const seq = input.seq ?? getNextMessageSeq(input.conversationId);
  const createdAt = input.createdAt ?? nowIso();
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO messages
      (id, conversation_id, seq, role, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.conversationId,
    seq,
    input.role,
    stringifyJson(input.payload),
    createdAt,
  );
  return {
    id,
    conversationId: input.conversationId,
    seq,
    role: input.role,
    payload: input.payload,
    createdAt,
  };
}

export function insertMessages(input: {
  conversationId: string;
  messages: Array<{
    id?: string;
    role: MessageRole;
    payload: Record<string, unknown>;
  }>;
}): StoredMessageRecord[] {
  if (input.messages.length === 0) {
    return [];
  }

  const now = nowIso();
  const inserted: StoredMessageRecord[] = [];

  const db = getDb();
  db.transaction(() => {
    const row = db.prepare(`
      SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
      FROM messages
      WHERE conversation_id = ?
    `).get(input.conversationId) as { next_seq: number };

    const insertStatement = db.prepare(`
      INSERT INTO messages
        (id, conversation_id, seq, role, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    input.messages.forEach((message, index) => {
      const id = message.id ?? uuidv4();
      const seq = row.next_seq + index;
      insertStatement.run(
        id,
        input.conversationId,
        seq,
        message.role,
        stringifyJson(message.payload),
        now,
      );
      inserted.push({
        id,
        conversationId: input.conversationId,
        seq,
        role: message.role,
        payload: message.payload,
        createdAt: now,
      });
    });

    db.prepare(`
      UPDATE conversations SET updated_at = ? WHERE id = ?
    `).run(now, input.conversationId);
  })();

  return inserted;
}

export function listStoredMessages(conversationId: string): StoredMessageRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, conversation_id, seq, role, payload_json, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY seq ASC
  `).all(conversationId) as Array<{
    id: string;
    conversation_id: string;
    seq: number;
    role: MessageRole;
    payload_json: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    role: row.role,
    payload: parseJsonObject(row.payload_json),
    createdAt: row.created_at,
  }));
}

export function listRendererMessages(conversationId: string): RendererChatMessage[] {
  return listStoredMessages(conversationId).map((message) => {
    const payload = message.payload;
    const toolCallId =
      typeof payload.toolCallId === 'string'
        ? payload.toolCallId
        : typeof payload.tool_call_id === 'string'
          ? payload.tool_call_id
          : '';
    const toolResult =
      typeof payload.result === 'string'
        ? payload.result
        : typeof payload.content === 'string'
          ? payload.content
          : '';
    const toolCall = message.role === 'tool' && toolCallId
      ? {
          callId: toolCallId,
          name: typeof payload.name === 'string'
            ? payload.name
            : '',
          arguments: typeof payload.arguments === 'string'
            ? payload.arguments
            : '',
          result: toolResult,
          status: payload.isError
            ? ('error' as const)
            : ('success' as const),
          startedAt: typeof payload.startedAt === 'string'
            ? payload.startedAt
            : undefined,
          finishedAt: typeof payload.finishedAt === 'string'
            ? payload.finishedAt
            : message.createdAt,
          isError: Boolean(payload.isError),
          isDelegatedExecutor: payload.name === 'delegate_executor',
        }
      : undefined;
    const rawToolCalls = Array.isArray(payload.tool_calls)
      ? payload.tool_calls
      : Array.isArray(payload.toolCalls)
        ? payload.toolCalls
        : undefined;

    // ★ F5 新增：从 payload 提取 segments 字段
    //   对齐 ai_fr AssistantMessageSegment 类型（reasoning | tool_call）
    //   持久化在 messages.payload_json.segments 中（由 insertMessage/F3 写入）
    const rawSegments = Array.isArray((payload as Record<string, unknown>).segments)
      ? ((payload as Record<string, unknown>).segments as AssistantMessageSegment[])
      : undefined;

    return {
      id: message.id,
      role: message.role,
      content: message.role === 'user'
        ? buildUserPayloadDisplayText(payload)
        : typeof payload.content === 'string'
          ? payload.content
          : typeof payload.result === 'string'
            ? payload.result
            : '',
      // ★ P6 历史消息附件回显：user 角色携带附件元数据供 ChatMessageContent 渲染图片缩略图/文件条
      //   assistant/tool 角色不携带附件,保持 undefined
      ...(message.role === 'user' && payloadAttachments(payload).length > 0
        ? { attachments: payloadAttachments(payload) }
        : {}),
      thinking: typeof payload.thinking === 'string' ? payload.thinking : '',
      // ★ F5 新增：返回 segments 字段（与 RendererChatMessage.segments 对齐）
      //   前端 ChatMessageContent 优先使用 message.segments，不再走 buildLegacySegments 兜底
      segments: rawSegments,
      toolCalls: rawToolCalls?.map((toolCallValue) => {
        const toolCallObject = toolCallValue as {
          id?: string;
          function?: { name?: string; arguments?: string };
        };
        return {
          callId: toolCallObject.id ?? '',
          name: toolCallObject.function?.name ?? '',
          arguments: toolCallObject.function?.arguments ?? '',
          status: 'success' as const,
          isDelegatedExecutor: toolCallObject.function?.name === 'delegate_executor',
        };
      }),
      toolCall,
      status: 'success',
      createdAt: message.createdAt,
      source: message.role === 'tool' ? 'executor' : 'main',
    };
  });
}
