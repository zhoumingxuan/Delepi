/**
 * ChatHeader 顶部栏组件
 * 对齐 ai-client ChatHeader.tsx 样式
 */

import type { ReactElement } from 'react';
import { Button, Typography, theme } from 'antd';
import { SettingOutlined, MenuOutlined } from '@ant-design/icons';

const { Title } = Typography;

interface ChatHeaderProps {
  title: string;
  subtitle?: string | undefined;
  isRunning?: boolean | undefined;
  showMenuButton?: boolean | undefined;
  onMenuClick?: (() => void) | undefined;
  onSettingsClick?: (() => void) | undefined;
}

export function ChatHeader({
  title,
  subtitle,
  isRunning = false,
  showMenuButton = false,
  onMenuClick,
  onSettingsClick,
}: ChatHeaderProps): ReactElement {
  const { token } = theme.useToken();

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
        <Title
          level={4}
          ellipsis
          style={{ margin: 0, fontSize: 20 }}
        >
          {title}
        </Title>
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
