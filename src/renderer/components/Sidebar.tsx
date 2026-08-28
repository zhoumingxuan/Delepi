/**
 * Sidebar 侧边栏组件
 * 对齐 ai-client Sidebar.tsx 结构
 *
 * Phase 1 样式基础：
 * - 使用 antd theme.useToken() 引用 token
 * - 删除对 var(--color-accent) 的依赖
 */

import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { MenuProps } from 'antd';
import {
  Button,
  Dropdown,
  Flex,
  Input,
  Modal,
  Tag,
  Typography,
  theme,
} from 'antd';
import {
  PlusOutlined,
  MessageOutlined,
  MoreOutlined,
  DeleteOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { Conversations } from '@ant-design/x';

const { Text } = Typography;

export interface SidebarConversation {
  id: string;
  title: string;
  isRunning?: boolean;
  createdAt: string;
  updatedAt?: string;
  /** 方向3：会话标签（ChatShell 映射不透传时由 Sidebar 内部自治拉取兜底） */
  tags?: string[];
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

export const Sidebar = memo(function Sidebar({
  conversations,
  activeConversationId,
  hoveredConversationId,
  onNewChat,
  onSwitchConversation,
  onRemoveConversation,
  onHoverConversation,
}: SidebarProps): ReactElement {
  const { token } = theme.useToken();

  // ============================================================
  // 方向3：重命名 + 标签（内部自治实现——ChatShell 不在方向3白名单内，
  // 无法新增 props 接线，故直接消费 preload 暴露的 conversations API；
  // electron.d.ts 类型墙用局部断言，方向4同款先例）
  // ============================================================

  const convExtApi = (window.electronAPI?.conversations ?? {}) as Partial<{
    list: () => Promise<Array<SidebarConversation & { tags?: string[] }>>;
    rename: (params: { id: string; title: string }) =>
      Promise<(SidebarConversation & { tags?: string[] }) | null>;
    removeTag: (params: { id: string; tag: string }) =>
      Promise<(SidebarConversation & { tags?: string[] }) | null>;
  }>;

  /** 会话 → 标签（内部自治数据源：conv:list 聚合返回） */
  const [tagsById, setTagsById] = useState<Record<string, string[]>>({});
  /** 重命名乐观覆盖层：props title 落地前本地即时生效 */
  const [titleOverrides, setTitleOverrides] = useState<Record<string, string>>({});
  /** 重命名弹窗状态 */
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');

  /** 会话 id 集合签名（避免 conversations 引用变化触发重复拉取） */
  const conversationIdsKey = useMemo(
    () => conversations.map((conversation) => conversation.id).join(','),
    [conversations],
  );

  // 拉取全量标签（mount + 会话集合变化时；乐观更新先行，此处校正）
  useEffect(() => {
    let cancelled = false;
    const loadTags = async () => {
      if (!convExtApi.list) return;
      try {
        const list = await convExtApi.list();
        if (cancelled || !Array.isArray(list)) return;
        const next: Record<string, string[]> = {};
        for (const item of list) {
          next[item.id] = item.tags ?? [];
        }
        setTagsById(next);
      } catch (err) {
        console.error('[Sidebar] 加载会话标签失败:', err);
      }
    };
    void loadTags();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationIdsKey]);

  // 乐观覆盖清除：props title 已与覆盖值一致（conv:updated 推送落地）时移除覆盖
  useEffect(() => {
    setTitleOverrides((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      const next = { ...prev };
      let changed = false;
      for (const conversation of conversations) {
        if (next[conversation.id] !== undefined && conversation.title === next[conversation.id]) {
          delete next[conversation.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [conversations]);

  /** 重命名提交：乐观覆盖 + conv:rename（主进程安全关闭在途标题生成） */
  const submitRename = useCallback(
    async (id: string, rawTitle: string) => {
      const title = rawTitle.trim();
      setRenameTarget(null);
      if (!title || !convExtApi.rename) return;
      setTitleOverrides((prev) => ({ ...prev, [id]: title }));
      try {
        await convExtApi.rename({ id, title });
      } catch (err) {
        console.error('[Sidebar] 重命名失败:', err);
        setTitleOverrides((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** 移除标签：乐观移除 + conv:tag-remove */
  const handleRemoveTag = useCallback(
    async (id: string, tag: string) => {
      if (!convExtApi.removeTag) return;
      setTagsById((prev) => ({
        ...prev,
        [id]: (prev[id] ?? []).filter((item) => item !== tag),
      }));
      try {
        const updated = await convExtApi.removeTag({ id, tag });
        if (updated?.tags) {
          setTagsById((prev) => ({ ...prev, [id]: updated.tags ?? [] }));
        }
      } catch (err) {
        console.error('[Sidebar] 移除标签失败:', err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );


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

              // 方向3：重命名 / 标签管理 / 删除（既有删除项保持不动）
              const menuItems: MenuProps['items'] = [
                {
                  key: 'rename',
                  label: '重命名',
                  icon: <EditOutlined />,
                },
                { type: 'divider' },
                {
                  key: 'delete',
                  label: '删除',
                  icon: <DeleteOutlined />,
                  danger: true,
                },
              ];

              // 展示态：乐观覆盖优先（重命名即时生效），标签合并内部自治数据
              const displayTitle = titleOverrides[conversation.id] ?? conversation.title;
              const displayTags = tagsById[conversation.id] ?? conversation.tags ?? [];

              return {
                key: conversation.id,
                group: conversationGroupByDate(conversation.updatedAt || conversation.createdAt),
                onMouseEnter: () => onHoverConversation(conversation.id),
                onMouseLeave: () =>
                  onHoverConversation(
                    hoveredConversationId === conversation.id ? null : hoveredConversationId,
                  ),
                label: (
                  <Flex vertical gap={2} style={{ width: '100%', minWidth: 0 }}>
                  <Flex
                    align="center"
                    justify="space-between"
                    gap={8}
                    style={{ width: '100%' }}
                  >
                    <Typography.Text ellipsis style={{ flex: 1, minWidth: 0 }}>
                      {displayTitle}
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
                          } else if (info.key === 'rename') {
                            setRenameValue(displayTitle);
                            setRenameTarget({ id: conversation.id, title: displayTitle });
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
                  {displayTags.length > 0 ? (
                    <Flex gap={4} wrap="wrap" style={{ width: '100%' }}>
                      {displayTags.map((tag) => (
                        <Tag
                          key={tag}
                          closable
                          onClose={(event) => {
                            event?.preventDefault?.();
                            void handleRemoveTag(conversation.id, tag);
                          }}
                          style={{ marginInlineEnd: 0, fontSize: 12, lineHeight: '18px' }}
                        >
                          {tag}
                        </Tag>
                      ))}
                    </Flex>
                  ) : null}
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

      {/* 方向3：重命名弹窗（乐观覆盖 + conv:rename，主进程安全关闭在途标题生成） */}
      <Modal
        title="重命名对话"
        open={renameTarget !== null}
        okText="确定"
        cancelText="取消"
        okButtonProps={{ disabled: !renameValue.trim() }}
        onOk={() => {
          if (renameTarget) {
            void submitRename(renameTarget.id, renameValue);
          }
        }}
        onCancel={() => setRenameTarget(null)}
        destroyOnClose
      >
        <Input
          value={renameValue}
          autoFocus
          maxLength={28}
          placeholder="输入新的对话标题"
          onChange={(event) => setRenameValue(event.target.value)}
          onPressEnter={() => {
            if (renameTarget && renameValue.trim()) {
              void submitRename(renameTarget.id, renameValue);
            }
          }}
        />
      </Modal>
    </Flex>
  );
});
