/**
 * 渲染进程入口
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';

/**
 * ★ A-4 修复：全局渲染错误边界（class 组件 getDerivedStateFromError / componentDidCatch）
 * - React render 期异常（如畸形消息 segments 数据触发的 TypeError）不再整树卸载白屏：
 *   边界捕获后渲染兜底 UI（错误现场可见）+『重新加载』按钮触发应用级恢复路径；
 * - componentDidCatch 记录错误现场（console.error），不静默吞错掩盖缺陷；
 * - 边界仅作最终兜底，不替代 A-1（渲染消费防御）/A-2（读库净化）/A-3（组装净化），
 *   二者并存：防御负责数据层清除畸形，边界负责兜住防御之外的任何渲染期异常。
 */
interface AppErrorBoundaryProps {
  children: React.ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary] 渲染期异常已被全局边界捕获：', error, info);
  }

  private handleReload = (): void => {
    // 应用级恢复：重建整棵渲染树（渲染 state 全部重新初始化，避免半死 UI 残留）
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div
          style={{
            height: '100dvh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            background: '#f0f2f5',
            color: '#111827',
            fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
            padding: '0 24px',
            boxSizing: 'border-box',
          }}
        >
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>界面出现异常</h1>
          <p style={{ margin: 0, fontSize: 14, color: '#6b7280', textAlign: 'center' }}>
            渲染过程发生错误，已阻止整页白屏（错误现场已记录到控制台）。
          </p>
          {error && error.message ? (
            <pre
              style={{
                maxWidth: 720,
                maxHeight: 180,
                overflow: 'auto',
                background: '#ffffff',
                border: '1px solid #e5e7eb',
                borderRadius: 6,
                padding: '8px 12px',
                fontSize: 12,
                color: '#b91c1c',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {error.message}
            </pre>
          ) : null}
          <button
            onClick={this.handleReload}
            style={{
              marginTop: 8,
              padding: '6px 20px',
              fontSize: 14,
              fontWeight: 500,
              color: '#ffffff',
              background: '#2563eb',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * IPC 桥自检：preload 注入失败（window.electronAPI 缺失）时，
 * 在页面顶部显示显眼红条提示（不 throw、不阻断 App 渲染；桥存在时零影响）。
 */
if (!window.electronAPI) {
  const banner = document.createElement('div');
  banner.textContent =
    '⚠ IPC 桥未加载：preload 注入失败，会话/配置/技能等功能不可用。建议重启 npm run dev';
  banner.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:99999;box-sizing:border-box;background:#dc2626;color:#fff;padding:10px 16px;font-size:14px;font-weight:600;font-family:inherit;';
  document.body.appendChild(banner);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* ★ A-4 修复：全局错误边界包裹整棵应用树（App 内任何 render 期异常不再整树卸载白屏） */}
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
