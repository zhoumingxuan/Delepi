/**
 * 清理对话弹窗（三合一：范围勾选 + 实时预览统计 + danger 确认）
 * - 范围：空会话（0 条消息）+ 按时间五组（组名与 Sidebar.tsx GROUP_PRIORITY 逐字一致）
 * - 预览：勾选变化即调 conv:cleanup-preview（未勾选不发请求并清空统计）
 * - 确认：danger「确认清理」；执行期间 confirmLoading 且禁止关闭（mask/Esc/取消/右上角）
 * - onOk 以当前 options 调宿主传入的 async onOk，由其 Promise 控制确认按钮 loading（宿主抛错则弹窗保持打开）
 */

import { useEffect, useState } from 'react';
import { Checkbox, Modal, Typography, theme } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import {
  CONVERSATION_DATE_GROUPS,
  type ConversationCleanupOptions,
  type ConversationCleanupPreview,
} from '@shared/types/conversation-cleanup';

const { Text } = Typography;

interface CleanupConversationsModalProps {
  open: boolean;
  onCancel: () => void;
  onOk: (options: ConversationCleanupOptions) => Promise<void>;
}

export function CleanupConversationsModal({
  open,
  onCancel,
  onOk,
}: CleanupConversationsModalProps) {
  const { token } = theme.useToken();
  const [options, setOptions] = useState<ConversationCleanupOptions>({
    removeEmpty: false,
    dateGroups: [],
  });
  const [preview, setPreview] = useState<ConversationCleanupPreview | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  // 重开弹窗重置勾选与统计（destroyOnClose 仅销毁 Modal children，组件自身 state 需显式重置；
  // 对齐方案交互定义：每次打开默认两项范围均未勾选）
  useEffect(() => {
    if (open) {
      setOptions({ removeEmpty: false, dateGroups: [] });
      setPreview(null);
    }
  }, [open]);

  const hasSelection = options.removeEmpty || options.dateGroups.length > 0;
  const deletableCount = preview?.deletableCount ?? 0;

  // 预览统计：open 且至少一项勾选时请求；未勾选不发请求并清空统计（cancelled 防晚到响应覆盖）
  useEffect(() => {
    if (!open) {
      return;
    }
    if (!options.removeEmpty && options.dateGroups.length === 0) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    window.electronAPI.conversations
      .cleanupPreview(options)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, options]);

  const handleCancel = () => {
    if (confirmLoading) return; // 执行中防误操作：mask/Esc/取消/右上角关闭全部失效
    onCancel();
  };

  const handleOk = async () => {
    setConfirmLoading(true);
    try {
      await onOk(options); // 宿主抛错则弹窗保持打开可重试
    } finally {
      setConfirmLoading(false);
    }
  };

  // 统计卡主行三分支：无勾选 / 有勾选但无可清理 / 将清理 N 个会话
  const renderSummary = () => {
    if (!hasSelection) {
      return (
        <Text type="secondary" style={{ fontSize: 13 }}>
          请先选择清理范围
        </Text>
      );
    }
    if (deletableCount === 0) {
      return (
        <Text type="secondary" style={{ fontSize: 13 }}>
          没有符合条件的会话
        </Text>
      );
    }
    return (
      <Text style={{ fontSize: 15, fontWeight: 600, color: token.colorText }}>
        将清理 {deletableCount} 个会话
      </Text>
    );
  };

  return (
    <Modal
      title="清理对话"
      open={open}
      width={440}
      destroyOnClose
      okText="确认清理"
      cancelText="取消"
      okButtonProps={{ danger: true, disabled: !hasSelection || deletableCount === 0 }}
      confirmLoading={confirmLoading}
      onCancel={handleCancel}
      onOk={handleOk}
      maskClosable={false}
      keyboard={false}
      closable={!confirmLoading}
    >
      <Text type="secondary" style={{ fontSize: 13, marginBottom: 12, display: 'block' }}>
        勾选要清理的会话范围，清理后无法恢复。
      </Text>

      <div style={{ marginBottom: 8 }}>
        <Checkbox
          checked={options.removeEmpty}
          onChange={(e) => setOptions((prev) => ({ ...prev, removeEmpty: e.target.checked }))}
        >
          空会话（没有任何消息）
          {preview ? (
            <span style={{ color: token.colorTextSecondary, fontSize: 13 }}>
              （{preview.emptyCount}）
            </span>
          ) : null}
        </Checkbox>
      </div>

      <Text type="secondary" style={{ fontSize: 13, display: 'block', margin: '4px 0 8px' }}>
        按时间清理
      </Text>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          rowGap: 8,
          columnGap: 12,
        }}
      >
        {CONVERSATION_DATE_GROUPS.map((group) => (
          <Checkbox
            key={group}
            checked={options.dateGroups.includes(group)}
            onChange={(e) =>
              setOptions((prev) => ({
                ...prev,
                dateGroups: e.target.checked
                  ? [...prev.dateGroups, group]
                  : prev.dateGroups.filter((item) => item !== group),
              }))
            }
          >
            {group}
            {preview ? (
              <span style={{ color: token.colorTextSecondary, fontSize: 13 }}>
                （{preview.dateGroupCounts[group] ?? 0}）
              </span>
            ) : null}
          </Checkbox>
        ))}
      </div>

      <div
        style={{
          background: token.colorBgLayout,
          padding: 12,
          borderRadius: 6,
          marginTop: 12,
          marginBottom: 8,
        }}
      >
        {renderSummary()}
        {hasSelection && preview && preview.runningCount > 0 ? (
          <div style={{ marginTop: 4 }}>
            <WarningOutlined style={{ fontSize: 14, color: token.colorWarning }} />
            <Text style={{ fontSize: 13, color: token.colorWarning, marginLeft: 4 }}>
              另有 {preview.runningCount} 个运行中会话将被跳过
            </Text>
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 8 }}>
        <WarningOutlined style={{ fontSize: 14, color: token.colorError }} />
        <Text style={{ fontSize: 13, color: token.colorError, marginLeft: 4 }}>
          删除后对话记录与会话文件将被永久删除，无法恢复。
        </Text>
      </div>
    </Modal>
  );
}
