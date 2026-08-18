/**
 * Python 内置环境状态指示器
 * 非 READY 时在底部显示简洁状态提示，就绪后自动消失
 */

import { useEffect, useState } from 'react';
import { theme } from 'antd';

type PythonStatus = {
  state: 'DETECTING' | 'DOWNLOADING' | 'EXTRACTING' | 'READY' | 'FAILED';
  progress?: number;
  error?: string;
  pythonPath?: string;
};

export interface PythonStatusBarProps {
  /** 当 Python 配置面板打开时隐藏状态栏，默认 false */
  hideWhenPanelOpen?: boolean;
}

export function PythonStatusBar(props: PythonStatusBarProps = {}) {
  const { token } = theme.useToken();
  const [status, setStatus] = useState<PythonStatus | null>(null);

  useEffect(() => {
    const api = window.electronAPI?.python;
    if (!api) {
      return;
    }

    // 初始查询状态
    api.getStatus().then((initialStatus) => {
      setStatus(initialStatus);
    }).catch(() => {
      // IPC 不可用，忽略
    });

    // 订阅状态变更
    const unsubscribe = api.onStatusChanged((newStatus) => {
      setStatus(newStatus);
    });

    return unsubscribe;
  }, []);

  const { hideWhenPanelOpen } = props;

  // READY 或未初始化时不显示；面板打开时也隐藏
  if (!status || status.state === 'READY' || hideWhenPanelOpen) {
    return null;
  }

  // 构建提示文本
  let text = '正在准备 Python 环境...';
  if (status.state === 'DOWNLOADING' && typeof status.progress === 'number') {
    text = `正在准备 Python 环境... ${status.progress}%`;
  } else if (status.state === 'EXTRACTING') {
    text = '正在配置 Python 环境...';
  } else if (status.state === 'FAILED') {
    text = `Python 环境准备失败${status.error ? `: ${status.error}` : ''}`;
  }

  const isFailed = status.state === 'FAILED';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '4px 12px',
        fontSize: 12,
        color: isFailed ? token.colorError : token.colorTextTertiary,
        backgroundColor: isFailed
          ? token.colorErrorBg
          : token.colorFillSecondary,
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        userSelect: 'none',
        lineHeight: '20px',
        minHeight: 28,
      }}
    >
      <span>{text}</span>
    </div>
  );
}
