/**
 * 渲染进程入口
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';

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
    <App />
  </React.StrictMode>,
);
