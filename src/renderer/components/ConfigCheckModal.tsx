/**
 * ConfigCheckModal 配置检查 Modal 组件
 *
 * 功能：
 * - 消息发送前检测配置完整性，缺失时弹窗阻断
 * - 根据缺失类型渲染对应 Alert：llm_config → error，python_config → warning
 * - 底部 [我知道了] + [前往配置 →] 按钮
 * - 前往配置：关闭 Modal → 打开 ConfigDrawer 并切换到对应 Tab
 */

import { useCallback } from 'react';
import { Modal, Alert, Button, Space } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import type { ConfigMissingItem } from '../../shared/types/config';

// ---------------------------------------------------------------------------
// Props 接口（导出供 ChatShell 使用）
// ---------------------------------------------------------------------------

export interface ConfigCheckModalProps {
  /** 是否显示 Modal */
  open: boolean;
  /** 缺失的配置项列表 */
  missingItems: ConfigMissingItem[];
  /** 关闭 Modal 回调 */
  onClose: () => void;
  /** 前往配置回调，传入目标 Tab */
  onGoToConfig: (tab: 'model' | 'python') => void;
}

// ---------------------------------------------------------------------------
// Alert type 映射
// ---------------------------------------------------------------------------

const ALERT_TYPE_MAP: Record<ConfigMissingItem['type'], 'error' | 'warning'> = {
  llm_config: 'error',
  python_config: 'error',
};

// ---------------------------------------------------------------------------
// ConfigCheckModal 组件
// ---------------------------------------------------------------------------

export function ConfigCheckModal({
  open,
  missingItems,
  onClose,
  onGoToConfig,
}: ConfigCheckModalProps) {
  /**
   * 前往配置：关闭 Modal → 下一帧打开 ConfigDrawer 并切换 Tab
   * 取第一个缺失项的 targetTab 作为跳转目标
   */
  const handleGoToConfig = useCallback(() => {
    const targetTab = missingItems[0]?.targetTab ?? 'model';
    onClose();
    requestAnimationFrame(() => {
      onGoToConfig(targetTab);
    });
  }, [missingItems, onClose, onGoToConfig]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={480}
      centered
      closable
      title={
        <Space>
          <WarningOutlined style={{ color: '#faad14', fontSize: 16 }} />
          <span>配置未完成</span>
        </Space>
      }
      footer={
        <Space>
          <Button onClick={onClose}>我知道了</Button>
          <Button type="primary" onClick={handleGoToConfig}>
            前往配置 →
          </Button>
        </Space>
      }
    >
      {missingItems.map((item, idx) => (
        <Alert
          key={`${item.type}-${idx}`}
          type={ALERT_TYPE_MAP[item.type]}
          message={item.label}
          description={
            item.detail.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {item.detail.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            ) : undefined
          }
          style={{ marginBottom: idx < missingItems.length - 1 ? 12 : 0 }}
        />
      ))}
    </Modal>
  );
}
