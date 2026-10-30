/**
 * OtherSettingsTab — 其他设置（值守模式）Tab 组件（阶段2：开关真实启停）
 *
 * 功能（对齐 PythonEnvTab.tsx:48-51 先例：具名导出函数组件 + useSettings() 读写 + AntApp.useApp() 反馈）：
 * - 值守模式总开关：真实启停（调 watch:start / watch:stop）；开启前本地校验邮箱/授权码，
 *   主进程执行 IMAP/SMTP 真实自检；含"自检中 / 运行中 / 已停止"状态反馈与开启失败错误提示
 * - 运行状态区：每 5 秒递归 setTimeout 轮询 watch:status，展示状态、增量游标、本次运行已处理封数
 *   与下次轮询时间（阶段5 起不再展示 UID 水位）；
 *   运行期回落关闭（自检失败/连续失败阈值）经 lastError Alert 展示错误码与原因
 * - 邮箱类型（阶段7 目标3）：QQ邮箱（内置端点）/ 其他（自定义 IMAP/SMTP 主机、端口、加密方式）；
 *   选择「其他」时展开六个自定义参数，保存即生效（收信与发信两侧统一由 provider 解析端点）
 * - 值守邮箱 / 授权码（密码型输入）/ 轮询间隔（分钟数字输入）/ 回信收件人：失焦校验 + trim 保存
 * - 指令说明：值守模式行尾问号图标 → Popover 展示命令行协议与最小可用示例（可复制）
 * - 自动更新（v1）：自动检查开关 + 更新地址 + 状态/进度展示 + 检查/下载/取消/立即安装操作行；
 *   复用同文件既有问号 Popover 结构承载机制说明（updateAutoCheckEnabled / updateBaseUrl 两键）
 * - 唯一入口原则：值守设置仅存在于本 Tab；本轮起本 Tab 追加「自动更新」区块（不含其它更新扩展项）
 * - watchEnabled 不经 config:save 写入（主进程已守卫拦截）：开关状态只由 watch:start/stop 改变
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Divider,
  Input,
  InputNumber,
  Popover,
  Progress,
  Select,
  Switch,
  Typography,
  theme,
} from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import { UPDATE_BASE_URL_SOURCE_DEFAULT } from '@shared/update-constants';
import { useSettings } from '../hooks/useSettings';
import { useUpdateState } from '../hooks/useUpdateState';

const { Title, Text, Paragraph } = Typography;

/** 邮箱格式校验正则（与 v3 方案 §4.1 定义一致） */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// ---------------------------------------------------------------------------
// watch IPC 局部类型（window.electronAPI 的全局类型声明不在改动白名单内，
// 沿用 ConfigDrawer.tsx 局部类型 + 断言访问先例）
// ---------------------------------------------------------------------------

type WatchRuntimeStatusLite = 'closed' | 'starting' | 'running' | 'suspended';

interface WatchApi {
  /** 开启值守：主进程真实自检（IMAP+SMTP）→ 时间游标基线（= 启动时刻）→ 启动轮询 */
  start: () => Promise<{ ok: boolean; status: WatchRuntimeStatusLite; code?: string; message?: string }>;
  /** 关闭值守：清定时器 + 写回 watchEnabled=false（幂等） */
  stop: () => Promise<{ ok: boolean; status: WatchRuntimeStatusLite }>;
  /**
   * 状态查询：status/enabled/lastError/watermark(恒 null)/cursor/nextPollAt/processedCount
   * 阶段5：watermark 保留字段但恒为 null（不再展示），时间增量进度改由 cursor.sinceTime 表达
   */
  status: () => Promise<{
    status: WatchRuntimeStatusLite;
    enabled: boolean;
    lastError: { code: string; message: string; at: string } | null;
    watermark: { mailbox: string; uidvalidity: number; lastUid: number } | null;
    cursor?: { mailbox: string; sinceTime: string; updatedAt: string } | null;
    nextPollAt: string | null;
    processedCount: number;
  }>;
}

const watchApi = (window as unknown as { electronAPI?: { watch?: WatchApi } }).electronAPI?.watch;

/** 邮箱类型（与 AppSettings.mailProviderType 一致） */
type MailProviderTypeLite = 'qq' | 'custom';
/** 端点加密方式（与 AppSettings.mailCustom*Encryption 一致：不提供明文选项） */
type MailEncryptionLite = 'ssl' | 'starttls';

/** 邮箱类型下拉选项（文案必须包含「QQ邮箱」，任务规则 15 非开放型要求） */
const MAIL_PROVIDER_OPTIONS: Array<{ value: MailProviderTypeLite; label: string }> = [
  { value: 'qq', label: 'QQ邮箱' },
  { value: 'custom', label: '其他' },
];

/** 加密方式下拉选项（隐式 TLS / STARTTLS；明文凭据不在选项中） */
const MAIL_ENCRYPTION_OPTIONS: Array<{ value: MailEncryptionLite; label: string }> = [
  { value: 'ssl', label: 'SSL/TLS（隐式加密，如 993/465）' },
  { value: 'starttls', label: 'STARTTLS（先明文建连再升级加密，如 143/587）' },
];

/** 值守指令说明：参数清单（每行一项，浮层内可选中复制） */
const COMMAND_HELP_ITEMS: Array<{ syntax: string; note: string }> = [
  { syntax: '--type list｜send｜new', note: '指令类型' },
  { syntax: '--list', note: '列出对话' },
  { syntax: '--limit 1-50', note: '列表条数，默认 20' },
  { syntax: '--conversation 3', note: '按编号指定对话' },
  { syntax: '--conversation-id <uuid>', note: '按 UUID 指定对话' },
  { syntax: '--message 内容', note: '要发送的消息' },
  { syntax: '--request 编号', note: '自定义请求号，可省略' },
];

/** 值守指令说明：最小可用示例（含 --type 与 --message，点击可复制） */
const COMMAND_HELP_EXAMPLE = '--type send --conversation 3 --message 你好';

/** 游标 ISO 文本 → 本地时间展示（非法值原样返回，不抛出） */
function formatCursorLocal(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toLocaleString();
}

/** 更新地址输入校验：空串允许（回落构建期默认值）；只接受 https 或本机回环 http */
function normalizeUpdateBaseUrlInput(raw: string): { ok: true; value: string } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: '' };
  }
  if (trimmed.length > 512 || /\s/.test(trimmed)) {
    return { ok: false };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false };
  }
  if (url.protocol === 'https:') {
    return { ok: true, value: trimmed.replace(/\/+$/, '') };
  }
  if (url.protocol === 'http:') {
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
      return { ok: true, value: trimmed.replace(/\/+$/, '') };
    }
  }
  return { ok: false };
}

/** 字节数展示（进度用） */
function formatUpdateBytes(bytes: number): string {
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

/** 更新操作启动失败码 → 用户可读提示 */
function describeUpdateStartCode(code?: string): string {
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
      return '更新操作未能开始，请重试。';
  }
}

// ---------------------------------------------------------------------------
// 更新说明（updateNotes）展示参数
// - 折叠态按「行」预览 6 行，行高取整数 20px：6 × 20 = 120px 与 maxHeight 严格相等，第 6 行完整可见；
//   字号 12 时 20 / 12 ≈ 1.67，与既有 lineHeight 1.7（20.4px）视觉一致；
// - 展开态 12 行 × 20px = 240px：设置页不再被长文本无限撑高，超出部分在容器内滚动；
// - 与更新弹窗（UpdatePrompt.tsx：6 行 / 22px / 132px，展开 11 行 / 242px）口径一致：
//   同为「6 行折叠 + 约 240px 展开 + 超限滚动」，仅因字号不同导致行高与总高不同。
// ---------------------------------------------------------------------------
const UPDATE_NOTES_PREVIEW_LINES = 6;
const UPDATE_NOTES_LINE_HEIGHT_PX = 20;
const UPDATE_NOTES_COLLAPSED_MAX_HEIGHT_PX = UPDATE_NOTES_PREVIEW_LINES * UPDATE_NOTES_LINE_HEIGHT_PX;
const UPDATE_NOTES_EXPANDED_LINES = 12;
const UPDATE_NOTES_EXPANDED_MAX_HEIGHT_PX = UPDATE_NOTES_EXPANDED_LINES * UPDATE_NOTES_LINE_HEIGHT_PX;
const UPDATE_NOTES_BODY_ID = 'settings-update-notes-body';

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export function OtherSettingsTab() {
  const { config, saveConfig } = useSettings();
  const { token } = theme.useToken();

  // ===== 自动更新（v1：自动检查开关 + 更新地址 + 状态展示） =====
  const { snapshot: updateSnapshot } = useUpdateState();
  const [updateAutoCheckEnabled, setUpdateAutoCheckEnabled] = useState(true);
  const [updateBaseUrl, setUpdateBaseUrl] = useState('');
  const [updateBaseUrlError, setUpdateBaseUrlError] = useState<string | null>(null);
  const [updateHelpOpen, setUpdateHelpOpen] = useState(false);
  const [updateNotesExpanded, setUpdateNotesExpanded] = useState(false);
  /** 更新说明正文容器：折叠态用它实测内容高度是否超出折叠上限 */
  const updateNotesBodyRef = useRef<HTMLDivElement | null>(null);
  /** null = 尚未测量：首帧保守按「可展开」渲染，useLayoutEffect 在 paint 前完成测量并收敛，无可见跳变 */
  const [updateNotesOverflowing, setUpdateNotesOverflowing] = useState<boolean | null>(null);
  const [updateActionBusy, setUpdateActionBusy] = useState(false);

  // ===== 邮箱类型（阶段7 目标3：provider 选择 + 自定义端点） =====
  const [providerType, setProviderType] = useState<MailProviderTypeLite>('qq');
  const [customImapHost, setCustomImapHost] = useState('');
  const [customImapPort, setCustomImapPort] = useState(993);
  const [customImapEncryption, setCustomImapEncryption] = useState<MailEncryptionLite>('ssl');
  const [customSmtpHost, setCustomSmtpHost] = useState('');
  const [customSmtpPort, setCustomSmtpPort] = useState(465);
  const [customSmtpEncryption, setCustomSmtpEncryption] = useState<MailEncryptionLite>('ssl');

  // ===== 值守邮箱 =====
  const [mailbox, setMailbox] = useState('');
  const [mailboxError, setMailboxError] = useState<string | null>(null);

  // ===== 授权码（密码型；任何提示中一律以 <QQ邮箱授权码> 占位，不回显明文到提示） =====
  const [authCode, setAuthCode] = useState('');
  const [authCodeError, setAuthCodeError] = useState<string | null>(null);

  // ===== 回信收件人 =====
  const [receiptRecipient, setReceiptRecipient] = useState('');
  const [receiptError, setReceiptError] = useState<string | null>(null);

  // ===== 轮询间隔（分钟） =====
  const [pollIntervalMinutes, setPollIntervalMinutes] = useState(2);

  // ===== 指令说明浮层（问号图标：点击常驻、ESC 关闭） =====
  const [commandHelpOpen, setCommandHelpOpen] = useState(false);

  // ===== 值守运行态（阶段2：经 watch IPC 与主进程值守服务联动） =====
  const { message } = AntApp.useApp();
  const [runtimeStatus, setRuntimeStatus] = useState<WatchRuntimeStatusLite>('closed');
  const [watchError, setWatchError] = useState<{ code: string; message: string; at: string } | null>(null);
  const [runtimeDetail, setRuntimeDetail] = useState<string | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  /** 状态轮询定时器（递归 setTimeout；卸载清理，不留残留定时器） */
  const statusPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 拉取一次 watch:status 并投影到本地展示态 */
  const refreshWatchStatus = useCallback(async () => {
    if (!watchApi) {
      return;
    }
    try {
      const s = await watchApi.status();
      setRuntimeStatus(s.status);
      setWatchError(s.lastError);
      if (s.status === 'running') {
        const parts: string[] = [];
        // 阶段5：有 cursor 时显示「增量游标 <本地时间>」；无 cursor 时不显示任何水位相关内容
        if (s.cursor) {
          parts.push(`增量游标 ${formatCursorLocal(s.cursor.sinceTime)}`);
        }
        parts.push(`本次运行已处理 ${s.processedCount} 封`);
        if (s.nextPollAt) {
          parts.push(`下次轮询 ${new Date(s.nextPollAt).toLocaleTimeString()}`);
        }
        setRuntimeDetail(parts.join('｜'));
      } else {
        setRuntimeDetail(null);
      }
    } catch {
      // IPC 异常静默：下一轮重试
    }
  }, []);

  // 挂载即取一次状态，随后每 5 秒递归轮询（v3 §5.2 状态区节奏；卸载时清理）
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) {
        return;
      }
      await refreshWatchStatus();
      if (cancelled) {
        return;
      }
      statusPollTimerRef.current = setTimeout(() => {
        void tick();
      }, 5000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (statusPollTimerRef.current) {
        clearTimeout(statusPollTimerRef.current);
        statusPollTimerRef.current = null;
      }
    };
  }, [refreshWatchStatus]);

  /** 开关切换：开启=本地校验→watch:start（真实自检）；关闭=watch:stop */
  const handleWatchSwitchChange = useCallback(
    async (checked: boolean) => {
      if (!watchApi) {
        message.error('值守 IPC 不可用：preload 未暴露 watch 通道');
        return;
      }
      if (checked) {
        // 阶段7：自定义邮箱必须先填两端主机（主进程还会做一次 validateMailEndpoints 校验）
        if (providerType === 'custom') {
          if (!customImapHost.trim() || !customSmtpHost.trim()) {
            message.error('开启失败：请先填写 IMAP 与 SMTP 服务器地址');
            return;
          }
        }
        const mailboxTrimmed = mailbox.trim();
        if (!EMAIL_RE.test(mailboxTrimmed)) {
          setMailboxError('邮箱格式不正确，例如 name@qq.com');
          message.error('开启失败：值守邮箱未配置或格式不正确');
          return;
        }
        const authTrimmed = authCode.trim();
        if (!authTrimmed || authTrimmed.length < 8 || authTrimmed.length > 64) {
          setAuthCodeError('授权码不能为空（8-64 字符）');
          message.error('开启失败：邮箱授权码未配置（8-64 字符）');
          return;
        }
        setSwitchBusy(true);
        setRuntimeStatus('starting');
        try {
          const result = await watchApi.start();
          if (result.ok) {
            message.success('值守已开启：自检通过，收信轮询已启动');
          } else {
            message.error(`开启失败：${result.code ?? ''} ${result.message ?? ''}`.trim());
          }
        } catch (err) {
          message.error(`开启失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setSwitchBusy(false);
          void refreshWatchStatus();
        }
        return;
      }
      setSwitchBusy(true);
      try {
        const result = await watchApi.stop();
        if (result.ok) {
          message.success('值守已关闭：轮询已停止，开关已写回 false');
          setWatchError(null);
        } else {
          message.error(`关闭失败：当前状态 ${result.status}`);
        }
      } catch (err) {
        message.error(`关闭失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setSwitchBusy(false);
        void refreshWatchStatus();
      }
    },
    [mailbox, authCode, message, refreshWatchStatus, providerType, customImapHost, customSmtpHost],
  );

  /** 运行状态展示文案（自检中 / 运行中 / 已停止 / 异常暂停） */
  const watchStatusText: string =
    runtimeStatus === 'running'
      ? '运行中'
      : runtimeStatus === 'starting'
        ? '自检中…'
        : runtimeStatus === 'suspended'
          ? '异常暂停'
          : '已停止';

  // ---- config → 本地 state 同步（外部 reload / 首次加载） ----
  useEffect(() => {
    setProviderType(config.mailProviderType === 'custom' ? 'custom' : 'qq');
  }, [config.mailProviderType]);

  useEffect(() => {
    setCustomImapHost(config.mailCustomImapHost ?? '');
  }, [config.mailCustomImapHost]);

  useEffect(() => {
    const rawPort = config.mailCustomImapPort;
    setCustomImapPort(typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort >= 1 ? Math.floor(rawPort) : 993);
  }, [config.mailCustomImapPort]);

  useEffect(() => {
    setCustomImapEncryption(config.mailCustomImapEncryption === 'starttls' ? 'starttls' : 'ssl');
  }, [config.mailCustomImapEncryption]);

  useEffect(() => {
    setCustomSmtpHost(config.mailCustomSmtpHost ?? '');
  }, [config.mailCustomSmtpHost]);

  useEffect(() => {
    const rawPort = config.mailCustomSmtpPort;
    setCustomSmtpPort(typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort >= 1 ? Math.floor(rawPort) : 465);
  }, [config.mailCustomSmtpPort]);

  useEffect(() => {
    setCustomSmtpEncryption(config.mailCustomSmtpEncryption === 'starttls' ? 'starttls' : 'ssl');
  }, [config.mailCustomSmtpEncryption]);

  useEffect(() => {
    setMailbox(config.watchMailboxAddress ?? '');
  }, [config.watchMailboxAddress]);

  useEffect(() => {
    setAuthCode(config.watchMailboxAuthCode ?? '');
  }, [config.watchMailboxAuthCode]);

  useEffect(() => {
    setReceiptRecipient(config.watchReceiptRecipient ?? '');
  }, [config.watchReceiptRecipient]);

  useEffect(() => {
    const raw = config.watchPollIntervalMinutes;
    const num = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 2;
    setPollIntervalMinutes(num);
  }, [config.watchPollIntervalMinutes]);

  // ---- 自动更新配置 → 本地 state 同步（首次加载 / 外部 reload） ----
  useEffect(() => {
    setUpdateAutoCheckEnabled(config.updateAutoCheckEnabled !== false);
  }, [config.updateAutoCheckEnabled]);

  useEffect(() => {
    setUpdateBaseUrl(config.updateBaseUrl ?? '');
  }, [config.updateBaseUrl]);

  useEffect(() => {
    setUpdateNotesExpanded(false);
  }, [updateSnapshot?.latestVersion]);

  // 自动更新说明浮层：ESC 关闭（与既有指令说明浮层同构）
  useEffect(() => {
    if (!updateHelpOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setUpdateHelpOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [updateHelpOpen]);

  // 指令说明浮层：ESC 关闭（内容为静态常量，渲染异常不影响设置页）
  useEffect(() => {
    if (!commandHelpOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCommandHelpOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commandHelpOpen]);

  // ===== 邮箱类型：选择即保存（下一轮轮询/下次发信即生效） =====
  const handleProviderTypeChange = useCallback(
    (value: MailProviderTypeLite) => {
      setProviderType(value);
      if (value !== config.mailProviderType) {
        void saveConfig('mailProviderType', value);
      }
      if (value === 'custom') {
        message.info('已选择「其他」邮箱，请填写下方服务器参数');
      }
    },
    [config.mailProviderType, saveConfig, message],
  );

  /** 自定义主机失焦保存（trim；空串表示未配置，主进程校验会拦截） */
  const handleCustomHostBlur = useCallback(
    (key: 'mailCustomImapHost' | 'mailCustomSmtpHost', rawValue: string, current: string) => {
      const trimmed = rawValue.trim();
      if (trimmed !== current) {
        void saveConfig(key, trimmed);
      }
    },
    [saveConfig],
  );

  /** 自定义端口保存（夹紧 1-65535；非法值不写库） */
  const handleCustomPortChange = useCallback(
    (
      key: 'mailCustomImapPort' | 'mailCustomSmtpPort',
      value: number | null,
      current: number,
      fallback: number,
      apply: (port: number) => void,
    ) => {
      if (value === null || !Number.isFinite(value)) {
        return;
      }
      const port = Math.floor(value);
      if (port < 1 || port > 65535) {
        apply(fallback);
        return;
      }
      apply(port);
      if (port !== current) {
        void saveConfig(key, port);
      }
    },
    [saveConfig],
  );

  // ===== 失焦校验 + 保存：值守邮箱 =====
  const handleMailboxBlur = useCallback(() => {
    const trimmed = mailbox.trim();
    if (trimmed && !EMAIL_RE.test(trimmed)) {
      setMailboxError('邮箱格式不正确，例如 name@qq.com');
      return;
    }
    setMailboxError(null);
    setMailbox(trimmed);
    if (trimmed !== config.watchMailboxAddress) {
      void saveConfig('watchMailboxAddress', trimmed);
    }
  }, [mailbox, config.watchMailboxAddress, saveConfig]);

  // ===== 失焦校验 + 保存：授权码（空=未配置合法；非空需 8-64 字符） =====
  const handleAuthCodeBlur = useCallback(() => {
    const trimmed = authCode.trim();
    if (trimmed && (trimmed.length < 8 || trimmed.length > 64)) {
      setAuthCodeError('授权码长度需为 8-64 字符');
      return;
    }
    setAuthCodeError(null);
    setAuthCode(trimmed);
    if (trimmed !== config.watchMailboxAuthCode) {
      void saveConfig('watchMailboxAuthCode', trimmed);
    }
  }, [authCode, config.watchMailboxAuthCode, saveConfig]);

  // ===== 失焦校验 + 保存：回信收件人（空=回给值守邮箱自身） =====
  const handleReceiptBlur = useCallback(() => {
    const trimmed = receiptRecipient.trim();
    if (trimmed && !EMAIL_RE.test(trimmed)) {
      setReceiptError('回信收件人格式不正确，留空则回给值守邮箱');
      return;
    }
    setReceiptError(null);
    setReceiptRecipient(trimmed);
    if (trimmed !== config.watchReceiptRecipient) {
      void saveConfig('watchReceiptRecipient', trimmed);
    }
  }, [receiptRecipient, config.watchReceiptRecipient, saveConfig]);

  // ===== 轮询间隔：合法正整数即保存（<1 纠正为 1；空值不动，读取侧兜底默认 2） =====
  const handleIntervalChange = useCallback(
    (value: number | null) => {
      if (value === null || !Number.isFinite(value)) {
        return;
      }
      const clamped = Math.max(1, Math.floor(value));
      setPollIntervalMinutes(clamped);
      if (clamped !== config.watchPollIntervalMinutes) {
        void saveConfig('watchPollIntervalMinutes', clamped);
      }
    },
    [config.watchPollIntervalMinutes, saveConfig],
  );

  // ===== 自动更新：开关即时保存 / 地址失焦校验并保存 / 操作按钮 =====
  const handleUpdateAutoCheckChange = useCallback(
    (checked: boolean) => {
      setUpdateAutoCheckEnabled(checked);
      void saveConfig('updateAutoCheckEnabled', checked);
    },
    [saveConfig],
  );

  const handleUpdateBaseUrlBlur = useCallback(() => {
    const parsed = normalizeUpdateBaseUrlInput(updateBaseUrl);
    if (!parsed.ok) {
      setUpdateBaseUrlError('地址需以 https:// 开头。');
      return;
    }
    setUpdateBaseUrlError(null);
    setUpdateBaseUrl(parsed.value);
    if (parsed.value !== (config.updateBaseUrl ?? '')) {
      void saveConfig('updateBaseUrl', parsed.value);
    }
  }, [updateBaseUrl, config.updateBaseUrl, saveConfig]);

  const runUpdateAction = useCallback(
    async (action: 'check' | 'download' | 'cancel' | 'install') => {
      const api = window.electronAPI?.update;
      if (!api) {
        message.error('更新 IPC 不可用：preload 未暴露 update 通道');
        return;
      }
      setUpdateActionBusy(true);
      try {
        if (action === 'check') {
          const result = await api.check({ reason: 'manual' });
          if (!result.accepted) {
            message.info('请稍后再试。');
          }
        } else if (action === 'download') {
          const result = await api.download({ version: updateSnapshot?.latestVersion ?? undefined });
          if (!result.started) {
            message.warning(describeUpdateStartCode(result.code));
          }
        } else if (action === 'cancel') {
          await api.cancel();
        } else {
          const result = await api.install({ version: updateSnapshot?.latestVersion ?? undefined });
          if (!result.launched) {
            message.error(result.message ?? '安装程序未能启动，请重试。');
          } else if (result.message) {
            message.info(result.message);
          }
        }
      } catch (err) {
        message.error(err instanceof Error ? err.message : '更新操作失败，请重试。');
      } finally {
        setUpdateActionBusy(false);
      }
    },
    [message, updateSnapshot?.latestVersion],
  );

  // ===== 公共样式 =====
  const labelStyle: CSSProperties = {
    display: 'block',
    fontSize: 13,
    fontWeight: 500,
    color: token.colorText,
    marginBottom: token.paddingXS,
  };
  const hintStyle: CSSProperties = {
    fontSize: 12,
    color: token.colorTextSecondary,
    marginTop: token.paddingXXS,
  };
  const errorStyle: CSSProperties = {
    fontSize: 12,
    color: token.colorError,
    marginTop: token.paddingXXS,
  };
  const fieldGap: CSSProperties = { marginBottom: token.paddingMD };

  // ===== 指令说明浮层内容（参数清单 + 可复制最小示例） =====
  const commandHelpContent = (
    <div style={{ maxWidth: 300, maxHeight: 260, overflow: 'auto', fontSize: 12, lineHeight: 2 }}>
      {COMMAND_HELP_ITEMS.map((item) => (
        <div
          key={item.syntax}
          style={{ display: 'flex', gap: token.paddingXS, justifyContent: 'space-between' }}
        >
          <Text code style={{ fontSize: 12 }}>
            {item.syntax}
          </Text>
          <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            {item.note}
          </Text>
        </div>
      ))}
      <div style={{ marginTop: token.paddingXXS }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          最小示例
        </Text>
        <Paragraph
          copyable={{ text: COMMAND_HELP_EXAMPLE, tooltips: ['复制示例', '已复制'] }}
          style={{ marginBottom: 0 }}
        >
          <Text code style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {COMMAND_HELP_EXAMPLE}
          </Text>
        </Paragraph>
      </div>
    </div>
  );

  // ===== 自动更新展示派生（动态区按 phase 互斥渲染） =====
  const updatePhase = updateSnapshot?.phase ?? 'idle';
  const updatePlatformSupported = !updateSnapshot || updateSnapshot.platform !== null;
  const updateProgress = updateSnapshot?.progress;
  const updatePercent = updateProgress && updateProgress.totalBytes > 0
    ? Math.min(100, Math.max(0, Math.round((updateProgress.receivedBytes / updateProgress.totalBytes) * 100)))
    : 0;
  const updateCurrentVersion = updateSnapshot?.currentVersion ?? '';
  const updateLatestVersion = updateSnapshot?.latestVersion ?? '';
  const updateStatusText = !updatePlatformSupported
    ? '当前系统不支持自动更新。'
    : updatePhase === 'checking'
      ? '正在检查…'
      : updatePhase === 'update-available'
        ? `发现新版本 ${updateLatestVersion}。`
        : updatePhase === 'up-to-date'
          ? `已是最新 ${updateCurrentVersion}。`
          : updatePhase === 'downloading'
            ? `正在下载 ${updatePercent}%。`
            : updatePhase === 'downloaded'
              ? `${updateLatestVersion} 已下载，可安装。`
              : updatePhase === 'verify-failed'
                ? '安装包校验失败，已删除，可重试。'
                : updatePhase === 'unauthorized'
                  ? '更新地址或授权码不匹配。'
                  : updatePhase === 'network-failed'
                    ? updateSnapshot?.lastError?.code === 'ERR_UPDATE_WRITE'
                      ? '下载失败，请重试。'
                      : '检查失败，请重试。'
                    : '尚未检查。';
  // updateNotes 可能为 null：先归一化换行再按「行」切分（只影响渲染，不改动数据本身）
  const updateNotesText = (updateSnapshot?.updateNotes ?? '').replace(/\r\n?/g, '\n');
  const updateNotesHasText = updateNotesText.trim().length > 0;
  const updateNoteLines = updateNotesText.split('\n');
  const updateNotesPreview = updateNoteLines.slice(0, UPDATE_NOTES_PREVIEW_LINES).join('\n');
  /** 第 6 行之后是否还有非空行：纯空行不算「更多内容」，避免展开后什么也看不到 */
  const updateNotesHasMore = updateNoteLines
    .slice(UPDATE_NOTES_PREVIEW_LINES)
    .some((line) => line.trim().length > 0);

  // 折叠态实测：单个超长行会折成多个视觉行，行数 ≤ 6 也可能高于折叠上限 → 用 scrollHeight 兜底判定；
  // 展开态不重算，避免测量结果把「收起」入口吞掉（展开态恒显示入口）。
  // 设置页宽度随窗口变化，ResizeObserver 负责在重新折行后补测；phase 变化补测一次（分支未渲染时容器不存在）。
  useLayoutEffect(() => {
    if (updatePhase !== 'update-available' || !updateNotesHasText || updateNotesExpanded) {
      return;
    }
    const element = updateNotesBodyRef.current;
    if (!element) {
      return;
    }
    const measure = (): void => {
      setUpdateNotesOverflowing(element.scrollHeight > UPDATE_NOTES_COLLAPSED_MAX_HEIGHT_PX);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updatePhase, updateNotesHasText, updateNotesExpanded, updateNotesText]);

  const showUpdateNotesToggle = updateNotesHasText
    && (updateNotesExpanded || updateNotesHasMore || updateNotesOverflowing !== false);

  // ===== 自动更新说明浮层内容（复用同文件既有问号 Popover 结构） =====
  const updateHelpContent = (
    <div style={{ maxWidth: 300, maxHeight: 260, overflow: 'auto', fontSize: 12, lineHeight: 2 }}>
      <div>启动后 30 秒检查一次，之后每 1 小时一次。</div>
      <div>更新地址与授权码必须匹配，否则服务端按 404 回应。</div>
      <div>安装包保存在本机 bin/updates 目录。</div>
    </div>
  );

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
        其他设置
      </Title>

      <Divider style={{ margin: '8px 0 16px' }} />

      {/* ===== 总开关（阶段2：真实启停 watch:start / watch:stop） ===== */}
      <div style={fieldGap}>
        <div style={{ display: 'flex', alignItems: 'center', gap: token.paddingSM }}>
          <Switch
            checked={runtimeStatus === 'running' || runtimeStatus === 'starting'}
            loading={switchBusy || runtimeStatus === 'starting'}
            disabled={switchBusy}
            onChange={() => {
              void handleWatchSwitchChange(runtimeStatus !== 'running' && runtimeStatus !== 'starting');
            }}
          />
          <Text strong style={{ fontSize: 14 }}>
            值守模式
          </Text>
          <Text
            type={runtimeStatus === 'running' ? 'success' : 'secondary'}
            style={{ fontSize: 12 }}
          >
            状态：{watchStatusText}
          </Text>
          <Popover
            trigger="click"
            open={commandHelpOpen}
            onOpenChange={setCommandHelpOpen}
            placement="bottomLeft"
            title="指令邮件写法"
            content={commandHelpContent}
          >
            <Button
              type="text"
              size="small"
              aria-label="查看值守指令写法"
              aria-expanded={commandHelpOpen}
              icon={<QuestionCircleOutlined />}
              style={{ width: 20, height: 20, padding: 0, color: token.colorTextTertiary }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setCommandHelpOpen(false);
                }
              }}
            />
          </Popover>
        </div>
        <Text type="secondary" style={hintStyle}>
          开启后由值守邮箱接收指令邮件，无需重启。
        </Text>
        {runtimeDetail ? (
          <Text type="secondary" style={{ ...hintStyle, display: 'block' }}>
            {runtimeDetail}
          </Text>
        ) : null}
        {watchError ? (
          <Alert
            type="error"
            showIcon
            closable
            style={{ marginTop: token.paddingSM }}
            message={`值守错误（${watchError.code}）`}
            description={watchError.message}
            onClose={() => {
              setWatchError(null);
            }}
          />
        ) : null}
      </div>

      {/* ===== 邮箱类型区块（阶段7 目标3：QQ邮箱内置 / 其他自定义端点） ===== */}
      <div style={fieldGap}>
        <Text style={labelStyle}>邮箱类型</Text>
        <Select
          style={{ width: 240 }}
          value={providerType}
          onChange={(value) => handleProviderTypeChange(value as MailProviderTypeLite)}
          options={MAIL_PROVIDER_OPTIONS}
        />
        <Text type="secondary" style={hintStyle}>
          QQ邮箱使用内置端点，「其他」需填 IMAP/SMTP 参数。
        </Text>

        {providerType === 'custom' ? (
          <div
            style={{
              marginTop: token.paddingSM,
              padding: token.paddingSM,
              border: `1px dashed ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadius,
            }}
          >
            <Text strong style={{ fontSize: 13 }}>IMAP（收信）</Text>
            <div style={{ display: 'flex', gap: token.paddingXS, marginTop: token.paddingXS }}>
              <Input
                style={{ flex: 1 }}
                placeholder="imap.example.com"
                value={customImapHost}
                onChange={(e) => setCustomImapHost(e.target.value)}
                onBlur={() =>
                  handleCustomHostBlur('mailCustomImapHost', customImapHost, config.mailCustomImapHost ?? '')}
              />
              <InputNumber
                min={1}
                max={65535}
                precision={0}
                style={{ width: 110 }}
                value={customImapPort}
                onChange={(value) =>
                  handleCustomPortChange(
                    'mailCustomImapPort',
                    value,
                    config.mailCustomImapPort,
                    993,
                    setCustomImapPort,
                  )}
              />
            </div>
            <Select
              style={{ width: '100%', marginTop: token.paddingXS }}
              value={customImapEncryption}
              onChange={(value) => {
                const next = value as MailEncryptionLite;
                setCustomImapEncryption(next);
                if (next !== config.mailCustomImapEncryption) {
                  void saveConfig('mailCustomImapEncryption', next);
                }
              }}
              options={MAIL_ENCRYPTION_OPTIONS}
            />

            <Text strong style={{ fontSize: 13, display: 'block', marginTop: token.paddingSM }}>
              SMTP（发信）
            </Text>
            <div style={{ display: 'flex', gap: token.paddingXS, marginTop: token.paddingXS }}>
              <Input
                style={{ flex: 1 }}
                placeholder="smtp.example.com"
                value={customSmtpHost}
                onChange={(e) => setCustomSmtpHost(e.target.value)}
                onBlur={() =>
                  handleCustomHostBlur('mailCustomSmtpHost', customSmtpHost, config.mailCustomSmtpHost ?? '')}
              />
              <InputNumber
                min={1}
                max={65535}
                precision={0}
                style={{ width: 110 }}
                value={customSmtpPort}
                onChange={(value) =>
                  handleCustomPortChange(
                    'mailCustomSmtpPort',
                    value,
                    config.mailCustomSmtpPort,
                    465,
                    setCustomSmtpPort,
                  )}
              />
            </div>
            <Select
              style={{ width: '100%', marginTop: token.paddingXS }}
              value={customSmtpEncryption}
              onChange={(value) => {
                const next = value as MailEncryptionLite;
                setCustomSmtpEncryption(next);
                if (next !== config.mailCustomSmtpEncryption) {
                  void saveConfig('mailCustomSmtpEncryption', next);
                }
              }}
              options={MAIL_ENCRYPTION_OPTIONS}
            />

            <Text type="secondary" style={{ ...hintStyle, display: 'block' }}>
              请填服务商的客户端授权码，仅支持 SSL/STARTTLS。
            </Text>
          </div>
        ) : null}
      </div>

      {/* ===== 账号区块 ===== */}
      <div style={fieldGap}>
        <Text style={labelStyle}>值守邮箱</Text>
        <Input
          placeholder="name@qq.com"
          value={mailbox}
          onChange={(e) => setMailbox(e.target.value)}
          onBlur={handleMailboxBlur}
        />
        {mailboxError ? <Text style={errorStyle}>{mailboxError}</Text> : null}
      </div>

      <div style={fieldGap}>
        <Text style={labelStyle}>邮箱授权码</Text>
        <Input.Password
          placeholder="QQ 邮箱授权码（不是登录密码）"
          value={authCode}
          onChange={(e) => setAuthCode(e.target.value)}
          onBlur={handleAuthCodeBlur}
        />
        {authCodeError ? <Text style={errorStyle}>{authCodeError}</Text> : null}
      </div>

      <div style={fieldGap}>
        <Text style={labelStyle}>回信收件人</Text>
        <Input
          placeholder="留空则回给值守邮箱"
          value={receiptRecipient}
          onChange={(e) => setReceiptRecipient(e.target.value)}
          onBlur={handleReceiptBlur}
        />
        {receiptError ? <Text style={errorStyle}>{receiptError}</Text> : null}
      </div>

      {/* ===== 调度区块 ===== */}
      <div style={fieldGap}>
        <Text style={labelStyle}>轮询间隔</Text>
        <InputNumber
          min={1}
          precision={0}
          addonAfter="分钟"
          style={{ width: 160 }}
          value={pollIntervalMinutes}
          onChange={handleIntervalChange}
        />
      </div>

      {/* ===== 自动更新区块（v1：自动检查开关 + 更新地址；位于调度区块之后、组件根 </div> 之前） ===== */}
      <Divider style={{ margin: '8px 0 16px' }} />
      <div style={fieldGap}>
        <div style={{ display: 'flex', alignItems: 'center', gap: token.paddingSM }}>
          <Text strong style={{ fontSize: 13 }}>自动更新</Text>
          <Text
            type={
              updatePhase === 'network-failed' || updatePhase === 'verify-failed' || updatePhase === 'unauthorized'
                ? 'danger'
                : updatePhase === 'downloaded'
                  ? 'success'
                  : 'secondary'
            }
            style={{ fontSize: 12 }}
          >
            状态：{updateStatusText}
          </Text>
          <Popover
            trigger="click"
            open={updateHelpOpen}
            onOpenChange={setUpdateHelpOpen}
            placement="bottomLeft"
            title="自动更新说明"
            content={updateHelpContent}
          >
            <Button
              type="text"
              size="small"
              aria-label="查看自动更新说明"
              aria-expanded={updateHelpOpen}
              icon={<QuestionCircleOutlined />}
              style={{ width: 20, height: 20, padding: 0, color: token.colorTextTertiary }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setUpdateHelpOpen(false);
                }
              }}
            />
          </Popover>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: token.paddingSM, marginTop: token.paddingXS }}>
          <Switch checked={updateAutoCheckEnabled} onChange={handleUpdateAutoCheckChange} />
          <Text style={{ fontSize: 13 }}>自动更新</Text>
        </div>
        <Text type="secondary" style={hintStyle}>
          {updateAutoCheckEnabled ? '启动后自动检查，发现新版本会提示你。' : '已关闭自动检查，仍可手动检查。'}
        </Text>

        <div style={{ display: 'flex', gap: token.paddingXS, marginTop: token.paddingXS, flexWrap: 'wrap' }}>
          {updatePhase !== 'update-available'
            && updatePhase !== 'downloading'
            && updatePhase !== 'downloaded'
            && updatePhase !== 'verify-failed'
            && updatePhase !== 'network-failed'
            && updatePhase !== 'unauthorized' ? (
              <Button
                size="small"
                loading={updateActionBusy || updatePhase === 'checking'}
                disabled={!updatePlatformSupported || updateActionBusy}
                onClick={() => { void runUpdateAction('check'); }}
              >
                检查更新
              </Button>
            ) : null}
          {updatePhase === 'update-available' ? (
            <>
              <Button
                size="small"
                type="primary"
                disabled={!updateSnapshot?.hasPackage || updateActionBusy}
                onClick={() => { void runUpdateAction('download'); }}
              >
                下载
              </Button>
              <Button size="small" disabled={updateActionBusy} onClick={() => { void runUpdateAction('check'); }}>
                重新检查
              </Button>
            </>
          ) : null}
          {updatePhase === 'downloading' ? (
            <Button size="small" disabled={updateActionBusy} onClick={() => { void runUpdateAction('cancel'); }}>
              取消
            </Button>
          ) : null}
          {updatePhase === 'downloaded' ? (
            <Button
              size="small"
              type="primary"
              disabled={updateActionBusy}
              onClick={() => { void runUpdateAction('install'); }}
            >
              立即安装
            </Button>
          ) : null}
          {updatePhase === 'verify-failed' || updatePhase === 'network-failed' || updatePhase === 'unauthorized' ? (
            <Button
              size="small"
              disabled={updateActionBusy}
              onClick={() => { void runUpdateAction(updatePhase === 'verify-failed' ? 'download' : 'check'); }}
            >
              重试
            </Button>
          ) : null}
        </div>

        {/* 动态区：同一时刻只允许出现一块（按 phase 互斥渲染） */}
        {updatePhase === 'update-available' ? (
          <div style={{ marginTop: token.paddingXS }}>
            {updateNotesHasText ? (
              <div
                id={UPDATE_NOTES_BODY_ID}
                ref={updateNotesBodyRef}
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 12,
                  color: token.colorTextSecondary,
                  lineHeight: `${UPDATE_NOTES_LINE_HEIGHT_PX}px`,
                  maxHeight: updateNotesExpanded
                    ? UPDATE_NOTES_EXPANDED_MAX_HEIGHT_PX
                    : UPDATE_NOTES_COLLAPSED_MAX_HEIGHT_PX,
                  overflowX: 'hidden',
                  overflowY: updateNotesExpanded ? 'auto' : 'hidden',
                }}
              >
                {updateNotesExpanded ? updateNotesText : updateNotesPreview}
              </div>
            ) : null}
            {showUpdateNotesToggle ? (
              <Button
                type="link"
                size="small"
                style={{ padding: 0 }}
                aria-expanded={updateNotesExpanded}
                aria-controls={UPDATE_NOTES_BODY_ID}
                aria-label={updateNotesExpanded ? '收起全部更新说明' : '展开全部更新说明'}
                onClick={() => setUpdateNotesExpanded((value) => !value)}
              >
                {updateNotesExpanded ? '收起' : '展开'}
              </Button>
            ) : null}
            {updateSnapshot && !updateSnapshot.hasPackage ? (
              <Text type="warning" style={{ ...hintStyle, display: 'block' }}>新版本安装包未就绪。</Text>
            ) : null}
            {updateSnapshot?.lastError?.code === 'ERR_UPDATE_DISK' ? (
              <Text type="danger" style={{ ...hintStyle, display: 'block' }}>磁盘空间不足，无法下载。</Text>
            ) : null}
          </div>
        ) : null}
        {updatePhase === 'downloading' && updateProgress ? (
          <div style={{ marginTop: token.paddingXS }}>
            <Progress percent={updatePercent} size="small" status="active" />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {`${updatePercent}%（${formatUpdateBytes(updateProgress.receivedBytes)} / ${formatUpdateBytes(updateProgress.totalBytes)}）`}
            </Text>
          </div>
        ) : null}
        <Text style={{ ...labelStyle, marginTop: token.paddingSM }}>更新地址</Text>
        <Input
          placeholder={UPDATE_BASE_URL_SOURCE_DEFAULT}
          value={updateBaseUrl}
          status={updateBaseUrlError ? 'error' : undefined}
          onChange={(event) => setUpdateBaseUrl(event.target.value)}
          onBlur={handleUpdateBaseUrlBlur}
        />
        {updateBaseUrlError ? <Text style={errorStyle}>{updateBaseUrlError}</Text> : null}
        <Text type="secondary" style={hintStyle}>改错会无法检查更新。</Text>
        {updateSnapshot ? (
          <Text type="secondary" style={{ ...hintStyle, display: 'block' }}>
            当前生效：{updateSnapshot.effectiveBaseUrl}
          </Text>
        ) : null}
      </div>

    </div>
  );
}
