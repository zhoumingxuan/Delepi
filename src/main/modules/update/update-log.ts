/**
 * 客户端自动更新：脱敏日志（字段白名单，禁止透传任意字符串）
 *
 * 日志格式与 ipc-handlers.writeMainLog / watch-service.writeWatchLog 一致：
 * [ISO] [LEVEL] [stage] k=v ... :: detail
 *
 * 硬约束：任何日志都不得出现完整授权码；detail 中的授权码会被替换为 **** + 末 4 位。
 */

import path from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { app } from 'electron';
import {
  UPDATE_ACCESS_KEY_SOURCE_DEFAULT,
  fingerprintUpdateAccessKey,
} from '@shared/update-constants';

/** 允许写入日志的字段白名单（其余字段一律丢弃） */
const ALLOWED_LOG_FIELDS = new Set([
  'phase',
  'code',
  'httpStatus',
  'durationMs',
  'endpointHost',
  'platform',
  'currentVersion',
  'latestVersion',
  'version',
  'reason',
  'delayMs',
  'nextCheckAt',
  'keyFp',
  'defaultSource',
  'accessKeySource',
  'restored',
  'size',
  'sha256Prefix',
  'receivedBytes',
  'totalBytes',
  'retryCount',
  'removed',
  'launched',
]);

export type UpdateLogFields = Record<string, string | number | boolean | null | undefined>;

/** 日志脱敏：完整授权码 → **** + 末 4 位；超长截断 */
export function sanitizeUpdateLogDetail(text: string): string {
  let output = String(text ?? '');
  if (UPDATE_ACCESS_KEY_SOURCE_DEFAULT) {
    output = output
      .split(UPDATE_ACCESS_KEY_SOURCE_DEFAULT)
      .join(fingerprintUpdateAccessKey(UPDATE_ACCESS_KEY_SOURCE_DEFAULT));
  }
  return output.length > 500 ? `${output.slice(0, 500)}…` : output;
}

export function writeUpdateLog(
  level: 'INFO' | 'WARN' | 'ERROR',
  stage: string,
  fields: UpdateLogFields,
  err?: unknown,
): void {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    mkdirSync(logDir, { recursive: true });
    const segments: string[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!ALLOWED_LOG_FIELDS.has(key) || value === undefined || value === null || value === '') {
        continue;
      }
      segments.push(`${key}=${String(value)}`);
    }
    let detail = '';
    if (err !== undefined) {
      const raw = err instanceof Error
        ? `${err.message}${err.stack ? `\n${err.stack}` : ''}`
        : String(err);
      detail = sanitizeUpdateLogDetail(raw);
    }
    appendFileSync(
      path.join(logDir, 'main.log'),
      `[${new Date().toISOString()}] [${level}] [${stage}] ${segments.join(' ')}${detail ? ` :: ${detail}` : ''}\n`,
      'utf8',
    );
  } catch {
    // 忽略：日志写入失败不影响应用主流程（与 writeMainLog 同策略）
  }
}
