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
  *   标题栏显示摘要头（前 80 字符 + '…'）
 * - loading 流式期间保持展开（轮内可见性优先），滚动上限生效 + 尾部自动滚动
 * - 展开态滚动高度上限：内容容器 maxHeight + overflowY auto，避免长思考撑爆消息流
 *   （消息流唯一滚动容器在 ChatArea scrollRef，折叠落点在组件内部，不涉及外层容器）
 */

import { Think } from '@ant-design/x';
import { memo, useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { RichMarkdown, STREAMING_ACTIVE, STREAMING_FLUSHED } from './RichMarkdown';

/** 超长思考折叠阈值：超过则非 loading 态默认收起并显示字数摘要 */
const LONG_THINKING_COLLAPSE_THRESHOLD = 2000;
/** 收起态摘要头长度（前 N 字符 + '…'） */
const LONG_THINKING_SUMMARY_HEAD_CHARS = 80;
/** 展开态内容滚动高度上限（px） */
const LONG_THINKING_EXPANDED_MAX_HEIGHT_PX = 320;
/**
 * ★ P06 流式 loading 态内容高度上限（px）：比完成态 320 收紧——流式期间用户主要关注尾部，
 * 更小的驻留高度直接压缩流式窗口 DOM 高度基数（根因 R6 流式变体）；可按体验反馈调整
 */
const STREAMING_CONTENT_MAX_HEIGHT_PX = 240;
/** ★ P06 跟底恢复阈值（px）：距底 ≤ 该值视为"回到底部"，恢复自动跟底 */
const FOLLOW_TAIL_RESUME_PX = 24;

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

  // ★ P06 跟底状态机：默认跟底；用户在内滚容器内上滚（距底 > FOLLOW_TAIL_RESUME_PX）→ 停止
  //   自动贴底（可自由回看已生成内容）；滚回底部（距底 ≤ 阈值）→ 自动恢复跟底。
  //   程序化贴底（scrollTop=scrollHeight）触发本事件时距底为 0 → 自动保持跟底，无冲突。
  const followTailRef = useRef(true);
  const handleContentScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    followTailRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_TAIL_RESUME_PX;
  }, []);

  // S1-4 尾部自动滚动：loading 流式期间内容增长时保持视口贴底
  // ★ P05 reflow 节流：scrollHeight 读+写经 rAF 对齐——同一帧内多次增量只执行一次强制布局
  //   （905 增量/轮场景下强制布局次数从事件频率降至帧率）；卸载/依赖变化时取消挂起帧
  // ★ P06：贴底条件升级为 followTailRef 状态机（用户上滚停跟/回底恢复）
  const scrollRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isLoading) return;
    if (scrollRafRef.current !== null) return; // 本帧已调度 → 合帧跳过
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollRef.current;
      if (el && followTailRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
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

  // S1-4 标题栏：超长内容附加摘要头（收起态即可见，不依赖展开）
  const resolvedTitle: ReactNode = isLongContent ? (
    <div>
      <div>{baseTitle}</div>
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
      {/* ★ P06 流式高度上限治理：条件扩展为 isLongContent || isLoading——流式全程有内滚容器
             （0→2000 字区间不再无上限撑高消息流）；maxHeight 按 loading 态取 240px / 完成态
             维持既有 320px 治理（L82-88 折叠策略与 L92-101 标题栏逐字未动）。
             loading→done ≤2000 字切换时容器移除、高度释放为全高（一次性高度跳变=已知标注项，
             ChatArea 贴底/stick 语义兜底视觉） */}
      {(isLongContent || isLoading) ? (
        <div
          ref={scrollRef}
          onScroll={handleContentScroll}
          style={{
            maxHeight: isLoading ? STREAMING_CONTENT_MAX_HEIGHT_PX : LONG_THINKING_EXPANDED_MAX_HEIGHT_PX,
            overflowY: 'auto',
          }}
        >
          {/* ★ P01: loading 传 hasNextChunk:true（增量缓存+未闭合token占位）；loading→false 传 false 触发 flush，终态渲染与现状逐字一致 */}
          <RichMarkdown content={text} streaming={isLoading ? STREAMING_ACTIVE : STREAMING_FLUSHED} />
        </div>
      ) : (
        <RichMarkdown content={text} streaming={isLoading ? STREAMING_ACTIVE : STREAMING_FLUSHED} />
      )}
    </Think>
  );
});
