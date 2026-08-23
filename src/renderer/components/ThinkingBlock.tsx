/**
 * 思考链展示组件
 * 基于 @ant-design/x Think 组件
 *
 * Phase 3 P0-2 适配层：
 * - 接受 title 可选参数（"思考中..." / "思考过程" / "工具调用中..." / "工具进度"）
 * - 加载中默认 title="思考中..."（与原行为一致）
 * - 非加载默认 title="思考过程"（与原行为一致）
 *
 * S1-4 方向1前端治理（展示层治理，存储层全量）：
 * - 超长折叠：内容超过 LONG_THINKING_COLLAPSE_THRESHOLD 字符时，非 loading 态默认收起，
 *   标题栏显示字数摘要（如 "思考过程（约 12,400 字）"）+ 摘要头（前 80 字符 + '…'）
 * - loading 流式期间保持展开（轮内可见性优先），滚动上限生效 + 尾部自动滚动
 * - 展开态滚动高度上限：内容容器 maxHeight + overflowY auto，避免长思考撑爆消息流
 *   （消息流唯一滚动容器在 ChatArea scrollRef，折叠落点在组件内部，不涉及外层容器）
 */

import { Think } from '@ant-design/x';
import { memo, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { RichMarkdown } from './RichMarkdown';

/** 超长思考折叠阈值：超过则非 loading 态默认收起并显示字数摘要 */
const LONG_THINKING_COLLAPSE_THRESHOLD = 2000;
/** 收起态摘要头长度（前 N 字符 + '…'） */
const LONG_THINKING_SUMMARY_HEAD_CHARS = 80;
/** 展开态内容滚动高度上限（px） */
const LONG_THINKING_EXPANDED_MAX_HEIGHT_PX = 320;

function formatCharCount(count: number): string {
  return count.toLocaleString('zh-CN');
}

export const ThinkingBlock = memo(function ThinkingBlock({
  content,
  loading = false,
  defaultExpanded,
  title,
}: {
  content: string;
  loading?: boolean | ReactNode;
  defaultExpanded?: boolean;
  /**
   * 自定义标题（Phase 3 P0-2）
   * - 思考内容：默认 "思考中..." / "思考过程"
   * - 工具进度：传 "工具调用中..." / "工具进度"
   * - 不传则使用原默认值
   */
  title?: string;
}) {
  const text = content.trim();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // loading 兼容 boolean | ReactNode（透传 Think 的 loading={<span />} 既有用法）
  const isLoading = Boolean(loading);

  // S1-4 尾部自动滚动：loading 流式期间内容增长时保持视口贴底
  useEffect(() => {
    if (isLoading && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [text, isLoading]);

  if (!text) {
    return null;
  }

  // S1-4 超长折叠策略：
  //   - 超长且非 loading → 默认收起（defaultExpanded 传入值被治理覆盖）
  //   - loading 流式期间保持既有展开语义（defaultExpanded ?? loading），滚动上限生效
  const isLongContent = text.length > LONG_THINKING_COLLAPSE_THRESHOLD;
  const resolvedDefaultExpanded = isLongContent && !isLoading
    ? false
    : (defaultExpanded ?? isLoading);

  const baseTitle = title ?? (isLoading ? '思考中...' : '思考过程');

  // S1-4 标题栏：超长内容附加字数摘要 + 摘要头（收起态即可见，不依赖展开）
  const resolvedTitle: ReactNode = isLongContent ? (
    <div>
      <div>{baseTitle}（约 {formatCharCount(text.length)} 字）</div>
      <div style={{ fontSize: 12, opacity: 0.65, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {text.slice(0, LONG_THINKING_SUMMARY_HEAD_CHARS)}
        {text.length > LONG_THINKING_SUMMARY_HEAD_CHARS ? '…' : ''}
      </div>
    </div>
  ) : baseTitle;

  return (
    <Think
      title={resolvedTitle}
      loading={loading}
      defaultExpanded={resolvedDefaultExpanded}
    >
      {isLongContent ? (
        <div
          ref={scrollRef}
          style={{ maxHeight: LONG_THINKING_EXPANDED_MAX_HEIGHT_PX, overflowY: 'auto' }}
        >
          <RichMarkdown content={text} />
        </div>
      ) : (
        <RichMarkdown content={text} />
      )}
    </Think>
  );
});
