/**
 * Delepi 数据库内部辅助函数
 * 从 repository.ts 提取，供各 repository 文件共享使用
 * 注意：这些函数为内部实现细节，不从 db/index.ts 对外导出
 */

import type { ChatAttachment, ChatContentPart } from '@shared/types/chat';

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseUnknownJson(value: string | null | undefined): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function isChatAttachment(value: unknown): value is ChatAttachment {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.storageKey === 'string' &&
    typeof value.contentType === 'string' &&
    typeof value.uploadedAt === 'string' &&
    typeof value.size === 'number'
  );
}

export function payloadAttachments(payload: Record<string, unknown>): ChatAttachment[] {
  return Array.isArray(payload.attachments)
    ? payload.attachments.filter(isChatAttachment)
    : [];
}

export function payloadContentParts(payload: Record<string, unknown>): ChatContentPart[] {
  if (!Array.isArray(payload.content)) {
    return [];
  }

  return payload.content.flatMap((part): ChatContentPart[] => {
    if (!isRecord(part) || typeof part.type !== 'string') {
      return [];
    }

    if (part.type === 'text' && typeof part.text === 'string') {
      return [{ type: 'text', text: part.text }];
    }

    if (part.type === 'attachment' && isChatAttachment(part.attachment)) {
      return [{ type: 'attachment', attachment: part.attachment }];
    }

    if (
      part.type === 'image_url' &&
      isRecord(part.image_url) &&
      typeof part.image_url.url === 'string'
    ) {
      const detail = part.image_url.detail;
      return [{
        type: 'image_url',
        image_url: {
          url: part.image_url.url,
          ...(detail === 'auto' || detail === 'low' || detail === 'high' ? { detail } : {}),
        },
      }];
    }

    return [];
  });
}

export function buildUserPayloadDisplayText(payload: Record<string, unknown>): string {
  if (typeof payload.content === 'string') {
    return payload.content;
  }

  return contentPartsToText(payloadContentParts(payload));
}

import { contentPartsToText } from '../utils/chat-content';
