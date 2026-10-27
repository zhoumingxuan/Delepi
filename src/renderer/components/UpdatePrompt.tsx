/**
 * 全局更新弹框（渲染层 antd Modal）
 *
 * 选型理由：
 * - 渲染层 Modal 不抢主进程事件循环，下载在后台流式进行，关闭弹框不中断下载；
 * - 主进程 dialog.showMessageBox 属系统模态框，会阻塞窗口交互，且无法承载进度条；
 * - 窗口数为 0（mac activate 且无窗口）时没有渲染层可挂载：状态与 promptKind 保存在主进程，
 *   窗口重建后由 getState + state-changed 重新驱动弹框，不会丢失「有新版本 / 可安装」提示。
 *
 * updateNotes 一律按纯文本渲染（React 默认转义），禁止任何 HTML 注入写法。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { App as AntApp, Button, Modal, Progress, Spin, Typography } from 'antd';
import { useUpdateState } from '../hooks/useUpdateState';

const { Text } = Typography;

// ---------------------------------------------------------------------------
// 更新说明（updateNotes）展示参数
// - 折叠态按「行」预览 6 行，行高取整数 22px：6 × 22 = 132px 与 maxHeight 严格相等，第 6 行完整可见；
//   旧值 13 × 1.7 = 22.1px，6 行 = 132.6px > maxHeight 132px → 第 6 行被裁掉 0.6px 并凭空出现纵向滚动条；
// - 展开态 11 行 × 22px = 242px：仍受高度上限约束，超出部分在容器内滚动，弹窗不会被长文本撑破；
// - 行高用 px 而非倍数：行高与容器高度都是整数，跨 DPI / 页面缩放不产生亚像素裁切差异。
// ---------------------------------------------------------------------------
const NOTES_PREVIEW_LINES = 6;
const NOTES_LINE_HEIGHT_PX = 22;
const NOTES_COLLAPSED_MAX_HEIGHT_PX = NOTES_PREVIEW_LINES * NOTES_LINE_HEIGHT_PX;
const NOTES_EXPANDED_LINES = 11;
const NOTES_EXPANDED_MAX_HEIGHT_PX = NOTES_EXPANDED_LINES * NOTES_LINE_HEIGHT_PX;
const NOTES_BODY_ID = 'update-prompt-notes-body';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '不到 1 秒';
  }
  const total = Math.ceil(seconds);
  const minutes = Math.floor(total / 60);
  const remainSeconds = total % 60;
  if (minutes <= 0) {
    return `${remainSeconds} 秒`;
  }
  return `${minutes} 分 ${remainSeconds} 秒`;
}

function describeStartFailure(code?: string): string {
  switch (code) {
    case 'ERR_UPDATE_BUSY':
      return '当前正在检查或下载，请稍候。';
    case 'ERR_UPDATE_NO_PACKAGE':
      return '新版本安装包未就绪。';
    case 'ERR_UPDATE_UNSUPPORTED_PLATFORM':
      return '当前系统不支持自动更新。';
    case 'ERR_UPDATE_BAD_VERSION':
      return '版本信息已变化，请重新检查。';
    default:
      return '下载未能开始，请重试。';
  }
}

export function UpdatePrompt() {
  const { snapshot } = useUpdateState();
  const { message } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);
  /** 更新说明正文容器：折叠态用它实测内容高度是否超出折叠上限 */
  const notesBodyRef = useRef<HTMLDivElement | null>(null);
  /** null = 尚未测量：首帧保守按「可展开」渲染，useLayoutEffect 在 paint 前完成测量并收敛，无可见跳变 */
  const [notesOverflowing, setNotesOverflowing] = useState<boolean | null>(null);
  const [speedBytesPerSecond, setSpeedBytesPerSecond] = useState(0);
  const lastSampleRef = useRef<{ bytes: number; at: number } | null>(null);

  const phase = snapshot?.phase ?? 'idle';
  const promptKey = snapshot?.promptKind
    ? `${snapshot.promptKind}:${snapshot.promptVersion ?? ''}`
    : null;

  useEffect(() => {
    if (promptKey && promptKey !== dismissedKey) {
      setOpen(true);
    }
  }, [promptKey, dismissedKey]);

  useEffect(() => {
    setNotesExpanded(false);
  }, [snapshot?.latestVersion]);

  useEffect(() => {
    // 检查结束且无更新 / 状态被重置时，关闭残留弹框（错误态与进行中态保持打开）
    if (!promptKey && (phase === 'idle' || phase === 'up-to-date')) {
      setOpen(false);
    }
  }, [promptKey, phase]);

  const progressBytes = snapshot?.progress?.receivedBytes ?? 0;
  useEffect(() => {
    if (phase !== 'downloading' || !snapshot?.progress) {
      lastSampleRef.current = null;
      setSpeedBytesPerSecond(0);
      return;
    }
    const now = Date.now();
    const previous = lastSampleRef.current;
    if (previous && now > previous.at) {
      const deltaBytes = snapshot.progress.receivedBytes - previous.bytes;
      if (deltaBytes >= 0) {
        setSpeedBytesPerSecond(deltaBytes / ((now - previous.at) / 1000));
      }
    }
    lastSampleRef.current = { bytes: snapshot.progress.receivedBytes, at: now };
  }, [phase, progressBytes, snapshot?.progress?.receivedBytes]);

  const closePrompt = (): void => {
    setOpen(false);
    setDismissedKey(promptKey ?? `${phase}`);
  };

  const handleDownload = async (): Promise<void> => {
    const api = window.electronAPI?.update;
    const version = snapshot?.latestVersion;
    if (!api || !version) {
      return;
    }
    setBusy(true);
    try {
      const result = await api.download({ version });
      if (!result.started) {
        message.warning(describeStartFailure(result.code));
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '下载未能开始，请重试。');
    } finally {
      setBusy(false);
    }
  };

  const handleInstall = async (): Promise<void> => {
    const api = window.electronAPI?.update;
    if (!api) {
      return;
    }
    setBusy(true);
    try {
      const result = await api.install({ version: snapshot?.latestVersion ?? undefined });
      if (!result.launched) {
        message.error(result.message ?? '安装程序未能启动，请重试。');
      } else if (result.message) {
        message.info(result.message);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '安装程序未能启动，请重试。');
    } finally {
      setBusy(false);
    }
  };

  const handleRetry = async (): Promise<void> => {
    if (phase === 'verify-failed') {
      await handleDownload();
      return;
    }
    const api = window.electronAPI?.update;
    if (!api) {
      return;
    }
    setBusy(true);
    try {
      const result = await api.check({ reason: 'manual' });
      if (!result.accepted) {
        message.info('请稍后再试。');
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '检查未能开始，请重试。');
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async (): Promise<void> => {
    const api = window.electronAPI?.update;
    if (!api) {
      return;
    }
    setBusy(true);
    try {
      await api.cancel();
    } finally {
      setBusy(false);
    }
  };

  const title = phase === 'downloaded'
    ? '更新已就绪'
    : phase === 'downloading'
      ? '正在下载更新'
      : phase === 'update-available'
        ? `发现新版本 ${snapshot?.latestVersion ?? ''}`
        : phase === 'checking'
          ? '正在检查更新'
          : phase === 'up-to-date'
            ? '已是最新版本'
            : '更新未完成';

  const errorText = phase === 'verify-failed'
    ? '安装包校验失败，已删除，可重试。'
    : phase === 'unauthorized'
      ? '更新地址或授权码不匹配。'
      : phase === 'network-failed'
        ? snapshot?.lastError?.code === 'ERR_UPDATE_WRITE'
          ? '下载失败，请重试。'
          : '检查失败，请重试。'
        : '';

  const totalBytes = snapshot?.progress?.totalBytes ?? 0;
  const receivedBytes = snapshot?.progress?.receivedBytes ?? 0;
  const percent = totalBytes > 0
    ? Math.min(100, Math.max(0, Math.round((receivedBytes / totalBytes) * 100)))
    : 0;
  const remainingBytes = Math.max(0, totalBytes - receivedBytes);
  const etaSeconds = speedBytesPerSecond > 0 ? remainingBytes / speedBytesPerSecond : null;
  const speedText = speedBytesPerSecond > 0
    ? ` · ${formatBytes(speedBytesPerSecond)}/s`
    : '';
  const etaText = etaSeconds !== null ? ` · 预计剩余 ${formatDuration(etaSeconds)}` : '';

  // updateNotes 可能为 null：先归一化换行再按「行」切分（只影响渲染，不改动数据本身）
  const notes = (snapshot?.updateNotes ?? '').replace(/\r\n?/g, '\n');
  const notesHasText = notes.trim().length > 0;
  const noteLines = notes.split('\n');
  const notesPreview = noteLines.slice(0, NOTES_PREVIEW_LINES).join('\n');
  /** 第 6 行之后是否还有非空行：纯空行不算「更多内容」，避免展开后什么也看不到 */
  const notesHasMoreLines = noteLines.slice(NOTES_PREVIEW_LINES).some((line) => line.trim().length > 0);

  // 折叠态实测：单个超长行会折成多个视觉行，行数 ≤ 6 也可能高于折叠上限 → 用 scrollHeight 兜底判定；
  // 展开态不重算，避免测量结果把「收起」入口吞掉（展开态恒显示入口）。
  // ResizeObserver 跟踪宽度变化（弹窗宽度/页面缩放会重新折行）；open / phase 变化补测一次（Modal 关闭、分支切换时容器不存在）。
  useLayoutEffect(() => {
    if (!open || phase !== 'update-available' || !notesHasText || notesExpanded) {
      return;
    }
    const element = notesBodyRef.current;
    if (!element) {
      return;
    }
    const measure = (): void => {
      setNotesOverflowing(element.scrollHeight > NOTES_COLLAPSED_MAX_HEIGHT_PX);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, phase, notesHasText, notesExpanded, notes]);

  const showNotesToggle = notesHasText && (notesExpanded || notesHasMoreLines || notesOverflowing !== false);

  const footer = (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      {phase === 'update-available' ? (
        <>
          <Button onClick={closePrompt}>稍后</Button>
          <Button
            type="primary"
            loading={busy}
            disabled={!snapshot?.hasPackage}
            onClick={() => { void handleDownload(); }}
          >
            确定
          </Button>
        </>
      ) : null}
      {phase === 'downloading' ? (
        <>
          <Button onClick={closePrompt}>后台继续</Button>
          <Button danger loading={busy} onClick={() => { void handleCancel(); }}>
            取消
          </Button>
        </>
      ) : null}
      {phase === 'downloaded' ? (
        <>
          <Button onClick={closePrompt}>稍后</Button>
          <Button type="primary" loading={busy} onClick={() => { void handleInstall(); }}>
            立即安装
          </Button>
        </>
      ) : null}
      {phase === 'verify-failed' || phase === 'network-failed' || phase === 'unauthorized' ? (
        <>
          <Button onClick={closePrompt}>稍后</Button>
          <Button type="primary" loading={busy} onClick={() => { void handleRetry(); }}>
            重试
          </Button>
        </>
      ) : null}
      {phase === 'checking' ? <Button onClick={closePrompt}>关闭</Button> : null}
      {phase === 'up-to-date' ? <Button onClick={closePrompt}>知道了</Button> : null}
    </div>
  );

  return (
    <Modal
      open={open}
      title={title}
      onCancel={closePrompt}
      footer={footer}
      maskClosable={false}
      width={480}
      zIndex={1200}
    >
      {phase === 'checking' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Spin size="small" />
          <Text>正在检查更新…</Text>
        </div>
      ) : null}

      {phase === 'update-available' ? (
        <div>
          <Text>新版本 {snapshot?.latestVersion} 可用，是否现在下载？</Text>
          {notesHasText ? (
            <div
              id={NOTES_BODY_ID}
              ref={notesBodyRef}
              style={{
                marginTop: 8,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 13,
                lineHeight: `${NOTES_LINE_HEIGHT_PX}px`,
                maxHeight: notesExpanded ? NOTES_EXPANDED_MAX_HEIGHT_PX : NOTES_COLLAPSED_MAX_HEIGHT_PX,
                overflowX: 'hidden',
                overflowY: notesExpanded ? 'auto' : 'hidden',
              }}
            >
              {notesExpanded ? notes : notesPreview}
            </div>
          ) : null}
          {showNotesToggle ? (
            <Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              aria-expanded={notesExpanded}
              aria-controls={NOTES_BODY_ID}
              aria-label={notesExpanded ? '收起全部更新说明' : '展开全部更新说明'}
              onClick={() => setNotesExpanded((value) => !value)}
            >
              {notesExpanded ? '收起' : '展开'}
            </Button>
          ) : null}
          {!snapshot?.hasPackage ? (
            <div style={{ marginTop: 8 }}>
              <Text type="warning">新版本安装包未就绪。</Text>
            </div>
          ) : null}
          {snapshot?.lastError?.code === 'ERR_UPDATE_DISK' ? (
            <div style={{ marginTop: 8 }}>
              <Text type="danger">磁盘空间不足，无法下载。</Text>
            </div>
          ) : null}
        </div>
      ) : null}

      {phase === 'downloading' ? (
        <div>
          <Progress percent={percent} status="active" />
          <Text type="secondary">
            {percent}%（{formatBytes(receivedBytes)} / {formatBytes(totalBytes)}）{speedText}{etaText}
          </Text>
          <div style={{ marginTop: 8 }}>
            <Text type="secondary">下载在后台进行，关闭此窗口不会中断。</Text>
          </div>
        </div>
      ) : null}

      {phase === 'downloaded' ? (
        <div>
          <Text>{snapshot?.latestVersion} 已下载，可安装。</Text>
          <div style={{ marginTop: 8 }}>
            <Text type="secondary">
              安装会启动系统安装程序；Windows 启动后会退出 Delepi，请先保存正在进行的任务。
            </Text>
          </div>
        </div>
      ) : null}

      {phase === 'up-to-date' ? (
        <Text>已是最新 {snapshot?.currentVersion}。</Text>
      ) : null}

      {errorText ? (
        <div style={{ marginTop: 8 }}>
          <Text type="danger">{errorText}</Text>
        </div>
      ) : null}
    </Modal>
  );
}
