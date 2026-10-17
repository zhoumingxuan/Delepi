/**
 * ToolCallGroupCard —— 小工具调用折叠分组容器（视觉方案 §2：多小工具调用折叠聚合）
 *
 * 用途：主智能体单轮内连续 ≥1 个【小工具】调用（tool 消息、非委派）在渲染层聚合为
 *   单一分组容器；折叠态=单行组头（状态图标 + 「工具调用」 + 按工具分项统计 + 展开箭头）；
 *   展开态=子卡纵列（逐字复用 ChatMessageContent 现状渲染，零改动）。
 * 边界：任意数量均折叠（阈值由 ChatArea.buildToolCallRenderUnits 控制，本组件不感知）；
 *   委派任务卡不参与聚合并作为分组边界（同上）。
 *
 * 状态（resolveToolGroupStatus，优先级：运行中 > 错误 > 中止 > 成功）：
 * - 未手动操作时：存在运行中子项默认展开；全部结束默认折叠；
 * - 手动点击/键盘切换后固定该组状态（userToggled），不再自动切换。
 *
 * 交互：整行点击切换；Enter/Space 切换；箭头旋转 0°↔90°；hover 背景；focus-visible 焦点环。
 * 样式：.chat-tool-group*（globals.css，chat- 前缀自有命名）。
 */

import { memo, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { ChatMessageContent, resolveToolDisplayName } from './ChatMessageContent';
import type { ToolSummary } from './ChatMessageContent';
import type { ChatMessage } from '../hooks/useChat';

/** 分组聚合状态（优先级：运行中 > 错误 > 中止 > 成功） */
export type ToolGroupStatus = 'loading' | 'error' | 'abort' | 'success';

/**
 * 聚合组状态判定（组头图标；子项各自的原状态图标不删）：
 * - 任一子项运行中（message.status==='loading' 或 toolCall.status==='loading'）→ 'loading'；
 * - 任一子项错误（status==='error' 或 toolCall.status==='error' 或 toolCall.isError）→ 'error'；
 * - 任一子项中止（message.status==='abort'）→ 'abort'；
 * - 其余（全部成功）→ 'success'。
 */
export function resolveToolGroupStatus(messages: ChatMessage[]): ToolGroupStatus {
  let hasLoading = false;
  let hasError = false;
  let hasAbort = false;
  for (const message of messages) {
    if (message.status === 'loading' || message.toolCall?.status === 'loading') {
      hasLoading = true;
    }
    if (
      message.status === 'error' ||
      message.toolCall?.status === 'error' ||
      message.toolCall?.isError === true
    ) {
      hasError = true;
    }
    if (message.status === 'abort') {
      hasAbort = true;
    }
  }
  if (hasLoading) return 'loading';
  if (hasError) return 'error';
  if (hasAbort) return 'abort';
  return 'success';
}

interface ToolCallGroupCardProps {
  /** 组内小工具消息（连续 ≥1 条，按消息序列原顺序） */
  messages: ChatMessage[];
  /** 工具摘要（透传给子卡 ChatMessageContent；当前全链为空） */
  toolSummaries?: ToolSummary[];
  /** 当前会话 ID（透传） */
  conversationId?: string | null;
  /** executor 任务卡面板上下文（透传；组内子卡均为小工具，正常不触发） */
  executorPanel?: {
    onOpenPanel: (delegateCallId: string) => void;
    activeDelegateCallId: string | null;
  };
}

export const ToolCallGroupCard = memo(function ToolCallGroupCard({
  messages,
  toolSummaries,
  conversationId,
  executorPanel,
}: ToolCallGroupCardProps): ReactElement {
  /** 手动切换态：null=未手动（跟随状态默认）；true/false=已手动固定 */
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const status = resolveToolGroupStatus(messages);
  const expanded = userToggled ?? (status === 'loading');
  const toggle = () => setUserToggled((prev) => !(prev ?? (status === 'loading')));
  /**
   * 组头分项统计：聚合键 = resolveToolDisplayName 的返回标签（toolSummaries → 内置映射 → 原始名），
   * 顺序 = 组内首次出现顺序（不排序）；同显示名合并计数；缺失 name 的消息跳过不计。
   */
  const toolStats = useMemo(() => {
    const stats: { label: string; count: number }[] = [];
    for (const message of messages) {
      const toolName = message.toolCall?.name;
      if (!toolName) continue;
      const label = resolveToolDisplayName(toolName, toolSummaries);
      const hit = stats.find((item) => item.label === label);
      if (hit) hit.count += 1;
      else stats.push({ label, count: 1 });
    }
    return stats;
  }, [messages, toolSummaries]);
  const statusIcon = status === 'loading' ? (
    <LoadingOutlined />
  ) : status === 'error' ? (
    <CloseCircleOutlined />
  ) : status === 'abort' ? (
    <MinusCircleOutlined />
  ) : (
    <CheckCircleOutlined />
  );

  return (
    <div className="chat-tool-group">
      <div
        className="chat-tool-group-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={
          toolStats.length > 0
            ? `工具调用，共 ${messages.length} 个：${toolStats.map(({ label, count }) => `${label} ${count} 次`).join('，')}`
            : `工具调用，共 ${messages.length} 个`
        }
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <span className={`chat-tool-group-status chat-tool-group-status-${status}`}>
          {statusIcon}
        </span>
        <span className="chat-tool-group-title">工具调用</span>
        <span className="chat-tool-group-stats">
          {toolStats.map(({ label, count }) => `${label} ×${count}`).join(' · ')}
        </span>
        <RightOutlined
          className={
            expanded
              ? 'chat-tool-group-chevron chat-tool-group-chevron-expanded'
              : 'chat-tool-group-chevron'
          }
        />
      </div>
      {expanded ? (
        <div className="chat-tool-group-body">
          {messages.map((message) => (
            <ChatMessageContent
              key={message.id}
              message={message}
              toolSummaries={toolSummaries}
              conversationId={conversationId}
              executorPanel={executorPanel}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
});
