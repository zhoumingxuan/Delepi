/**
 * 消息内容渲染分发组件
 * 处理 user / assistant / tool 三种角色消息
 * 执行子智能体进度模式 + 任务标题提取（对齐 E:\ai_fr\components\chat-message-content.tsx）
 *
 * 适配 Delepi 后端实现（替换 Next.js StreamMessage → Delepi ChatMessage）：
 * - 数据模型：StreamMessage (payload.content/reasoning/toolCalls) → ChatMessage (content/thinking/toolCalls)
 * - 工具调用：AssistantToolCall (function.name/arguments, id) → ToolCallInfo (name/arguments, callId)
 * - 附件渲染：实现（Delepi ChatMessage 现在携带 attachments 字段，P6 历史消息附件回显）
 *   - Image.PreviewGroup + Image lazy loading，单图 320px，多图 152px
 *   - Flex + FileOutlined + 文件名 + size 文件条
 *   - 仅附件无文本：仅显示附件（不渲染「已发送 N 张图片 / N 个附件」摘要气泡，对齐 ai_fr）
 * - 渲染组件：AssistantContentRenderer → RichMarkdown
 *
 * Phase 3 P0-2 适配层（保留）：
 * - EXECUTOR_TOOL_PROGRESS_PATTERNS / isExecutorToolProgressText / splitLoadingToolContent
 *   提取到 lib/executor-thinking.ts 共享，ToolCallCard 同步使用
 *
 * Phase 3 P3-2 适配层（保留）：
 * - assistant 空泡过滤（isEmptyAssistantBubble）：当 content.trim() === '' 且无 thinking / toolCalls
 *   且 status !== 'loading' 时直接返回 null，避免渲染空 bubble
 * - 完整 filter 函数 filterEmptyAssistantBubbles 由 lib/message-filter.ts 提供
 */

import { Button, Flex, Image, Space, Spin, Typography } from 'antd';
import { ThoughtChain } from '@ant-design/x';
import { FileOutlined } from '@ant-design/icons';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { RichMarkdown } from './RichMarkdown';
import { ThinkingBlock } from './ThinkingBlock';
import type { ToolCallInfo } from './ToolCallCard';
import { ToolCallCard } from './ToolCallCard';
import type { ChatMessage } from '../hooks/useChat';
import type { ChatAttachment } from '@shared/types/chat';
import { isImageContentType } from '@shared/utils/image-type';
import type { AssistantMessageSegment } from '../lib/message-filter';
// ★ P04: 切分函数改用增量缓存版（cacheKey=callId 级），输出与全量版逐字一致；原全量函数保留导出（零回归底线）
import { latestToolProgressTextCached, splitLoadingToolContentCached } from '../lib/executor-thinking';
import { isEmptyAssistantBubble } from '../lib/message-filter';
import { ExecutionElapsedTime } from '../hooks/useElapsedSeconds';

/**
 * 工具摘要（用于把 toolCall.name 解析为 displayName）
 * 对齐 E:\ai_fr\lib\types\config.ts ToolSummary
 * - 由调用方传入（参考项目 chat-shell.tsx L2684-2738 传 config?.tools）
 */
export interface ToolSummary {
  name: string;
  displayName?: string;
  description: string;
  enabledByDefault: boolean;
}

const USER_TEXT_COLLAPSE_THRESHOLD = 600;

/** 完成态工具结果展开区滚动高度上限（px）：与 ThinkingBlock 展开上限同族，避免展开大 JSON 无限撑高消息流 */
const TOOL_RESULT_EXPANDED_MAX_HEIGHT_PX = 320;

/**
 * ★ Phase 3 P3-5 修复：图片附件 previewUrl 缺失时的占位符
 * 使用 1x1 透明 PNG (data URI) 兜底,antd Image.fallback 会替换显示
 * 不再用 attachment.storageKey 兜底(storageKey 不是合法 URL,会触发 404)
 */
const FALLBACK_IMAGE_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function isJsonString(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function prettyJsonString(value: string): string {
  if (!value) return value;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getUrlFileName(urlText: string): string {
  try {
    const url = new URL(urlText);
    const name = url.pathname.split('/').filter(Boolean).pop();
    return name ? decodeURIComponent(name) : urlText;
  } catch {
    return urlText;
  }
}

function collectStructuredFileUrls(value: unknown): {
  imageUrls: string[];
  fileUrls: string[];
} {
  const imageUrls = new Set<string>();
  const fileUrls = new Set<string>();
  const imageFields = new Set(['image_urls']);
  const fileFields = new Set(['file_urls', 'can_openfile_url']);

  const visit = (current: unknown, fieldName?: string) => {
    if (Array.isArray(current)) {
      if (fieldName && imageFields.has(fieldName)) {
        for (const item of current) {
          if (typeof item === 'string') imageUrls.add(item);
        }
      } else if (fieldName && fileFields.has(fieldName)) {
        for (const item of current) {
          if (typeof item === 'string') fileUrls.add(item);
        }
      }

      for (const item of current) {
        visit(item);
      }
      return;
    }

    if (!isRecordValue(current)) {
      return;
    }

    for (const [key, item] of Object.entries(current)) {
      if (typeof item === 'string') {
        if (imageFields.has(key)) imageUrls.add(item);
        if (fileFields.has(key)) fileUrls.add(item);
        continue;
      }

      visit(item, key);
    }
  };

  visit(value);

  return {
    imageUrls: [...imageUrls],
    fileUrls: [...fileUrls].filter((url) => !imageUrls.has(url)),
  };
}

function buildStructuredFilePreviewMarkdown(value: unknown): string {
  const { imageUrls, fileUrls } = collectStructuredFileUrls(value);
  const sections: string[] = [];

  if (imageUrls.length > 0) {
    sections.push(
      imageUrls
        .map((url, index) => `![图片 ${index + 1}](${url})`)
        .join('\n\n'),
    );
  }

  if (fileUrls.length > 0) {
    sections.push(
      fileUrls
        .map((url) => `- [${getUrlFileName(url)}](${url})`)
        .join('\n'),
    );
  }

  return sections.join('\n\n');
}

function renderToolResultContent(
  value: string,
  options?: { includeStructuredFilePreview?: boolean },
): string {
  if (!value) {
    return '空';
  }

  if (isJsonString(value)) {
    const jsonMarkdown = ['```json', prettyJsonString(value), '```'].join('\n');
    return jsonMarkdown;
  }

  return value;
}

// ★ P04: 追加第三参 cacheKey（必传，流标识级缓存键），切分改走增量缓存（根因 R4）
// ★ 缺陷②修复：追加第四参 progressOverride（= options.progressText / message.progress，
//   快照级进度行）——优先于缓存提取，接通 M17 完成分支删除后失连的
//   '工具调用'块渲染出口（子工具原始 result 不匹配进度正则致缓存提取恒空的场景由该参兜住）
function renderLoadingToolContent(
  value: string,
  thinkingOverride: string | undefined,
  cacheKey: string,
  progressOverride?: string,
) {
  const { thinking: thinkingFromResult } = splitLoadingToolContentCached(cacheKey, value);
  // ★ 项9：对齐 ai_fr renderLoadingToolContent(value, thinkingOverride?)——优先使用显式 thinking
  const thinking = thinkingOverride?.trim() || thinkingFromResult;
  const progressContent = progressOverride?.trim()
    || latestToolProgressTextCached(cacheKey, value)
    || (thinking ? '' : '执行中');

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {thinking ? (
        // S1-4 统一折叠策略：思考块改用 ThinkingBlock（超长折叠/字数摘要/摘要头/滚动上限），
        //   loading={<span />} 与 title 保持既有视觉语义
        <ThinkingBlock content={thinking} loading={<span />} title="思考内容" defaultExpanded />
      ) : null}
      {progressContent ? (
        // S1-4 统一折叠策略：进度块改用 ThinkingBlock（与思考块/ToolCallCard 兜底路径同源），
        //   超长进度获得滚动上限 + 尾部自动滚动 + 字数摘要，避免流式累积无限撑高消息流
        <ThinkingBlock content={progressContent} loading={<span />} title="工具调用" defaultExpanded />
      ) : null}
    </Space>
  );
}

function parseToolArguments(
  rawArguments: string,
): Record<string, unknown> | null {
  if (!rawArguments) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawArguments) as unknown;

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function pickTaskTitleFromArguments(rawArguments: string): string | null {
  const parsedArguments = parseToolArguments(rawArguments);

  if (!parsedArguments) {
    return null;
  }

  const candidateKeys = ['taskname', 'task_name'] as const;

  for (const key of candidateKeys) {
    const value = parsedArguments[key];

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function resolveTaskDisplayTitle(options: {
  toolName: string;
  rawArguments: string;
  toolSummaries?: ToolSummary[];
}): string {
  const toolDisplayName = resolveToolDisplayName(
    options.toolName,
    options.toolSummaries,
  );
  const taskTitle = pickTaskTitleFromArguments(options.rawArguments);
  return taskTitle || toolDisplayName;
}

function resolveToolDisplayName(
  toolName: string,
  toolSummaries?: ToolSummary[],
): string {
  const matchedTool = toolSummaries?.find((tool) => tool.name === toolName);
  const displayName = matchedTool?.displayName?.trim();
  return displayName || toolName;
}

function isDelegatedExecutorToolCall(toolCall: ToolCallInfo): boolean {
  return toolCall.isDelegatedExecutor === true || toolCall.name === 'delegate_executor';
}

function buildLegacySegments(
  thinking: string,
  toolCalls: ToolCallInfo[],
): AssistantMessageSegment[] {
  const segments: AssistantMessageSegment[] = [];

  if (thinking) {
    segments.push({
      id: 'legacy-reasoning',
      type: 'reasoning',
      text: thinking,
    });
  }

  for (const toolCall of toolCalls) {
    segments.push({
      id: `legacy-tool-${toolCall.callId}`,
      type: 'tool_call',
      toolCallId: toolCall.callId,
    });
  }

  return segments;
}

function renderToolCallSegment(
  toolCall: ToolCallInfo,
  loading: boolean,
  toolSummaries?: ToolSummary[],
) {
  const title = resolveTaskDisplayTitle({
    toolName: toolCall.name,
    rawArguments: toolCall.arguments,
    toolSummaries,
  });

  return (
    <ThoughtChain
      items={[
        {
          key: toolCall.callId,
          title,
          status: loading ? 'loading' : 'success',
        },
      ]}
    />
  );
}

function renderToolResultSegment(
  messageId: string,
  toolCall: ToolCallInfo,
  loading: boolean,
  createdAt: string,
  toolSummaries?: ToolSummary[],
  options?: { includeStructuredFilePreview?: boolean; thinkingText?: string; progressText?: string; content?: string },
) {
  const title = resolveTaskDisplayTitle({
    toolName: toolCall.name,
    rawArguments: toolCall.arguments,
    toolSummaries,
  });
  const shouldShowElapsed = loading || Boolean(toolCall.startedAt);
  const titleContent = shouldShowElapsed ? (
    <Flex align="center" gap={8}>
      <span>{title}</span>
      <ExecutionElapsedTime
        active={loading}
        startedAt={toolCall.startedAt ?? createdAt}
        finishedAt={loading ? undefined : toolCall.finishedAt ?? createdAt}
      />
    </Flex>
  ) : (
    title
  );
  // ★ 项9 + M17（D3 两态覆盖历史）：thinking/进度仅执行中（loading 分支）渲染；完成态仅渲染 Result
  const thinkingText = options?.thinkingText?.trim() || '';
  // ★ 本次修复：运行中（loading）不再把 toolCall.result（=末项子工具结果 JSON）作为渲染输入，
  //   改用 options.content（=message.content=快照 payload.result：思考全量/最新进度文本）——
  //   彻底移除「工具调用任务调用结果（Result 内容）」混入运行中 tool 显示区域；
  //   完成态（loading=false）仍仅渲染 Result（M17 既有正确行为，零回归）
  const content = loading
    ? options?.content || ''
    : renderToolResultContent(toolCall.result || '', {
        includeStructuredFilePreview: options?.includeStructuredFilePreview,
      });
  const renderedContent = loading ? (
    // ★ 缺陷②修复：接通 options.progressText（=message.progress，来自 ChatArea.tsx
    //   toolSnapshotsToChatMessages 的快照级进度文本）作为'工具调用'块内容——运行中可见且
    //   内容可追溯快照数据；完成分支不受影响（loading=false 不进本调用，仅渲染 Result，M17 零回归）
    renderLoadingToolContent(content, thinkingText, toolCall.callId, options?.progressText)
  ) : (
    // ★ M17（D3 两态覆盖历史）：完成分支仅渲染 Result（RichMarkdown）；思考块/工具调用块移除
    <div style={{ maxHeight: TOOL_RESULT_EXPANDED_MAX_HEIGHT_PX, overflowY: 'auto' }}>
      <RichMarkdown content={content} />
    </div>
  );

  return (
    <div style={{ width: '100%', maxWidth: '100%', minWidth: 0 }}>
      <ThoughtChain
        className="chat-tool-result-chain"
        styles={{
          item: {
            width: '100%',
            minWidth: 0,
          },
          itemContent: {
            maxWidth: '100%',
            minWidth: 0,
          },
        }}
        items={[
          {
            key: messageId,
            title: titleContent,
            content: renderedContent,
            status: toolCall.isError ? 'error' : loading ? 'loading' : 'success',
            collapsible: !loading,
          },
        ]}
      />
    </div>
  );
}

/**
 * ★ P6 辅助函数：生成附件摘要文本
 * 对齐 E:\ai_fr components/chat-message-content.tsx renderUserAttachmentSummary
 * - 全部为图片：「已发送 N 张图片」
 * - 包含其他类型：「已发送 N 个附件」
 */
function renderUserAttachmentSummary(attachments: ChatAttachment[]): string {
  if (!attachments.length) {
    return '';
  }
  const allImages = attachments.every((attachment) =>
    isImageContentType(attachment.contentType),
  );
  if (allImages) {
    return `已发送 ${attachments.length} 张图片`;
  }
  return `已发送 ${attachments.length} 个附件`;
}

/**
 * ★ P6 辅助函数：渲染附件区域（Image.PreviewGroup + FileOutlined 文件条）
 * 对齐 E:\ai_fr components/chat-message-content.tsx renderUserAttachments
 *
 * 实现要点：
 * - 图片：antd Image.PreviewGroup，单图 320px，多图 152px（square）
 * - 文件：Flex + FileOutlined + 文件名 + size 文件条
 * - 点击图片：Image.PreviewGroup 触发预览
 * - 点击文件：走 IPC_FILE.OPEN，主进程 shell.openPath 用系统默认应用打开
 *
 * src 解析：
 * - 优先用 attachment.previewUrl（ChatAttachment & { previewUrl?: string } 扩展字段）
 * - fallback 到 attachment.storageKey（实际不会渲染,仅作 preview 兜底）
 */
function renderUserAttachments(attachments: ChatAttachment[]) {
  if (!attachments.length) {
    return null;
  }

  const imageCount = attachments.filter((attachment) =>
    isImageContentType(attachment.contentType),
  ).length;
  const imageSize = imageCount <= 1 ? 320 : 152;

  return (
    <Image.PreviewGroup>
      <Flex wrap gap={8} justify="flex-end">
        {attachments.map((attachment) =>
          isImageContentType(attachment.contentType) ? (
            <Image
              key={attachment.id || attachment.storageKey}
              // ★ Phase 3 P3-5 修复：previewUrl 缺失时不渲染 Image 显示占位图
              //   原实现：用 attachment.storageKey 兜底,但 storageKey 不是合法 src,
              //   会触发 404。现在改为：previewUrl 缺失时显示占位气泡,
              //   不再 fallback 到 storageKey(用户能直观看到预览失效,而非看到损坏图)
              src={
                (attachment as ChatAttachment & { previewUrl?: string }).previewUrl ||
                FALLBACK_IMAGE_PLACEHOLDER
              }
              alt={attachment.name}
              loading="lazy"
              width={imageSize}
              height={imageSize}
              fallback={FALLBACK_IMAGE_PLACEHOLDER}
              style={{
                display: 'block',
                objectFit: 'cover',
                borderRadius: 16,
                overflow: 'hidden',
              }}
              preview={false}
            />
          ) : (
            <Flex
              key={attachment.id || attachment.storageKey}
              align="center"
              gap={8}
              onClick={() => {
                // ★ P6 点击历史文件触发 IPC_FILE.OPEN 走 shell.openPath
                if (window.electronAPI?.file?.open) {
                  void window.electronAPI.file.open(attachment.storageKey).catch((err: unknown) => {
                    // eslint-disable-next-line no-console
                    console.warn('[ChatMessageContent] open file failed:', err);
                  });
                }
              }}
              style={{
                maxWidth: 240,
                padding: '8px 10px',
                border: '1px solid rgba(0, 0, 0, 0.08)',
                borderRadius: 16,
                background: '#fff',
                cursor: 'pointer',
              }}
            >
              <FileOutlined />
              <Typography.Text ellipsis style={{ minWidth: 0, flex: 1 }}>
                {attachment.name}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatFileSize(attachment.size)}
              </Typography.Text>
            </Flex>
          ),
        )}
      </Flex>
    </Image.PreviewGroup>
  );
}

/**
 * ★ P6 辅助函数：格式化文件大小(B/KB/MB)
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 用户文本气泡（Phase 1: 使用 #171717 背景 + 白字） */
function UserTextBubble({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = text.length > USER_TEXT_COLLAPSE_THRESHOLD;
  const visibleText =
    shouldCollapse && !expanded
      ? `${text.slice(0, USER_TEXT_COLLAPSE_THRESHOLD).trimEnd()}\n...`
      : text;

  return (
    <div
      style={{
        alignSelf: 'flex-end',
        maxWidth: '100%',
        padding: '10px 14px',
        borderRadius: 22,
        background: '#171717',
        color: '#fff',
      }}
    >
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {visibleText}
      </div>
      {shouldCollapse ? (
        <Button
          type="link"
          size="small"
          onClick={() => setExpanded((current) => !current)}
          style={{
            height: 'auto',
            padding: '8px 0 0',
            color: '#fff',
          }}
        >
          {expanded ? '收起' : '更多'}
        </Button>
      ) : null}
    </div>
  );
}

export const ChatMessageContent = memo(function ChatMessageContent({
  message,
  toolSummaries,
  conversationId,
}: {
  message: ChatMessage;
  /**
   * 工具摘要列表（用于把 toolCall.name 解析为 displayName）
   * 对齐 E:\ai_fr\components\chat-message-content.tsx ChatMessageContentInner
   * 调用方传入（参考 chat-shell.tsx L2684-2738 传 config?.tools）
   */
  toolSummaries?: ToolSummary[];
  /**
   * ★ P6 当前会话 ID（用于附件图片异步 file:read 时的前缀校验）
   * 来自 ChatArea 传入,缺失时降级：仅使用已有 previewUrl/storageKey fallback
   */
  conversationId?: string | null;
}) {
  // ★ P6 异步获取图片 attachment 的 blob URL
  //   历史消息的图片 attachment 没有 previewUrl 字段,需要从主进程 readFile 后 URL.createObjectURL
  //   - 已有 previewUrl 的不重复请求
  //   - 非图片不处理
  //   - 组件卸载时 revoke 所有由本组件创建的 blob URL
  const imageAttachments: ChatAttachment[] = useMemo(() => {
    if (message.role !== 'user') return [];
    const attachments = message.attachments ?? [];
    return attachments.filter((att) => isImageContentType(att.contentType));
  }, [message]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  // ★ 修复 blobURL 过早撤销: 镜像最新 previewUrls, 供加载 effect 在不依赖 previewUrls 的前提下判断哪些附件仍缺有效预览 URL
  const previewUrlsRef = useRef<Record<string, string>>({});
  // ★ 修复 blobURL 过早撤销: 登记本组件创建的 blob URL, 组件卸载时统一 revoke, 不在 effect 重跑时提前撤销
  const createdUrlsRef = useRef<string[]>([]);
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const att of imageAttachments) {
      const existing = (att as ChatAttachment & { previewUrl?: string }).previewUrl;
      if (existing) {
        next[att.storageKey] = existing;
      }
    }
    // ★ Phase 3 P3-2 合并语义：异步获取的 previewUrl 不能被同步覆盖清空
    setPreviewUrls((prev) => ({ ...prev, ...next }));
  }, [imageAttachments]);
  // ★ 修复 blobURL 过早撤销: previewUrls 变化时同步镜像到 ref, 供下方加载 effect 的 needed 判断读取
  useEffect(() => {
    previewUrlsRef.current = previewUrls;
  }, [previewUrls]);
  useEffect(() => {
    if (!conversationId || imageAttachments.length === 0) {
      return;
    }
    if (!window.electronAPI?.file?.read) {
      return;
    }
    const needed = imageAttachments.filter(
      (att) => !previewUrlsRef.current[att.storageKey],
    );
    if (needed.length === 0) {
      return;
    }
    let cancelled = false;
    (async () => {
      for (const att of needed) {
        if (cancelled) return;
        try {
          const result = await window.electronAPI.file.read({
            conversationId,
            storageKey: att.storageKey,
          });
          if (cancelled) return;
          const blob = new Blob([result.data], { type: att.contentType });
          const url = URL.createObjectURL(blob);
          createdUrlsRef.current.push(url);
          setPreviewUrls((prev) => ({ ...prev, [att.storageKey]: url }));
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[ChatMessageContent] preview read failed:', err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // ★ 修复 blobURL 过早撤销: previewUrls 已移出依赖数组(needed 判断改读 previewUrlsRef 镜像),
    //   依赖变化重跑时不再提前 revoke 本次创建的 blob URL(否则 img 渲染时 src 已失效);
    //   统一交由下方卸载 effect 在组件卸载时 revoke createdUrlsRef 登记的 URL
  }, [conversationId, imageAttachments]);

  // ★ 修复 blobURL 过早撤销: 独立卸载 effect —— 仅在组件卸载时统一 revoke 本组件创建的全部 blob URL
  useEffect(() => {
    return () => {
      for (const url of createdUrlsRef.current) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    };
  }, []);

  // 用户消息
  if (message.role === 'user') {
    // ★ P6 历史消息附件回显：从 message.attachments 读取附件列表
    //   来源：本地乐观插入（useChat.sendMessage）+ chat:user-message-created 替换
    //        + conv:get-messages 从 SQLite 读出（由 listRendererMessages 填入）
    const rawAttachments: ChatAttachment[] = message.attachments ?? [];
    // ★ P6 用异步获取的 previewUrls 覆盖到 attachments
    const attachments: ChatAttachment[] = rawAttachments.map((att) => {
      const url = previewUrls[att.storageKey];
      if (url) {
        return { ...att, previewUrl: url } as ChatAttachment & { previewUrl?: string };
      }
      return att;
    });
    const text = message.content || '';

    // 渲染附件区域(Image.PreviewGroup + FileOutlined 文件条)
    const attachmentContent = renderUserAttachments(attachments);

    // 情况 1：仅附件无文本 → 仅显示附件（对齐 ai_fr，不渲染摘要气泡）
    if (!text && attachments.length > 0) {
      return (
        <Flex vertical align="flex-end" gap={8} style={{ width: '100%' }}>
          {attachmentContent}
        </Flex>
      );
    }

    // 情况 2：文本 + 附件 → 显示附件 + 文本（对齐 ai_fr，不渲染摘要气泡）
    if (text && attachmentContent) {
      return (
        <Flex vertical align="flex-end" gap={8} style={{ width: '100%' }}>
          {attachmentContent}
          <UserTextBubble text={text} />
        </Flex>
      );
    }

    // 情况 3：仅文本
    if (text) {
      return (
        <Flex vertical align="flex-end" gap={8} style={{ width: '100%' }}>
          <UserTextBubble text={text} />
        </Flex>
      );
    }

    // 兜底：空消息
    return (
      <Flex vertical align="flex-end" gap={8} style={{ width: '100%' }}>
        <UserTextBubble text="[空消息]" />
      </Flex>
    );
  }

  // 工具消息
  if (message.role === 'tool') {
    const toolInfo = message.toolCall;
    if (!toolInfo) {
      return null;
    }
    // 优先使用 ThoughtChain 渲染（更丰富的展示：执行耗时 + 思考/进度分离）
    // 若结构化字段缺失则退回 ToolCallCard 兜底
    if (toolInfo.startedAt || toolInfo.finishedAt) {
      return renderToolResultSegment(
        message.id,
        toolInfo,
        message.status === 'loading',
        message.createdAt,
        toolSummaries,
        { includeStructuredFilePreview: true, thinkingText: message.thinking, progressText: message.progress, content: message.content },
      );
    }
    return <ToolCallCard toolCall={toolInfo} />;
  }

  // 助理消息
  // ============================================================
  // Phase 3 P3-2 空泡过滤：finishReason='tool_calls' + content='\n\n' + reasoning 空时不渲染
  // 对齐 E:\ai_fr chat-shell.tsx L2355-2362
  // 由 lib/message-filter.ts 的 isEmptyAssistantBubble 实现
  // ============================================================
  if (isEmptyAssistantBubble(message)) {
    return null;
  }

  const content = message.content || '';
  const thinking = message.thinking || '';
  const toolCalls = message.toolCalls || [];

  if (
    !content.trim() &&
    !thinking.trim() &&
    toolCalls.length > 0 &&
    toolCalls.every(isDelegatedExecutorToolCall)
  ) {
    return null;
  }

  const segments = message.segments?.length
    ? message.segments
    : buildLegacySegments(thinking, toolCalls);

  // 加载中且无内容时显示 spinner
  if (
    !content &&
    segments.length === 0 &&
    message.status === 'loading'
  ) {
    return <Spin size="small" />;
  }

  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {segments.map((segment, index) => {
        // ★ A-1 修复：元素级结构防御（先判结构后读字段）——null/非对象元素跳过渲染，
        //   保证 render 期永不因 segments 元素结构抛 TypeError（畸形数据经读库净化 A-2 /
        //   渲染组装净化 A-3 后理论不可达，此处为最终消费兜底防御，二者并存）
        if (!segment || typeof segment !== 'object') {
          return null;
        }
        if (segment.type === 'reasoning') {
          // ★ A-1 修复：reasoning 段 text 非 string（缺失/null/数字等旧数据）归一 '' 再 trim
          const text =
            typeof segment.text === 'string' ? segment.text.trim() : '';

          if (!text) {
            return null;
          }

          const isActive =
            message.status === 'loading' && index === segments.length - 1;

          return (
            // S1-4 统一折叠策略：reasoning 段改用 ThinkingBlock（与 renderLoadingToolContent 思考块同源），
            //   超长内容非 loading 默认收起 + 字数摘要 + 摘要头 + 展开态滚动上限
            <ThinkingBlock
              key={`${segment.id}-${isActive ? 'active' : 'done'}`}
              content={text}
              loading={isActive}
              defaultExpanded={isActive}
              title={isActive ? '思考中' : '思考过程'}
            />
          );
        }

        const toolCall = toolCalls.find(
          (item) => item.callId === segment.toolCallId,
        );

        if (!toolCall) {
          return null;
        }

        if (isDelegatedExecutorToolCall(toolCall)) {
          return null;
        }

        if (message.status !== 'loading') {
          return null;
        }

        const isLoading = index === segments.length - 1;

        return (
          <div key={segment.id}>
            {renderToolCallSegment(toolCall, isLoading, toolSummaries)}
          </div>
        );
      })}

      {content ? (
        <RichMarkdown content={content} />
      ) : null}
    </Space>
  );
});
