/**
 * 工具调用卡片组件
 * 基于 @ant-design/x ThoughtChain 组件
 * 实时计时器 + 加载中思考/进度分离（对齐 E:\ai_fr\components\chat-message-content.tsx）
 *
 * Phase 3 P0-2 适配层：
 * - 加载中：拆分 result 字段为 thinking / progress 两段，渲染双 Think 块
 *   - thinking → ThinkingBlock title="思考中..." / "思考过程"
 *   - progress → ThinkingBlock title="工具调用中..." / "工具进度"
 * - result 为空时：显示"执行中..."占位
 */

import { ThoughtChain } from '@ant-design/x';
import { Flex, Typography } from 'antd';
import { memo } from 'react';
import { RichMarkdown } from './RichMarkdown';
import { ThinkingBlock } from './ThinkingBlock';
import { splitLoadingToolContent } from '../lib/executor-thinking';
import { ExecutionElapsedTime } from '../hooks/useElapsedSeconds';


function isJsonString(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function renderResultContent(value: string): string {
  if (isJsonString(value)) {
    const pretty = JSON.stringify(JSON.parse(value), null, 2);
    return ['```json', pretty, '```'].join('\n');
  }

  return value;
}

export interface ToolCallInfo {
  callId: string;
  name: string;
  arguments: string;
  result?: string;
  status: 'loading' | 'success' | 'error';
  startedAt?: string;
  finishedAt?: string;
  // 消息/快照创建时刻：startedAt 缺失时的计时兜底来源（对齐 ai_fr chat-message-content.tsx:352-358
  // payload.startedAt ?? createdAt——回退消息创建时刻而非渲染时刻，避免计时起点错位）
  createdAt?: string;
  isError?: boolean;
  isDelegatedExecutor?: boolean;
}

/**
 * 加载中双 Think 渲染（Phase 3 P0-2）
 * - result 非空：拆分 thinking / progress，渲染两个 ThinkingBlock
 * - result 为空：显示"执行中..."占位
 */
function LoadingToolContent({ result }: { result: string }) {
  if (!result || !result.trim()) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        执行中...
      </Typography.Text>
    );
  }

  const { thinking, progress } = splitLoadingToolContent(result);

  if (!progress) {
    // 无进度文本：按单一思考块渲染
    return <ThinkingBlock content={result} loading />;
  }

  return (
    <Flex vertical gap={8} style={{ width: '100%' }}>
      {thinking ? (
        <ThinkingBlock content={thinking} loading={false} />
      ) : null}
      <ThinkingBlock
        content={progress}
        loading
        defaultExpanded
        title="工具调用中..."
      />
    </Flex>
  );
}

export const ToolCallCard = memo(function ToolCallCard({
  toolCall,
}: {
  toolCall: ToolCallInfo;
}) {
  const { name, status, result, startedAt, finishedAt, createdAt, isError } = toolCall;
  const loading = status === 'loading';

  const shouldShowElapsed = loading || Boolean(startedAt);
  const titleContent = shouldShowElapsed ? (
    <Flex align="center" gap={8}>
      <span>{name}</span>
      <ExecutionElapsedTime
        active={loading}
        startedAt={startedAt ?? createdAt ?? new Date().toISOString()}
        finishedAt={loading ? undefined : finishedAt}
      />
    </Flex>
  ) : (
    <span>{name}</span>
  );

  if (loading && result) {
    // 加载中显示思考过程（双 Think 分离）
    return (
      <div style={{ width: '100%', maxWidth: '100%', minWidth: 0 }}>
        <ThoughtChain
          className="chat-tool-result-chain"
          items={[
            {
              key: toolCall.callId,
              title: titleContent,
              content: <LoadingToolContent result={result} />,
              status: 'loading',
            },
          ]}
        />
      </div>
    );
  }

  const displayContent = result ? renderResultContent(result) : '';

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
            key: toolCall.callId,
            title: titleContent,
            content: displayContent ? (
              <RichMarkdown content={displayContent} />
            ) : null,
            status: loading ? 'loading' : isError ? 'error' : 'success',
            collapsible: !loading,
          },
        ]}
      />
    </div>
  );
});
