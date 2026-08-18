/**
 * Chat content 共享工具
 * 100% 抽取自 repository.ts 和 main-agent-message-content.ts 的重复 contentPartsToText 实现
 */

import type { ChatContentPart } from '@shared/types/chat';

/**
 * 将 ChatContentPart[] 序列化为纯文本（用于 SQLite 持久化 / 历史消息回显）
 * - text part → part.text
 * - attachment part → ''（附件不进入文本）
 * - 其他 part（含 image_url）→ "[image] {url}"
 * - 最终过滤空串后以 \n 连接
 */
export function contentPartsToText(parts: ChatContentPart[] | undefined): string {
  if (!parts?.length) {
    return '';
  }

  return parts
    .map((part) => {
      if (part.type === 'text') {
        return part.text;
      }

      if (part.type === 'attachment') {
        return '';
      }

      return `[image] ${part.image_url.url}`;
    })
    .filter((part) => part.length > 0)
    .join('\n');
}
