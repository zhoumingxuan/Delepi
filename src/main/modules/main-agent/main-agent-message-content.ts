/**
 * 主智能体消息内容构建器
 * 100%复用自参考项目 E:\ai_fr
 */

import OpenAI from 'openai';
import { readFile } from 'node:fs/promises';
import { isImageContentType } from '@shared/utils/image-type';
export { isImageContentType };
import type {
  ChatAttachment,
  ChatContentPart,
} from '@shared/types/chat';
import { contentPartsToText } from '../../utils/chat-content';
import { resolveStoragePath } from '../../utils/storage-paths';
import {
  buildDataUrl,
  prepareModelImagePayload,
} from '../../utils/model-image';

type OpenAIContentPart = OpenAI.Chat.ChatCompletionContentPart;
type MainAgentContentConfig = {
  multimodalEnabled: boolean;
};

type AttachmentContentPart = Extract<ChatContentPart, { type: 'attachment' }>;

function getAttachmentIdentity(attachment: ChatAttachment): string {
  return attachment.storageKey || attachment.id;
}

function isAttachmentContentPart(
  part: ChatContentPart,
): part is AttachmentContentPart {
  return part.type === 'attachment';
}

export function buildAttachmentContentPart(
  attachment: ChatAttachment,
): AttachmentContentPart {
  return {
    type: 'attachment',
    attachment,
  };
}

export function buildUserMessageContentParts(options: {
  text?: string | null;
  attachments?: ChatAttachment[];
}): ChatContentPart[] {
  const parts: ChatContentPart[] = [];

  if (typeof options.text === 'string' && options.text.length > 0) {
    parts.push({
      type: 'text',
      text: options.text,
    });
  }

  for (const attachment of options.attachments ?? []) {
    if (attachment) {
      parts.push(buildAttachmentContentPart(attachment));
    }
  }

  return parts;
}

export function normalizeUserMessageContent(source: {
  content?: ChatContentPart[];
  attachments?: ChatAttachment[];
}): ChatContentPart[] {
  const content = Array.isArray(source.content) ? source.content : [];
  const attachments = Array.isArray(source.attachments) ? source.attachments : [];

  if (attachments.length === 0) {
    return content;
  }

  const nextContent = [...content];
  const seenAttachmentKeys = new Set(
    content
      .filter(isAttachmentContentPart)
      .map((part) => getAttachmentIdentity(part.attachment)),
  );

  for (const attachment of attachments) {
    const attachmentKey = getAttachmentIdentity(attachment);
    if (seenAttachmentKeys.has(attachmentKey)) {
      continue;
    }
    seenAttachmentKeys.add(attachmentKey);
    nextContent.push(buildAttachmentContentPart(attachment));
  }

  return nextContent;
}

export function buildMainAgentTextContent(
  text: string,
  config: MainAgentContentConfig,
): string | OpenAI.Chat.ChatCompletionContentPartText[] {
  if (!config.multimodalEnabled) {
    return text;
  }

  return [
    {
      type: 'text',
      text,
    },
  ];
}

function buildTextPart(text: string): OpenAI.Chat.ChatCompletionContentPartText {
  return {
    type: 'text',
    text,
  };
}

function buildAttachmentText(
  attachment: ChatAttachment,
  index: number,
): string {
  const order = index + 1;
  const promptPath = resolveStoragePath(attachment.storageKey);

  if (isImageContentType(attachment.contentType)) {
    return [
      '## 当前传入的图片',
      `- 文件次序：第 ${order} 个`,
      `- 图片路径：${promptPath}`,
    ].join('\n');
  }

  return [
    '## 当前传入的文件',
    `- 文件次序：第 ${order} 个`,
    `- 文件路径：${promptPath}`,
  ].join('\n');
}

function buildOrderedUserPromptText(options: {
  content?: ChatContentPart[];
  attachments?: ChatAttachment[];
  heading?: string;
}): string {
  const parts = normalizeUserMessageContent(options);
  const textParts: string[] = [
    options.heading ?? '## 当前用户输入内容（**最新用户需求和意图以此为准**）',
  ];
  let attachmentIndex = 0;

  for (const part of parts) {
    if (part.type === 'text') {
      textParts.push(part.text);
      continue;
    }

    if (isAttachmentContentPart(part)) {
      textParts.push(buildAttachmentText(part.attachment, attachmentIndex));
      attachmentIndex += 1;
      continue;
    }

    textParts.push(`[image] ${part.image_url.url}`);
  }

  return textParts.map((text) => text.trim()).join('\n\n');
}

async function storageFileToDataUrl(
  storageKey: string,
  contentType: string,
): Promise<string> {
  const buffer = await readFile(resolveStoragePath(storageKey));
  const mimeType = contentType || 'application/octet-stream';

  if (!isImageContentType(mimeType)) {
    return buildDataUrl(buffer, mimeType);
  }

  const imagePayload = await prepareModelImagePayload(buffer);

  if (!imagePayload.success) {
    throw new Error(imagePayload.message);
  }

  return buildDataUrl(imagePayload.buffer, imagePayload.mimeType);
}

async function buildOrderedUserOpenAIContent(options: {
  content?: ChatContentPart[];
  attachments?: ChatAttachment[];
  heading?: string;
}): Promise<OpenAIContentPart[]> {
  const parts = normalizeUserMessageContent(options);
  const openAIContent: OpenAIContentPart[] = [];
  let attachmentIndex = 0;

  openAIContent.push(buildTextPart(
    options.heading ?? '## 当前用户输入内容（**最新用户需求和意图以此为准**）',
  ));

  for (const part of parts) {
    if (part.type === 'text') {
      openAIContent.push(buildTextPart(part.text));
      continue;
    }

    if (isAttachmentContentPart(part)) {
      openAIContent.push(buildTextPart(
        buildAttachmentText(part.attachment, attachmentIndex),
      ));

      if (isImageContentType(part.attachment.contentType)) {
        openAIContent.push({
          type: 'image_url',
          image_url: {
            url: await storageFileToDataUrl(
              part.attachment.storageKey,
              part.attachment.contentType,
            ),
          },
        });
      }

      attachmentIndex += 1;
      continue;
    }

    openAIContent.push({
      type: 'image_url',
      image_url: {
        url: part.image_url.url,
        detail: part.image_url.detail,
      },
    });
  }

  return openAIContent;
}

export async function buildMainAgentUserContent(options: {
  content?: ChatContentPart[];
  attachments?: ChatAttachment[];
  heading?: string;
  multimodalEnabled: boolean;
}): Promise<string | OpenAIContentPart[]> {
  if (!options.multimodalEnabled) {
    return buildOrderedUserPromptText(options);
  }

  return buildOrderedUserOpenAIContent(options);
}

export async function buildMainAgentTitleUserContent(options: {
  instruction: string;
  content?: string;
  multimodalEnabled: boolean;
}): Promise<string | OpenAIContentPart[]> {
  const parts: string[] = [options.instruction];

  if (options.content) {
    parts.push(options.content);
  }

  const text = parts.join('\n\n');

  if (!options.multimodalEnabled) {
    return text;
  }

  return [
    {
      type: 'text',
      text,
    },
  ];
}
