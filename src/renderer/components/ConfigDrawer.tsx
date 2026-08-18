/**
 * ConfigDrawer 配置抽屉组件
 * 配置项：API/模型/视觉识别 + Python 环境（双 Tab 布局）
 * 客户端单主题：antd v6 ConfigProvider 默认值
 */

import {
  type ReactElement,
  memo,
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  Button,
  Divider,
  Drawer,
  Flex,
  Form,
  Input,
  Radio,
  Switch,
  Tabs,
  Typography,
  App as AntApp,
  theme as antdTheme,
} from 'antd';
import {
  ApiOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  EyeOutlined,
} from '@ant-design/icons';
import type { AppSettings } from '@shared/types/config';
import { PythonEnvTab } from './PythonEnvTab';

interface ConfigDrawerProps {
  open: boolean;
  onClose: () => void;
  config: AppSettings;
  configLoading: boolean;
  onSave: (key: keyof AppSettings, value: unknown) => Promise<void> | void;
  onSaveAll: (updates: Partial<AppSettings>) => Promise<void> | void;
  onReload: () => Promise<void> | void;
  /** 外部控制当前激活的 Tab（不传时内部自管） */
  activeTab?: string;
  /** Tab 切换回调 */
  onTabChange?: (tab: string) => void;
}

export const ConfigDrawer = memo(function ConfigDrawer({
  open,
  onClose,
  config,
  configLoading,
  onSave,
  // onSaveAll / onReload 保留接口兼容性但不再使用（按钮已移除）
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onSaveAll: _onSaveAll,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onReload: _onReload,
  activeTab: externalActiveTab,
  onTabChange,
}: ConfigDrawerProps): ReactElement {
  const { token } = antdTheme.useToken();
  const { message: antdMessage } = AntApp.useApp();
  const [form] = Form.useForm<AppSettings>();

  // 视觉模型三字段是否未配置（用于视觉识别开关旁轻量提示）
  const visionLlmUnconfigured = !config.visionLlmBaseUrl
    || !config.visionLlmApiKey
    || !config.visionLlmModel;

  const calcDrawerWidth = useCallback(() => {
    const w = window.innerWidth;
    if (w >= 1200) return Math.min(700, Math.round(w * 0.38));
    if (w >= 900) return Math.round(w * 0.45);
    return Math.max(320, Math.round(w * 0.8));
  }, []);

  const [drawerWidth, setDrawerWidth] = useState(calcDrawerWidth);

  useEffect(() => {
    let frameId: number;
    const handleResize = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        setDrawerWidth(calcDrawerWidth());
      });
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(frameId);
    };
  }, [calcDrawerWidth]);

  // ---- Tab 状态：外部控制优先，否则内部自管 ----
  const [internalActiveTab, setInternalActiveTab] = useState('model');
  const activeKey = externalActiveTab ?? internalActiveTab;

  const handleTabChange = useCallback(
    (key: string) => {
      if (onTabChange) {
        onTabChange(key);
      } else {
        setInternalActiveTab(key);
      }
    },
    [onTabChange],
  );

  const handleSave = useCallback(
    async (key: keyof AppSettings) => {
      try {
        const value = form.getFieldValue(key);
        await onSave(key, value);
      } catch (err) {
        antdMessage.error('保存失败');
      }
    },
    [form, onSave, antdMessage],
  );



  return (
    <Drawer
      title="配置"
      placement="right"
      closable={false}
      width={drawerWidth}
      open={open}
      onClose={onClose}
      styles={{
        body: {
          padding: `${token.paddingMD}px ${token.paddingLG}px`,
          background: token.colorBgContainer,
        },
      }}
    >
      <Flex vertical gap={token.paddingMD} style={{ height: '100%' }}>
        <Tabs
          activeKey={activeKey}
          onChange={handleTabChange}
          destroyInactiveTabPane={false}
          items={[
            {
              key: 'model',
              label: '模型配置',
              children: (
                <Form
                  form={form}
                  layout="vertical"
                  initialValues={config}
                  disabled={configLoading}
                >
                  {/* 主智能体配置 */}
                  <div style={{
                    borderLeft: `3px solid ${token.colorPrimary}`,
                    background: token.colorBgContainer,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: token.borderRadius,
                    padding: 16,
                    marginBottom: 24,
                  }}>
                    <Typography.Title level={5} style={{ fontSize: 14, fontWeight: 500, color: token.colorText, marginTop: 0, marginBottom: token.paddingMD }}>
                      <Flex align="center" gap={token.paddingXS}>
                        <ApiOutlined /> 主智能体
                      </Flex>
                    </Typography.Title>

                    <Form.Item label={<span style={{ color: token.colorTextSecondary, fontSize: 13 }}>Base URL</span>} name="mainModelBaseUrl">
                      <Input
                        placeholder="https://api.example.com/v1"
                        onBlur={() => handleSave('mainModelBaseUrl')}
                      />
                    </Form.Item>

                    <Form.Item label={<span style={{ color: token.colorTextSecondary, fontSize: 13 }}>API Key</span>} name="mainModelApiKey">
                      <Input.Password
                        placeholder="sk-..."
                        onBlur={() => handleSave('mainModelApiKey')}
                      />
                    </Form.Item>

                    <Form.Item label={<span style={{ color: token.colorTextSecondary, fontSize: 13 }}>模型名称</span>} name="mainModelName">
                      <Input
                        placeholder="选择模型"
                        onBlur={() => handleSave('mainModelName')}
                      />
                    </Form.Item>

                    <Form.Item
                      label={<span style={{ color: token.colorTextSecondary, fontSize: 13 }}>支持多模态协议</span>}
                      name="mainModelMultimodal"
                      valuePropName="checked"
                      extra={!config.visionEnabled ? '视觉识别已关闭，此开关暂不生效' : undefined}
                    >
                      <Switch
                        disabled={!config.visionEnabled}
                        onChange={(value) => onSave('mainModelMultimodal', value)}
                      />
                    </Form.Item>
                  </div>

                  {/* 子智能体配置 */}
                  <div style={{
                    borderLeft: `3px solid ${token.colorWarning}`,
                    background: token.colorBgContainer,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: token.borderRadius,
                    padding: 16,
                    marginBottom: 24,
                  }}>
                    <Typography.Title level={5} style={{ fontSize: 14, fontWeight: 500, color: token.colorText, marginTop: 0, marginBottom: token.paddingMD }}>
                      <Flex align="center" gap={token.paddingXS}>
                        <ThunderboltOutlined /> 子智能体
                      </Flex>
                    </Typography.Title>

                    <Form.Item label={<span style={{ color: token.colorTextSecondary, fontSize: 13 }}>Base URL</span>} name="executorModelBaseUrl">
                      <Input
                        placeholder="https://api.example.com/v1"
                        onBlur={() => handleSave('executorModelBaseUrl')}
                      />
                    </Form.Item>

                    <Form.Item label={<span style={{ color: token.colorTextSecondary, fontSize: 13 }}>API Key</span>} name="executorModelApiKey">
                      <Input.Password
                        placeholder="sk-..."
                        onBlur={() => handleSave('executorModelApiKey')}
                      />
                    </Form.Item>

                    <Form.Item label={<span style={{ color: token.colorTextSecondary, fontSize: 13 }}>模型名称</span>} name="executorModelName">
                      <Input
                        placeholder="选择模型"
                        onBlur={() => handleSave('executorModelName')}
                      />
                    </Form.Item>

                    <Form.Item
                      label={<span style={{ color: token.colorTextSecondary, fontSize: 13 }}>思考程度</span>}
                      name="executorThinkingLevel"
                    >
                      <Radio.Group
                        onChange={(e) => onSave('executorThinkingLevel', e.target.value)}
                        style={{ display: 'flex', gap: 16 }}
                      >
                        <Radio value="low">
                          <span style={{ fontSize: 13, fontWeight: 500, color: token.colorText }}>低</span>
                          <span style={{ fontSize: 12, color: token.colorTextSecondary, marginLeft: 8 }}>更快响应</span>
                        </Radio>
                        <Radio value="high">
                          <span style={{ fontSize: 13, fontWeight: 500, color: token.colorText }}>高</span>
                          <span style={{ fontSize: 12, color: token.colorTextSecondary, marginLeft: 8 }}>均衡推理</span>
                        </Radio>
                        <Radio value="max">
                          <span style={{ fontSize: 13, fontWeight: 500, color: token.colorText }}>最大</span>
                          <span style={{ fontSize: 12, color: token.colorTextSecondary, marginLeft: 8 }}>深度推理（默认）</span>
                        </Radio>
                      </Radio.Group>
                    </Form.Item>
                  </div>

                  {/* 视觉识别配置 */}
                  <div style={{
                    borderLeft: `3px solid ${token.colorSuccess}`,
                    background: token.colorBgContainer,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: token.borderRadius,
                    padding: 16,
                    marginBottom: 24
                  }}>
                    <Typography.Title level={5} style={{ fontSize: 14, fontWeight: 500, color: token.colorText, marginTop: 0, marginBottom: token.paddingMD }}>
                      <Flex align="center" gap={token.paddingXS}>
                        <EyeOutlined /> 视觉识别
                      </Flex>
                    </Typography.Title>

                    <Form.Item
                      label={<span style={{ color: token.colorTextSecondary, fontSize: 13 }}>启用视觉识别</span>}
                      name="visionEnabled"
                      valuePropName="checked"
                      extra={visionLlmUnconfigured ? '视觉模型 API 未配置，图片识别会报错' : undefined}
                    >
                      <Switch
                        onChange={(value) => {
                          if (value) {
                            antdMessage.info('开启视觉识别需配置模型 API，否则图片识别会报错');
                          }
                          onSave('visionEnabled', value);
                        }}
                      />
                    </Form.Item>

                    <Form.Item label={<span style={{ color: token.colorTextSecondary, fontSize: 13 }}>Base URL</span>} name="visionLlmBaseUrl">
                      <Input
                        disabled={configLoading || !config.visionEnabled}
                        placeholder="https://api.example.com/v1"
                        onBlur={() => handleSave('visionLlmBaseUrl')}
                      />
                    </Form.Item>

                    <Form.Item label={<span style={{ color: token.colorTextSecondary, fontSize: 13 }}>API Key</span>} name="visionLlmApiKey">
                      <Input.Password
                        disabled={configLoading || !config.visionEnabled}
                        placeholder="sk-..."
                        onBlur={() => handleSave('visionLlmApiKey')}
                      />
                    </Form.Item>

                    <Form.Item label={<span style={{ color: token.colorTextSecondary, fontSize: 13 }}>模型名称</span>} name="visionLlmModel">
                      <Input
                        disabled={configLoading || !config.visionEnabled}
                        placeholder="选择模型"
                        onBlur={() => handleSave('visionLlmModel')}
                      />
                    </Form.Item>
                  </div>

                </Form>
              ),
            },
            {
              key: 'python',
              label: 'Python 环境',
              children: <PythonEnvTab />,
            },
          ]}
        />


      </Flex>
    </Drawer>
  );
});
