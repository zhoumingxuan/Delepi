export type ChatContentPart =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'attachment';
      attachment: ChatAttachment;
    }
  | {
      type: 'image_url';
      image_url: {
        url: string;
        detail?: 'auto' | 'low' | 'high';
      };
    };

export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
  storageKey: string;
  uploadedAt: string;
}

export interface UserMessagePayload {
  content: ChatContentPart[];
  attachments?: ChatAttachment[];
}

export type StreamStatus =
  | 'local'
  | 'loading'
  | 'updating'
  | 'success'
  | 'error'
  | 'abort';

/**
 * 最小 StreamMessage 结构（对齐 ai_fr lib/types/chat.ts StreamMessage）
 * 用于 executor snapshot 写入端 / 读取端 / 前端三方统一：
 * - 写入端 main-agent.ts buildToolSnapshotMessage 构造
 * - 读取端 ipc-handlers.ts isSnapshotMessage 守卫
 * - 前端 useChat.ts snapshotMessageToToolSnapshot 消费
 * payload.thinking 为思考内容（快照复原/历史恢复时前端渲染消费）
 */
export interface StreamMessage {
  id: string;
  conversationId: string;
  role: 'tool';
  payload: {
    toolCallId: string;
    name: string;
    arguments: string;
    result: string;
    thinking?: string;
    isError?: boolean;
    startedAt?: string;
    finishedAt?: string;
  };
  status?: StreamStatus;
  createdAt?: string;
}
