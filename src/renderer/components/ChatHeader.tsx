/**
 * ChatHeader 顶部栏组件
 * 对齐 ai-client ChatHeader.tsx 样式
 */

import { useState, type ReactElement } from 'react';
import { Button, Input, Typography, theme } from 'antd';
import { SettingOutlined, MenuOutlined, EditOutlined } from '@ant-design/icons';

const { Title } = Typography;

/** 方向3：标题编辑入口配置（提供时标题旁显示编辑按钮，点击进入编辑态） */
export interface ChatHeaderEditable {
  /** 当前会话 ID（供提交侧定位会话） */
  conversationId: string;
  /** 提交重命名（由父层接线，如 useChat.renameConversation） */
  onRename: (title: string) => void | Promise<void>;
}

interface ChatHeaderProps {
  title: string;
  subtitle?: string | undefined;
  isRunning?: boolean | undefined;
  showMenuButton?: boolean | undefined;
  onMenuClick?: (() => void) | undefined;
  onSettingsClick?: (() => void) | undefined;
  /** 方向3：可选编辑入口（未提供时保持现状渲染，零差异） */
  editable?: ChatHeaderEditable | undefined;
}

export function ChatHeader({
  title,
  subtitle,
  isRunning = false,
  showMenuButton = false,
  onMenuClick,
  onSettingsClick,
  editable,
}: ChatHeaderProps): ReactElement {
  const { token } = theme.useToken();

  // 方向3：标题编辑态（点击编辑图标进入；回车/失焦提交，Esc 取消）
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');

  const startEditing = () => {
    setDraftTitle(title);
    setEditing(true);
  };

  const submitRename = () => {
    const value = draftTitle.trim();
    setEditing(false);
    if (editable && value && value !== title) {
      void editable.onRename(value);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexShrink: 0,
        alignItems: 'center',
        gap: 12,
        padding: '16px 24px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        zIndex: 1,
      }}
    >
      {showMenuButton ? (
        <Button
          type="text"
          icon={<MenuOutlined />}
          onClick={onMenuClick}
        />
      ) : null}

      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <Input
            size="small"
            value={draftTitle}
            autoFocus
            onChange={(event) => setDraftTitle(event.target.value)}
            onPressEnter={submitRename}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setEditing(false);
              }
            }}
            onBlur={submitRename}
            style={{ maxWidth: 360, fontSize: 16 }}
          />
        ) : (
          <Title
            level={4}
            ellipsis
            style={{ margin: 0, fontSize: 20 }}
          >
            {title}
          </Title>
        )}
        {subtitle ? (
          <Typography.Text
            type="secondary"
            ellipsis
            style={{ fontSize: 13, display: 'block' }}
          >
            {subtitle}
          </Typography.Text>
        ) : null}
      </div>

      {editable && !editing ? (
        <Button
          type="text"
          size="small"
          icon={<EditOutlined />}
          onClick={startEditing}
          title="重命名对话"
        />
      ) : null}

      {onSettingsClick ? (
        <Button
          type="text"
          icon={<SettingOutlined />}
          onClick={onSettingsClick}
        >
          配置
        </Button>
      ) : null}
    </div>
  );
}
