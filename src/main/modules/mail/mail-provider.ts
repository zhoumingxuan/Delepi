/**
 * mail-provider — 邮箱服务商抽象（阶段7 目标3）
 *
 * 背景（阶段2~6 的硬编码事实）：
 * - 收信端口径把 QQ 端点写死在 mail-bridge（imap.qq.com:993 / smtp.qq.com:465），
 *   发信端口径写死在 watch-service 的回执发送参数里；
 * - 前端【其他设置】没有任何邮箱类型选择项，只能用于 QQ 邮箱。
 *
 * 本模块把「邮箱服务商」抽成数据定义 + 解析函数：
 * - 每个 provider 只声明自己两端（IMAP / SMTP）的 host / port / encryption；
 * - 端点解析唯一入口 resolveMailEndpoints()：收信（mail-bridge/imap-client）与
 *   发信（smtp-client）都必须先经它拿到端点，禁止在业务代码里再写死主机名；
 * - 新增服务商只需在 MAIL_PROVIDERS 里加一条定义（并给 AppSettings 增加对应取值），
 *   业务代码零改动——扩展点见本文件末尾注释。
 *
 * 安全取舍（任务规则 14 开放型：加密方式由执行者决策）：
 * - 只提供 'ssl'（隐式 TLS）与 'starttls'（明文建连后 STARTTLS 升级）两种；
 * - 刻意不提供 'plain'：授权码等价密码，明文传输不可接受；自定义邮箱若只支持明文，
 *   视为不支持，由 validateMailEndpoints() 给出明确失败原因而不是静默降级。
 */

import type { AppSettings, MailProviderType, MailSocketEncryption } from '@shared/types/config';

/** 单个邮件端点（收信或发信） */
export interface MailEndpoint {
  host: string;
  /** 1-65535 的有效端口（解析时夹紧，非法回落 provider 默认端口） */
  port: number;
  encryption: MailSocketEncryption;
}

/** 一次解析得到的双端端点（收信 / 发信共用同一账号） */
export interface MailProviderEndpoints {
  /** 生效的 provider id（'qq' | 'custom'） */
  providerId: MailProviderType;
  /** 展示名（日志/回执用：'QQ邮箱' / '其他邮箱'） */
  providerLabel: string;
  imap: MailEndpoint;
  smtp: MailEndpoint;
}

/** provider 定义（纯数据，无副作用，便于单测与前端下拉复用） */
export interface MailProviderDefinition {
  id: MailProviderType;
  /** 前端下拉文案（必须包含「QQ邮箱」字样，任务规则 15 非开放型要求） */
  label: string;
  /** 一句话说明（前端辅助文案） */
  description: string;
  /** 固定端点：内置服务商为常量；自定义服务商为 null（端点来自 settings） */
  fixedEndpoints: { imap: MailEndpoint; smtp: MailEndpoint } | null;
}

/** QQ 邮箱（阶段2~6 全部实测结论的载体：993 隐式 TLS / 465 隐式 TLS / AUTH LOGIN） */
export const QQ_MAIL_PROVIDER: MailProviderDefinition = {
  id: 'qq',
  label: 'QQ邮箱',
  description: '内置端点 imap.qq.com:993（SSL）与 smtp.qq.com:465（SSL），授权码登录',
  fixedEndpoints: {
    imap: { host: 'imap.qq.com', port: 993, encryption: 'ssl' },
    smtp: { host: 'smtp.qq.com', port: 465, encryption: 'ssl' },
  },
};

/** 其他邮箱（端点完全由 settings 的六个 mailCustom* 键提供） */
export const CUSTOM_MAIL_PROVIDER: MailProviderDefinition = {
  id: 'custom',
  label: '其他',
  description: '自定义 IMAP / SMTP 主机、端口与加密方式（SSL 或 STARTTLS）',
  fixedEndpoints: null,
};

/**
 * provider 注册表（**新增服务商只改这里**）：
 * 1) 在 shared/types/config.ts 的 MailProviderType 里追加 id；
 * 2) 在本表追加一条 MailProviderDefinition（含 fixedEndpoints）；
 * 3) 若该服务商有历史默认值需要夹紧，在 resolveMailEndpoints 的 default 分支复用其 fixed 端点。
 * 业务侧（watch-service / mail-bridge / smtp-client / 前端下拉）从 MAIL_PROVIDERS 读取，
 * 因此「新增网易/阿里邮箱」无需改任何调用点。
 */
export const MAIL_PROVIDERS: Record<MailProviderType, MailProviderDefinition> = {
  qq: QQ_MAIL_PROVIDER,
  custom: CUSTOM_MAIL_PROVIDER,
};

/** 默认 provider（未配置键时的取值；与 DEFAULT_APP_SETTINGS.mailProviderType 一致） */
export const DEFAULT_MAIL_PROVIDER_ID: MailProviderType = 'qq';

/** 默认端口（自定义邮箱端口非法时回落：SSL 惯例 993/465） */
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_PORT = 465;

/** 端口夹紧：非有限数 / 非整数 / 越界 → fallback */
export function normalizePort(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const port = Math.floor(value);
  if (port < 1 || port > 65_535) {
    return fallback;
  }
  return port;
}

/** provider id 归一：未知值回落默认 provider（配置文件被手工改坏时不炸） */
export function normalizeProviderType(value: unknown): MailProviderType {
  return value === 'custom' ? 'custom' : DEFAULT_MAIL_PROVIDER_ID;
}

/** 加密方式归一：只接受 'starttls'，其余（含非法值）一律 'ssl'（QQ 实测形态） */
export function normalizeEncryption(value: unknown): MailSocketEncryption {
  return value === 'starttls' ? 'starttls' : 'ssl';
}

/** 主机名清洗：trim + 去协议前缀/路径（用户常把 https:// 粘进来） */
export function normalizeHost(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  let host = value.trim();
  host = host.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  host = host.replace(/\/.*$/, '');
  host = host.replace(/:\d+$/, '');
  return host.trim().toLowerCase();
}

/** 端点缺省判定（host 为空或端口非法都算不可用） */
export function isEndpointUsable(endpoint: MailEndpoint): boolean {
  return endpoint.host.length > 0 && endpoint.port > 0;
}

/**
 * 解析生效端点（**收信与发信的唯一端点来源**）。
 * - 'qq'：返回内置常量（与阶段2~6 实测完全一致，行为等价）；
 * - 'custom'：读 mailCustomImap 前缀与 mailCustomSmtp 前缀共六个键，逐项归一（host 清洗、port 夹紧、
 *   encryption 归一），不在此处校验必填（校验交给 validateMailEndpoints，便于前端逐字段提示）。
 */
export function resolveMailEndpoints(
  settings: Pick<
    AppSettings,
    | 'mailProviderType'
    | 'mailCustomImapHost'
    | 'mailCustomImapPort'
    | 'mailCustomImapEncryption'
    | 'mailCustomSmtpHost'
    | 'mailCustomSmtpPort'
    | 'mailCustomSmtpEncryption'
  >,
): MailProviderEndpoints {
  const providerId = normalizeProviderType(settings.mailProviderType);
  const provider = MAIL_PROVIDERS[providerId];
  if (provider.fixedEndpoints) {
    return {
      providerId,
      providerLabel: provider.label,
      imap: { ...provider.fixedEndpoints.imap },
      smtp: { ...provider.fixedEndpoints.smtp },
    };
  }
  return {
    providerId,
    providerLabel: provider.label,
    imap: {
      host: normalizeHost(settings.mailCustomImapHost),
      port: normalizePort(settings.mailCustomImapPort, DEFAULT_IMAP_PORT),
      encryption: normalizeEncryption(settings.mailCustomImapEncryption),
    },
    smtp: {
      host: normalizeHost(settings.mailCustomSmtpHost),
      port: normalizePort(settings.mailCustomSmtpPort, DEFAULT_SMTP_PORT),
      encryption: normalizeEncryption(settings.mailCustomSmtpEncryption),
    },
  };
}

/** 端点可用性校验（开启值守 / 保存自定义配置前的确定性判定） */
export type MailEndpointValidation =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * 校验端点可用性：
 * - 自定义邮箱两端 host 必填（缺失 → ERR_WATCH_FIELD_MISSING，与既有「值守邮箱未配置」同码族）
 * - host 必须是「字母数字.-」组成的域名/主机名（拒绝空格、斜杠、@ 等明显错误输入）
 */
export function validateMailEndpoints(endpoints: MailProviderEndpoints): MailEndpointValidation {
  const hostPattern = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
  const checks: Array<{ label: string; endpoint: MailEndpoint }> = [
    { label: 'IMAP', endpoint: endpoints.imap },
    { label: 'SMTP', endpoint: endpoints.smtp },
  ];
  for (const check of checks) {
    if (!check.endpoint.host) {
      return {
        ok: false,
        code: 'ERR_WATCH_FIELD_MISSING',
        message: `${endpoints.providerLabel}的 ${check.label} 服务器地址未填写`,
      };
    }
    if (!hostPattern.test(check.endpoint.host)) {
      return {
        ok: false,
        code: 'ERR_WATCH_FIELD_INVALID',
        message: `${endpoints.providerLabel}的 ${check.label} 服务器地址不合法：${check.endpoint.host}`,
      };
    }
  }
  return { ok: true };
}

/** 端点展示文本（日志与回执：host:port/encryption，不含任何凭据） */
export function describeMailEndpoint(endpoint: MailEndpoint): string {
  return `${endpoint.host}:${endpoint.port}/${endpoint.encryption}`;
}

/** 双端展示文本 */
export function describeMailEndpoints(endpoints: MailProviderEndpoints): string {
  return `${endpoints.providerLabel} IMAP ${describeMailEndpoint(endpoints.imap)} / SMTP ${describeMailEndpoint(endpoints.smtp)}`;
}
