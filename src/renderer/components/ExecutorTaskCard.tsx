/**
 * ExecutorTaskCard —— 运行中委派任务卡（新版设计方案 M7 / §6.1 视觉规格）
 *
 * 布局（替换现状运行中卡片的 ThinkingBlock×2 内容区）：
 * - 标题行：任务名（无显式文字样式，继承 ThoughtChain item title 默认值——与完成态
 *   ChatMessageContent 任务名观感一致；仅保留单行省略号溢出保护）+ 既有 ExecutionElapsedTime 计时；
 * - 思考行：最新一行思考（13px/20px colorTextSecondary，单行省略号；抽为 React.memo
 *   子组件 ThinkingLine：props 全原始值、无 key 无动画——值未变零重渲染零 DOM 变更，
 *   值变化仅原地更新文本节点；无思考时占位"执行子智能体正在执行…"）；
 * - 图标按钮：ProfileOutlined 24×24（Button text small），位于标题行 titleContent 的
 *   Flex 内、ExecutionElapsedTime 之后（marginLeft:auto 贴右、flexShrink:0、Flex
 *   align=center 垂直居中），点击打开右侧栏；三态：
 *   默认 colorTextTertiary / 悬停 colorText+colorFillTertiary / 激活（右栏正展示该任务）
 *   colorPrimary+colorPrimaryBg；aria-label="查看任务执行记录"。
 *
 * 容器沿用既有 ThoughtChain 单节点外框（chat-tool-result-chain，三层 min-width:0 链防溢出）；
 * 运行中不显示思考折叠块/工具调用块/任何工具名参数结果（数据源=executor 任务级思考，§1.4）。
 */

import { Flex } from 'antd';
import { ThoughtChain } from '@ant-design/x';
import { ProfileOutlined } from '@ant-design/icons';
import { Button, theme } from 'antd';
import { memo } from 'react';
import type { ReactElement } from 'react';
import { ExecutionElapsedTime } from '../hooks/useElapsedSeconds';
import type { ExecutorTaskBadge } from '../lib/executor-record-messages';

interface ThinkingLineProps {
  /** 最新一行思考文本（无思考条目时为占位文案） */
  lineText: string;
  /** 行文字颜色（token 原始字符串值） */
  lineColor: string;
  /** 行文字字号（px） */
  lineFontSize: number;
}

/**
 * 思考行渲染缓存子组件（防闪核心）：
 * - props 全部为原始值（string/number），上层 badge 对象引用变化不再传导；
 * - 无 key、无 CSS 动画：lineText 值变化时 React 原地更新同一 div 的文本节点
 *   （零 DOM 卸载重建、零动画重播）；三值均未变时 React.memo 浅比较跳过重渲染，
 *   零 DOM 变更。
 */
const ThinkingLine = memo(function ThinkingLine({
  lineText,
  lineColor,
  lineFontSize,
}: ThinkingLineProps): ReactElement {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        fontSize: lineFontSize,
        lineHeight: '20px',
        color: lineColor,
      }}
      title={lineText}
    >
      {lineText}
    </div>
  );
});

export function ExecutorTaskCard(options: {
  badge: ExecutorTaskBadge;
  onOpenPanel: (delegateCallId: string) => void;
  panelActive: boolean;
}): ReactElement {
  const { badge, onOpenPanel, panelActive } = options;
  const { token } = theme.useToken();

  const running = badge.status === 'running';
  const hasThinkingLine = Boolean(badge.latestThinkingLine);
  const lineText = badge.latestThinkingLine || '执行子智能体正在执行…';
  const lineColor = hasThinkingLine
    ? running
      ? token.colorTextSecondary
      : token.colorTextTertiary
    : token.colorTextTertiary;
  const lineFontSize = hasThinkingLine ? 13 : 12;

  const titleContent = (
    <Flex align="center" gap={8} style={{ minWidth: 0 }}>
      <span
        style={{
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        }}
      >
        {badge.taskName || '子智能体任务'}
      </span>
      <ExecutionElapsedTime
        active={running}
        startedAt={badge.startedAt}
        finishedAt={running ? undefined : badge.finishedAt ?? badge.startedAt}
      />
      {badge.hasRecords ? (
        <Button
          type="text"
          size="small"
          icon={<ProfileOutlined style={{ fontSize: 13 }} />}
          aria-label="查看任务执行记录"
          title="查看任务执行记录"
          onClick={(event) => {
            event.stopPropagation();
            onOpenPanel(badge.delegateCallId);
          }}
          style={{
            width: 24,
            height: 24,
            minWidth: 24,
            flexShrink: 0,
            marginLeft: 'auto',
            padding: 0,
            color: panelActive ? token.colorPrimary : token.colorTextTertiary,
            background: panelActive ? token.colorPrimaryBg : 'transparent',
          }}
        />
      ) : null}
    </Flex>
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
            key: badge.delegateCallId,
            title: titleContent,
            content: (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  height: 28,
                  width: '100%',
                  minWidth: 0,
                }}
              >
                <ThinkingLine
                  lineText={lineText}
                  lineColor={lineColor}
                  lineFontSize={lineFontSize}
                />
              </div>
            ),
            status: running ? 'loading' : badge.status === 'completed' ? 'success' : 'error',
            collapsible: false,
          },
        ]}
      />
    </div>
  );
}
