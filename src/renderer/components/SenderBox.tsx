/**
 * SenderBox 输入框组件
 * 对齐 ai-client SenderBox.tsx 样式结构 + boxShadow 规范
 *
 * 样式对齐：
 * - 外层 padding: 12px 24px 24px
 * - Sender borderRadius=token.borderRadiusLG, boxShadow 默认/拖拽态
 * - autoSize={minRows:1, maxRows:8}
 * - 附件预览 72x72 方形 + 删除按钮 absolute top:-4 right:-4 20x20 circle
 * - 发送按钮 circle，取消态用方形 span 图标
 */

import type {
  ReactElement,
  DragEvent as ReactDragEvent,
  ClipboardEvent as ReactClipboardEvent,
} from 'react';
import { memo, useState, useCallback, useRef } from 'react';
import { Button, Flex, Typography, Upload, theme } from 'antd';
import {
  PaperClipOutlined,
  CloseOutlined,
  FileOutlined,
  ArrowUpOutlined,
} from '@ant-design/icons';
import { Sender } from '@ant-design/x';
import type { UploadProps } from 'antd';

const { Text } = Typography;

/** 待发送文件记录（仅做本地预览） */
export interface PendingFile {
  localKey: string;
  file: File;
  previewUrl: string;
  isImage: boolean;
}

interface SenderBoxProps {
  value?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  onSend?: ((text: string) => void) | undefined;
  onCancel?: (() => void) | undefined;
  loading?: boolean | undefined;
  showCancel?: boolean | undefined;
  /** ★ M4：提交被拦截时的反馈回调（组件内 300ms 节流，避免高频提示） */
  onBlocked?: ((reason: 'locked' | 'empty') => void) | undefined;
  canSend?: boolean | undefined;
  pendingFiles?: PendingFile[] | undefined;
  onAddFiles?: ((files: File[]) => void) | undefined;
  onRemoveFile?: ((localKey: string) => void) | undefined;
}

// ─── Drag / paste helpers ─────────────────────────────────────────
function hasDraggedFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files.length > 0) return true;
  return Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file');
}

function collectFilesFromDataTransfer(
  dataTransfer: DataTransfer | null,
): File[] {
  if (!dataTransfer) return [];
  const files = Array.from(dataTransfer.files ?? []);
  if (files.length > 0) return files;
  return Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

export const SenderBox = memo(function SenderBox({
  value = '',
  onChange,
  onSend,
  onCancel,
  loading = false,
  showCancel = false,
  onBlocked,
  canSend = false,
  pendingFiles = [],
  onAddFiles,
  onRemoveFile,
}: SenderBoxProps): ReactElement {
  const { token } = theme.useToken();
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  // ★ M4：被拦截提示 300ms 节流——连按回车/连点按钮只反馈一次
  const lastBlockedNotifyAtRef = useRef(0);
  const notifyBlocked = useCallback(
    (reason: 'locked' | 'empty') => {
      const now = Date.now();
      if (now - lastBlockedNotifyAtRef.current < 300) return;
      lastBlockedNotifyAtRef.current = now;
      onBlocked?.(reason);
    },
    [onBlocked],
  );

  // ── Drag handlers ──────────────────────────────────────────────
  const handleDragEnter = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      if (showCancel) return;
      dragDepthRef.current += 1;
      setDragActive(true);
    },
    [showCancel],
  );

  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      if (showCancel) return;
      if (!dragActive) setDragActive(true);
    },
    [showCancel, dragActive],
  );

  const handleDragLeave = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setDragActive(false);
      }
    },
    [],
  );

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const files = collectFilesFromDataTransfer(event.dataTransfer);
      dragDepthRef.current = 0;
      setDragActive(false);
      if (!files.length || showCancel) return;
      onAddFiles?.(files);
    },
    [onAddFiles, showCancel],
  );

  const handlePaste = useCallback(
    (event: ReactClipboardEvent<HTMLElement>) => {
      const files = collectFilesFromDataTransfer(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      onAddFiles?.(files);
    },
    [onAddFiles],
  );

  // ── Upload handler (+ button) ──────────────────────────────────
  const uploadProps: UploadProps = {
    multiple: true,
    showUploadList: false,
    accept: '*/*',
    beforeUpload: (file, fileList) => {
      const currentIndex = fileList.findIndex((item) => item.uid === file.uid);
      if (currentIndex > 0) {
        return Upload.LIST_IGNORE;
      }
      onAddFiles?.(fileList.map((item) => item as File));
      return Upload.LIST_IGNORE;
    },
  };

  // ── Submit ─────────────────────────────────────────────────────
  const handleSubmit = useCallback(() => {
    // ★ 守卫收敛（仅两条规则）：
    //   规则 1：运行中/发送中禁发（showCancel = 活跃会话 sending ∪ running，含主进程权威 isRunning）
    //   规则 2：空消息禁发（无文本且无附件）
    if (showCancel) {
      notifyBlocked('locked');
      return;
    }
    const text = value.trim();
    if (!text && pendingFiles.length === 0) {
      notifyBlocked('empty');
      return;
    }
    onSend?.(value);
  }, [onSend, showCancel, value, pendingFiles.length, notifyBlocked]);

  // ── Enter key ──────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<Element>): false | void => {
      if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        if (!showCancel && (value.trim() || pendingFiles.length > 0)) {
          event.preventDefault();
          handleSubmit();
          // ★ M5：返回 false 抑制 @ant-design/x Sender 内部 onInternalKeyDown 的
          //   triggerSend 二次提交（TextArea.js:97 “eventRes === false 即跳过”）。
          //   M5 解冻 submitDisabled 后内部提交路径恢复可用，必须防止双发。
          return false;
        }
        // ★ M4：锁定时反馈（原为静默吞回车）；空内容静默（与原行为一致）
        if (showCancel) notifyBlocked('locked');
      }
    },
    [handleSubmit, showCancel, value, pendingFiles.length, notifyBlocked],
  );

  return (
    <div
      style={{
        flexShrink: 0,
        padding: '8px 24px 24px',
        background: 'transparent',
      }}
    >
      <div
        style={{ maxWidth: 820, margin: '0 auto' }}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Sender
          value={value}
          onChange={(val) => onChange?.(val)}
          onSubmit={handleSubmit}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          loading={loading}
          submitType="enter"
          placeholder="输入消息"
          autoSize={{ minRows: 1, maxRows: 8 }}
          header={
            pendingFiles.length ? (
              <Flex wrap gap={8} style={{ paddingBottom: 8 }}>
                {pendingFiles.map((item) =>
                  item.isImage && item.previewUrl ? (
                    <div
                      key={item.localKey}
                      style={{
                        position: 'relative',
                        width: 72,
                        height: 72,
                      }}
                    >
                      <div
                        style={{
                          width: 72,
                          height: 72,
                          overflow: 'hidden',
                          border: `1px solid ${token.colorBorderSecondary}`,
                          borderRadius: token.borderRadiusLG,
                          background: token.colorFillAlter,
                        }}
                      >
                        <img
                          src={item.previewUrl}
                          alt={item.file.name}
                          style={{
                            display: 'block',
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                          }}
                        />
                      </div>
                      <Button
                        type="text"
                        size="small"
                        shape="circle"
                        icon={<CloseOutlined />}
                        onClick={() => onRemoveFile?.(item.localKey)}
                        style={{
                          position: 'absolute',
                          top: 4,
                          right: 4,
                          width: 20,
                          height: 20,
                          minWidth: 20,
                          padding: 0,
                          background: 'rgba(0, 0, 0, 0.45)',
                          color: '#fff',
                        }}
                      />
                    </div>
                  ) : (
                    <Flex
                      key={item.localKey}
                      align="center"
                      gap={8}
                      style={{
                        maxWidth: 180,
                        minWidth: 0,
                        padding: '6px 10px',
                        border: `1px solid ${token.colorBorderSecondary}`,
                        borderRadius: token.borderRadiusLG,
                        background: token.colorBgContainer,
                      }}
                    >
                      <FileOutlined />
                      <Text
                        ellipsis
                        style={{ flex: 1, minWidth: 0, maxWidth: 110 }}
                      >
                        {item.file.name}
                      </Text>
                      <Button
                        type="text"
                        size="small"
                        icon={<CloseOutlined />}
                        onClick={() => onRemoveFile?.(item.localKey)}
                      />
                    </Flex>
                  ),
                )}
              </Flex>
            ) : null
          }
          styles={{
            root: {
              background: token.colorBgContainer,
              border: 'none',
              borderRadius: token.borderRadiusLG,
              boxShadow: dragActive
                ? `0 0 0 2px ${token.colorPrimary}, 0 8px 24px rgba(15, 23, 42, 0.12), 0 2px 8px rgba(15, 23, 42, 0.08)`
                : '0 8px 24px rgba(15, 23, 42, 0.12), 0 2px 8px rgba(15, 23, 42, 0.08)',
            },
            input: {
              fontSize: token.fontSize,
            },
          }}
          prefix={
            <Upload {...uploadProps} disabled={showCancel}>
              <Button
                type="text"
                icon={<PaperClipOutlined />}
                disabled={showCancel}
                title="添加附件"
              />
            </Upload>
          }
          suffix={(defaultActions) => (
            <>
              {/*
                ★ M5（T2 库级缺陷修复，一个对话一个 is_running 标志位配套）：
                @ant-design/x v2.9.0 Sender.js:179 的 submitDisabled 以
                useState(!innerValue) 初始化，唯一更新入口是 ActionButton.js:20-24
                action='onSend' 的 useEffect；原先自定义 ReactElement suffix 经
                Sender.js:158-160 整体替换含 SendButton 的默认 actionNode，导致
                submitDisabled 永久冻结 true、内部 onSubmit 永不触发（回车仅剩
                TextArea.js:88-89 转发的应用级 onKeyDown 单一路径）。
                修复：suffix 改函数形式接收默认 actionNode，将其隐藏渲染于
                display:none 的 span（无布局副作用）——SendButton 重新挂载，
                submitDisabled 随 onSendDisabled=!innerValue 正常同步解冻；
                自定义按钮仍按目标会话级 showCancel/canSend 渲染与判定。
              */}
              <span style={{ display: 'none' }}>{defaultActions}</span>
              <Button
                type={showCancel ? 'default' : 'primary'}
                shape="circle"
                style={
                  showCancel
                    ? {
                        background: token.colorFillSecondary,
                        borderColor: token.colorBorderSecondary,
                        color: token.colorText,
                      }
                    : undefined
                }
                icon={
                  showCancel ? (
                    <span
                      style={{
                        display: 'block',
                        width: 10,
                        height: 10,
                        background: 'currentColor',
                        borderRadius: 2,
                      }}
                    />
                  ) : (
                    <ArrowUpOutlined />
                  )
                }
                onClick={() => {
                  if (showCancel) {
                    onCancel?.();
                  } else {
                    handleSubmit();
                  }
                }}
                // ★ M4：disabled 联动目标会话级锁——锁定态保持可点击（点击后被拦并反馈），
                //   非锁定态按 canSend 判定
                disabled={showCancel ? false : !canSend}
              />
            </>
          )}
        />
      </div>
    </div>
  );
});
