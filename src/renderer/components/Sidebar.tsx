/**
 * Sidebar 侧边栏组件
 * 对齐 ai-client Sidebar.tsx 结构
 *
 * Phase 1 样式基础：
 * - 使用 antd theme.useToken() 引用 token
 * - 删除对 var(--color-accent) 的依赖
 */

import { useMemo, type ReactElement } from 'react';
import type { MenuProps } from 'antd';
import {
  Button,
  Dropdown,
  Flex,
  Typography,
  theme,
} from 'antd';
import {
  PlusOutlined,
  MessageOutlined,
  MoreOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { Conversations } from '@ant-design/x';

const { Text } = Typography;

export interface SidebarConversation {
  id: string;
  title: string;
  isRunning?: boolean;
  createdAt: string;
  updatedAt?: string;
}

interface SidebarProps {
  conversations: SidebarConversation[];
  activeConversationId: string | null;
  hoveredConversationId: string | null;
  onNewChat: () => void;
  onSwitchConversation: (id: string) => void;
  onRemoveConversation: (id: string) => void;
  onHoverConversation: (id: string | null) => void;
}

/**
 * 按日期分组（对齐 ai-client conversationGroupByDate）
 */
function conversationGroupByDate(isoDate: string): string {
  const input = new Date(isoDate);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfInput = new Date(input.getFullYear(), input.getMonth(), input.getDate());
  const diffDays = Math.floor(
    (startOfToday.getTime() - startOfInput.getTime()) / (24 * 60 * 60 * 1000),
  );

  if (diffDays <= 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays <= 7) return '7天前';
  if (diffDays <= 30) return '30天前';
  return '更早';
}

const GROUP_PRIORITY: Record<string, number> = {
  '今天': 0,
  '昨天': 1,
  '7天前': 2,
  '30天前': 3,
  '更早': 4,
};

export function Sidebar({
  conversations,
  activeConversationId,
  hoveredConversationId,
  onNewChat,
  onSwitchConversation,
  onRemoveConversation,
  onHoverConversation,
}: SidebarProps): ReactElement {
  const { token } = theme.useToken();


  const sortedConversations = useMemo(() => {
    return [...conversations].sort((a, b) => {
      const groupA = conversationGroupByDate(a.updatedAt || a.createdAt);
      const groupB = conversationGroupByDate(b.updatedAt || b.createdAt);
      const priA = GROUP_PRIORITY[groupA] ?? 99;
      const priB = GROUP_PRIORITY[groupB] ?? 99;
      return priA - priB;
    });
  }, [conversations]);

  return (
    <Flex
      vertical
      gap={12}
      style={{
        width: '100%',
        height: '100%',
        padding: 16,
        background: token.colorBgLayout,
      }}
    >
      <Button
        type="primary"
        icon={<PlusOutlined />}
        block
        onClick={onNewChat}
        style={{ flexShrink: 0 }}
      >
        新建对话
      </Button>

      {!sortedConversations.length ? (
        <Flex
          vertical
          align="center"
          justify="center"
          style={{
            flex: 1,
            minHeight: 0,
            borderRadius: token.borderRadiusLG,
            background: token.colorBgContainer,
            border: `1px dashed ${token.colorBorderSecondary}`,
          }}
        >
          <Flex vertical align="center" gap={8}>
            <MessageOutlined
              style={{ fontSize: 32, color: token.colorTextQuaternary }}
            />
            <Text type="secondary" style={{ fontSize: 13 }}>
              暂无会话
            </Text>
            <Text
              type="secondary"
              style={{ fontSize: 12, color: token.colorTextQuaternary }}
            >
              点击上方按钮新建
            </Text>
          </Flex>
        </Flex>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <Conversations
            style={{ width: '100%' }}
            activeKey={activeConversationId ?? undefined}
            items={sortedConversations.map((conversation) => {
              const showAction =
                hoveredConversationId === conversation.id ||
                activeConversationId === conversation.id;

              const menuItems: MenuProps['items'] = [
                {
                  key: 'delete',
                  label: '删除',
                  icon: <DeleteOutlined />,
                  danger: true,
                },
              ];

              return {
                key: conversation.id,
                group: conversationGroupByDate(conversation.updatedAt || conversation.createdAt),
                onMouseEnter: () => onHoverConversation(conversation.id),
                onMouseLeave: () =>
                  onHoverConversation(
                    hoveredConversationId === conversation.id ? null : hoveredConversationId,
                  ),
                label: (
                  <Flex
                    align="center"
                    justify="space-between"
                    gap={8}
                    style={{ width: '100%' }}
                  >
                    <Typography.Text ellipsis style={{ flex: 1, minWidth: 0 }}>
                      {conversation.title}
                    </Typography.Text>
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: menuItems,
                        onClick: (info) => {
                          info.domEvent.preventDefault();
                          info.domEvent.stopPropagation();
                          if (info.key === 'delete') {
                            onRemoveConversation(conversation.id);
                          }
                        },
                      }}
                    >
                      <Button
                        type="text"
                        size="small"
                        icon={<MoreOutlined />}
                        style={{
                          opacity: showAction ? 1 : 0,
                          pointerEvents: showAction ? 'auto' : 'none',
                          transition: 'opacity 0.15s',
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                      />
                    </Dropdown>
                  </Flex>
                ),
              };
            })}
            groupable
            styles={{
              root: {
                width: '100%',
                padding: 0,
              },
              item: {
                width: '100%',
                boxSizing: 'border-box',
                borderRadius: token.borderRadius,
              },
            }}
            onActiveChange={(value) => {
              onSwitchConversation(String(value));
            }}
          />
        </div>
      )}
    </Flex>
  );
}
