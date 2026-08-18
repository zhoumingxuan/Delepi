/**
 * 思考链展示组件
 * 基于 @ant-design/x Think 组件
 *
 * Phase 3 P0-2 适配层：
 * - 接受 title 可选参数（"思考中..." / "思考过程" / "工具调用中..." / "工具进度"）
 * - 加载中默认 title="思考中..."（与原行为一致）
 * - 非加载默认 title="思考过程"（与原行为一致）
 */

import { Think } from '@ant-design/x';
import { memo } from 'react';
import { RichMarkdown } from './RichMarkdown';

export const ThinkingBlock = memo(function ThinkingBlock({
  content,
  loading = false,
  defaultExpanded,
  title,
}: {
  content: string;
  loading?: boolean;
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

  if (!text) {
    return null;
  }

  const resolvedTitle =
    title ?? (loading ? '思考中...' : '思考过程');

  return (
    <Think
      title={resolvedTitle}
      loading={loading}
      defaultExpanded={defaultExpanded ?? loading}
    >
      <RichMarkdown content={text} />
    </Think>
  );
});
