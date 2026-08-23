/**
 * PythonEnvTab — Python 环境配置组件
 *
 * 功能：
 * - Radio 二选一：内置 Python（推荐）/ 自定义 Python 环境
 * - 配置读写通过 useSettings hook（config.useBuiltinPython + saveConfig）
 * - 自定义环境支持浏览选择 Python 解释器
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  Button,
  Divider,
  Input,
  Progress,
  Radio,
  Typography,
  App as AntApp,
  theme,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  LoadingOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useSettings } from '../hooks/useSettings';

const { Title, Text } = Typography;

// ---------------------------------------------------------------------------
// 本地类型（对齐 main/types/python.d.ts）
// ---------------------------------------------------------------------------

type SystemPythonInfo = {
  found: boolean;
  pythonPath?: string;
  version?: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export function PythonEnvTab() {
  const { config, saveConfig } = useSettings();
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();

  // C1: 防抖定时器 ref（自定义路径输入框防抖500ms）
  const pathDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // C1: 清理防抖定时器
  useEffect(() => {
    return () => {
      if (pathDebounceRef.current !== null) {
        clearTimeout(pathDebounceRef.current);
      }
    };
  }, []);

  // ===== 下载内置 Python =====
  const handleDownload = useCallback(async () => {
    const api = window.electronAPI?.python;
    if (!api) {
      message.error('IPC 不可用');
      return;
    }
    try {
      await api.download();
      message.success('已开始下载内置 Python');
    } catch (err) {
      message.error(`下载失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [message]);

  // ===== 浏览自定义 Python =====
  const handleBrowse = useCallback(async () => {
    const api = window.electronAPI?.python;
    if (!api) {
      message.error('IPC 不可用');
      return;
    }

    try {
      const info = await api.selectCustom();
      if (info.pythonPath) {
        await saveConfig('customPythonPath', info.pythonPath);
      }
    } catch (err) {
      message.error(`选择失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [message, saveConfig]);

  // ===== Radio 切换 =====
  const handleRadioChange = useCallback(
    (e: unknown) => {
      const value = (e as { target: { value: boolean } }).target.value;
      saveConfig('useBuiltinPython', value);
    },
    [saveConfig],
  );

  // ===== 状态判定 =====
  const useBuiltin = config.useBuiltinPython;

  // ===== 公共样式 =====
  const monoFont = { fontFamily: token.fontFamilyCode ?? "'SF Mono','Cascadia Code',Consolas,monospace" };

  const iconStyle: React.CSSProperties = { fontSize: 14 };

  // ===== 渲染：Radio 区域 =====
  const renderRadio = () => (
    <Radio.Group
      value={useBuiltin}
      onChange={handleRadioChange}
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      {/* Radio #1: 内置 Python */}
      <Radio value={true}>
        <span style={{ fontSize: 14, fontWeight: 500, color: token.colorText }}>
          内置 Python
        </span>
        <span
          style={{
            display: 'inline-block',
            marginLeft: 8,
            padding: '0 8px',
            fontSize: 12,
            lineHeight: '20px',
            color: token.colorPrimary,
            backgroundColor: token.colorPrimaryBg,
            borderRadius: token.borderRadiusSM,
            border: `1px solid ${token.colorPrimaryBorder}`,
          }}
        >
          推荐
        </span>
        <br />
        <Text
          style={{
            fontSize: 12,
            fontWeight: 400,
            color: token.colorTextSecondary,
            marginTop: 0,
          }}
        >
          embeddable Python 3.14.6，自动管理
        </Text>
      </Radio>

      {/* Radio #2: 自定义 Python 环境 */}
      <Radio value={false}>
        <span style={{ fontSize: 14, fontWeight: 500, color: token.colorText }}>
          自定义 Python 环境
        </span>
        <br />
        <Text
          style={{
            fontSize: 12,
            fontWeight: 400,
            color: token.colorTextSecondary,
            marginTop: 0,
          }}
        >
          手动选择已安装的 Python 解释器
        </Text>
      </Radio>
    </Radio.Group>
  );

  // ===== 渲染：状态面板 =====
  const renderStatusPanel = () => {
    const containerStyle: React.CSSProperties = {
      marginTop: 16,
    };

    if (useBuiltin) {
      return null;
    }

    // ---- 自定义 Python ----
    return (
      <div style={containerStyle}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Input
            style={{ flex: 1 }}
            placeholder="请输入或选择 Python 解释器路径"
            value={config.customPythonPath || ''}
            onChange={(e) => {
              const value = e.target.value;
              // 防抖500ms后保存
              if (pathDebounceRef.current !== null) {
                clearTimeout(pathDebounceRef.current);
              }
              pathDebounceRef.current = setTimeout(() => {
                saveConfig('customPythonPath', value);
              }, 500);
            }}
          />
          <Button
            size="small"
            icon={<FolderOpenOutlined />}
            onClick={handleBrowse}
          >
            浏览...
          </Button>
        </div>
      </div>
    );
  };

  // ===== 主渲染 =====
  return (
    <div style={{ padding: 0 }}>
      <Title
        level={5}
        style={{
          marginTop: 0,
          marginBottom: 0,
          fontSize: 16,
          fontWeight: 500,
          color: token.colorText,
        }}
      >
        Python 环境
      </Title>

      <Divider style={{ margin: '8px 0 16px' }} />

      {renderRadio()}
      {renderStatusPanel()}
    </div>
  );
}
