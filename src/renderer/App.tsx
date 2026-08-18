/**
 * 根组件
 * 整合 ChatShell + 单主题 ConfigProvider
 *
 * Phase 1 样式基础：
 * - 单主题 token 体系（沿用 operation_strategy.md 第 4.2/4.3 节）
 * - 删除双主题切换（Phase 6 完整执行主题移除，本阶段先做基础清理）
 */

import { ConfigProvider, App as AntApp, theme } from 'antd';
import type { ThemeConfig } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { ChatShell } from './components/ChatShell';

/**
 * 单主题 baseToken（沿用 operation_strategy.md 第 4.3 节）
 * 本项目旧 CSS 变量 → antd v6 token 映射（详见 4.2 节）
 */
const baseToken: ThemeConfig['token'] = {
  colorPrimary: '#2563eb',
  colorInfo: '#2563eb',
  colorSuccess: '#16a34a',
  colorBgLayout: '#f0f2f5',
  colorBgContainer: '#fafbfc',
  colorBgElevated: '#ffffff',
  colorText: '#111827',
  colorTextSecondary: '#6b7280',
  colorBorder: '#e5e7eb',
  colorBorderSecondary: '#e5e7eb',
  borderRadius: 6,
  borderRadiusLG: 8,
  borderRadiusSM: 4,
  boxShadow: 'none',
  boxShadowSecondary: 'none',
  boxShadowTertiary: 'none',
  controlHeight: 40,
  controlHeightLG: 44,
  fontSize: 15,
  fontSizeLG: 16,
  lineWidth: 1,
  fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
};

export default function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: baseToken,
        components: {
          Button: {
            contentFontSize: 15,
            primaryShadow: 'none',
          },
        },
      }}
    >
      <AntApp>
        <ChatShell />
      </AntApp>
    </ConfigProvider>
  );
}
