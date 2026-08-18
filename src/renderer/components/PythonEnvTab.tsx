/**
 * PythonEnvTab — Python 环境配置组件
 *
 * 功能：
 * - Radio 二选一：内置 Python（推荐）/ 自定义 Python 环境
 * - 7 种状态条件渲染
 * - IPC 订阅 python:status-changed 实时更新内置 Python 状态
 * - 配置读写通过 useSettings hook（config.useBuiltinPython + saveConfig）
 * - 自定义环境支持浏览选择 Python 解释器
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
import PythonDepsPanel from './PythonDepsPanel';

const { Title, Text } = Typography;

// ---------------------------------------------------------------------------
// 本地类型（对齐 main/types/python.d.ts）
// ---------------------------------------------------------------------------

type PythonStatus = {
  state: 'DETECTING' | 'DOWNLOADING' | 'EXTRACTING' | 'INSTALLING_PIP' | 'INSTALLING_DEPS' | 'READY' | 'FAILED';
  progress?: number;
  error?: string;
  pythonPath?: string;
};

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

  // ---- 内置 Python 状态（IPC 驱动） ----
  const [builtinStatus, setBuiltinStatus] = useState<PythonStatus | null>(null);


  // ===== IPC 订阅：内置 Python 状态 =====
  useEffect(() => {
    const api = window.electronAPI?.python;
    if (!api) return;

    // 初始查询
    api.getStatus().then(setBuiltinStatus).catch(() => {});

    // 订阅状态变更
    const unsubscribe = api.onStatusChanged(setBuiltinStatus);
    return unsubscribe;
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
  const builtinReady = builtinStatus?.state === 'READY';
  const builtinIsDownloading = builtinStatus?.state === 'DOWNLOADING';
  const builtinIsDetecting = builtinStatus?.state === 'DETECTING';
  const builtinIsExtracting = builtinStatus?.state === 'EXTRACTING';
  const builtinProgress = builtinStatus?.progress;
  const builtinFailed = builtinStatus?.state === 'FAILED';


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
      // ---- 内置 Python ----

      // A: 内置就绪
      if (builtinReady) {
        return (
          <div style={containerStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <CheckCircleOutlined style={{ ...iconStyle, color: token.colorSuccess }} />
              <Text style={{ fontSize: 14, fontWeight: 500, color: token.colorText }}>
                已就绪
              </Text>
            </div>
            {builtinStatus?.pythonPath && (
              <Text
                copyable
                style={{
                  fontSize: 12,
                  fontFamily: monoFont.fontFamily,
                  color: token.colorTextTertiary,
                  wordBreak: 'break-all',
                }}
              >
                {builtinStatus.pythonPath}
              </Text>
            )}
          </div>
        );
      }

      // B: 内置未就绪 / 下载中 / 失败
      if (builtinIsDownloading && typeof builtinProgress === 'number') {
        return (
          <div style={containerStyle}>
            <Progress percent={builtinProgress} size="small" style={{ marginBottom: 8 }} />
            <Text style={{ fontSize: 12, color: token.colorTextSecondary }}>
              正在下载... {builtinProgress}%
            </Text>
          </div>
        );
      }

      // C: 检测中
      if (builtinIsDetecting) {
        return (
          <div style={containerStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <LoadingOutlined style={{ ...iconStyle, color: token.colorPrimary }} />
              <Text style={{ fontSize: 14, fontWeight: 500, color: token.colorText }}>
                正在检测内置 Python...
              </Text>
            </div>
          </div>
        );
      }

      // D: 安装中（解压）
      if (builtinIsExtracting) {
        return (
          <div style={containerStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <LoadingOutlined style={{ ...iconStyle, color: token.colorPrimary }} />
              <Text style={{ fontSize: 14, fontWeight: 500, color: token.colorText }}>
                正在安装 Python...
              </Text>
            </div>
          </div>
        );
      }

      // 未下载 / 失败
      // 当 useBuiltin 为 true 时，失败/未就绪状态由 PythonDepsPanel 统一处理
      // （PythonDepsPanel 提供更完整的错误展示和"安装"按钮）
      // 仅在 PythonDepsPanel 不会被渲染时才在此处展示
      if (useBuiltin) {
        return null;
      }
      return (
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          marginTop: 16,
          padding: '12px 16px',
          borderLeft: `3px solid ${token.colorError}`,
          backgroundColor: token.colorErrorBg,
          borderRadius: token.borderRadius,
        }}>
          <WarningOutlined style={{ fontSize: 16, color: token.colorError, marginTop: 2, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 14, fontWeight: 500, color: token.colorText, lineHeight: '22px' }}>
              {builtinStatus === null
                ? '尚未检测内置 Python 状态'
                : builtinFailed
                  ? `内置 Python 准备失败`
                  : '内置 Python 尚未就绪'}
            </Text>
            {builtinFailed && builtinStatus?.error && (
              <Text style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 4, display: 'block' }}>
                {builtinStatus.error}
              </Text>
            )}
          </div>
        </div>
      );
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
      {useBuiltin && <PythonDepsPanel pythonReady={builtinReady} pythonStatus={builtinStatus} />}
    </div>
  );
}
