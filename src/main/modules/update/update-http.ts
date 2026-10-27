/**
 * 客户端自动更新：HTTP 检查客户端与下载器（Node 内置 http/https，零新增依赖）
 *
 * 契约（服务端由并行任务实现，两端必须逐字一致）：
 * - GET {baseUrl}/check?version=<当前版本>&platform=<win10|linux|mac>
 * - GET {baseUrl}/download?platform=<...>&version=<可选>
 * - 请求头 X-Delepi-Update-Key: <32 位授权码>
 * - 所有失败一律 404 + {"detail":"Not Found"}；客户端把 404 单独识别为 unauthorized。
 */

import http from 'node:http';
import https from 'node:https';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { UPDATE_ACCESS_KEY_HEADER } from '@shared/update-constants';
import { UPDATE_ERROR_CODES } from '@shared/update-error-codes';
import type { UpdatePackageInfo, UpdatePlatform } from '@shared/types/update';
import {
  CONNECT_TIMEOUT_MS,
  DOWNLOAD_IDLE_TIMEOUT_MS,
  DOWNLOAD_PROGRESS_BYTES_STEP,
  DOWNLOAD_PROGRESS_INTERVAL_MS,
  DOWNLOAD_TOTAL_TIMEOUT_MS,
  RESPONSE_TIMEOUT_MS,
} from './update-defaults';
import { parseUpdateVersion } from './update-version';
import { isSafePackageFileName } from './update-cache';

const MAX_JSON_BYTES = 64 * 1024;

export class UpdateRequestError extends Error {
  readonly code: string;
  readonly httpStatus: number | null;

  constructor(code: string, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = 'UpdateRequestError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface UpdateCheckPayload {
  schemaVersion: 1;
  latestVersion: string;
  updateNotes: string;
  hasPackage: boolean;
  package: UpdatePackageInfo | null;
}

interface TextResponse {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

function createRequest(
  url: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
): ClientRequest {
  if (url.protocol === 'http:') {
    return http.request(url, options, onResponse);
  }
  return https.request(url, options, onResponse);
}

function mapNetworkError(error: unknown): UpdateRequestError {
  if (error instanceof UpdateRequestError) {
    return error;
  }
  const candidate = error as { name?: string; code?: string; message?: string } | null;
  if (candidate?.name === 'AbortError' || candidate?.code === 'ABORT_ERR') {
    return new UpdateRequestError(UPDATE_ERROR_CODES.CANCELLED, '请求已取消');
  }
  if (candidate?.code === 'ETIMEDOUT' || candidate?.code === 'ESOCKETTIMEDOUT') {
    return new UpdateRequestError(UPDATE_ERROR_CODES.TIMEOUT, '请求超时');
  }
  return new UpdateRequestError(
    UPDATE_ERROR_CODES.NETWORK,
    candidate?.message ? `网络请求失败：${candidate.message}` : '网络请求失败',
  );
}

function buildEndpoint(baseUrl: string, pathname: string): URL {
  const normalized = baseUrl.replace(/\/+$/, '');
  return new URL(`${normalized}${pathname}`);
}

function requestText(url: URL, accessKey: string, timeoutMs: number): Promise<TextResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    const request = createRequest(
      url,
      {
        method: 'GET',
        headers: {
          [UPDATE_ACCESS_KEY_HEADER]: accessKey,
          Accept: 'application/json',
        },
        timeout: timeoutMs,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status === 404) {
          response.resume();
          finish(() => reject(new UpdateRequestError(
            UPDATE_ERROR_CODES.UNAUTHORIZED,
            '更新服务返回 404',
            404,
          )));
          return;
        }
        if (status >= 500) {
          response.resume();
          finish(() => reject(new UpdateRequestError(
            UPDATE_ERROR_CODES.SERVER,
            `更新服务返回 ${status}`,
            status,
          )));
          return;
        }
        if (status !== 200) {
          response.resume();
          finish(() => reject(new UpdateRequestError(
            UPDATE_ERROR_CODES.BAD_RESPONSE,
            `更新服务返回非预期状态 ${status}`,
            status,
          )));
          return;
        }

        let body = '';
        let bytes = 0;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          bytes += Buffer.byteLength(chunk, 'utf8');
          if (bytes > MAX_JSON_BYTES) {
            request.destroy();
            finish(() => reject(new UpdateRequestError(
              UPDATE_ERROR_CODES.BAD_RESPONSE,
              '更新服务响应体过大',
              status,
            )));
            return;
          }
          body += chunk;
        });
        response.on('end', () => finish(() => resolve({ status, body, headers: response.headers })));
        response.on('error', (error) => finish(() => reject(mapNetworkError(error))));
        response.on('aborted', () => finish(() => reject(new UpdateRequestError(
          UPDATE_ERROR_CODES.NETWORK,
          '响应连接中断',
        ))));
        response.on('close', () => {
          if (!response.complete) {
            finish(() => reject(new UpdateRequestError(
              UPDATE_ERROR_CODES.NETWORK,
              '响应连接提前关闭',
            )));
          }
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new UpdateRequestError(UPDATE_ERROR_CODES.TIMEOUT, '更新请求超时'));
    });
    request.on('error', (error) => finish(() => reject(mapNetworkError(error))));
    request.end();
  });
}

/** 解析并校验 /check 响应五字段 */
export function parseUpdateCheckPayload(raw: string): UpdateCheckPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UpdateRequestError(UPDATE_ERROR_CODES.BAD_RESPONSE, '更新服务响应不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new UpdateRequestError(UPDATE_ERROR_CODES.BAD_RESPONSE, '更新服务响应不是对象');
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new UpdateRequestError(UPDATE_ERROR_CODES.BAD_RESPONSE, '更新清单 schemaVersion 不匹配');
  }
  const latestVersion = typeof record.latestVersion === 'string'
    ? record.latestVersion.trim()
    : '';
  if (!parseUpdateVersion(latestVersion)) {
    throw new UpdateRequestError(UPDATE_ERROR_CODES.BAD_RESPONSE, '更新清单 latestVersion 非法');
  }
  if (typeof record.updateNotes !== 'string') {
    throw new UpdateRequestError(UPDATE_ERROR_CODES.BAD_RESPONSE, '更新清单 updateNotes 非法');
  }
  const updateNotes = record.updateNotes;
  if (updateNotes.length > 4000) {
    throw new UpdateRequestError(UPDATE_ERROR_CODES.BAD_RESPONSE, '更新摘要超过 4000 字符');
  }
  if (typeof record.hasPackage !== 'boolean') {
    throw new UpdateRequestError(UPDATE_ERROR_CODES.BAD_RESPONSE, '更新清单 hasPackage 非法');
  }

  let packageInfo: UpdatePackageInfo | null = null;
  if (record.package !== null && record.package !== undefined) {
    if (typeof record.package !== 'object') {
      throw new UpdateRequestError(UPDATE_ERROR_CODES.BAD_RESPONSE, '更新清单 package 非法');
    }
    const rawPackage = record.package as Record<string, unknown>;
    const fileName = typeof rawPackage.fileName === 'string' ? rawPackage.fileName : '';
    const size = typeof rawPackage.size === 'number' ? rawPackage.size : Number.NaN;
    const sha256 = typeof rawPackage.sha256 === 'string' ? rawPackage.sha256 : '';
    if (!isSafePackageFileName(fileName)
      || !Number.isSafeInteger(size)
      || size <= 0
      || !/^[0-9a-fA-F]{64}$/.test(sha256)) {
      throw new UpdateRequestError(UPDATE_ERROR_CODES.BAD_RESPONSE, '更新清单 package 字段非法');
    }
    packageInfo = { fileName, size, sha256: sha256.toLowerCase() };
  }
  if (record.hasPackage && !packageInfo) {
    throw new UpdateRequestError(UPDATE_ERROR_CODES.BAD_RESPONSE, 'hasPackage=true 但 package 为空');
  }

  return {
    schemaVersion: 1,
    latestVersion,
    updateNotes,
    hasPackage: record.hasPackage,
    package: packageInfo,
  };
}

/**
 * 请求 /check。
 * 404 → ERR_UPDATE_UNAUTHORIZED（不重试、不打网络故障日志风暴）；
 * 5xx → ERR_UPDATE_SERVER；非 JSON / 字段缺失 → ERR_UPDATE_BAD_RESPONSE。
 */
export async function requestUpdateCheck(params: {
  baseUrl: string;
  accessKey: string;
  currentVersion: string;
  platform: UpdatePlatform;
}): Promise<UpdateCheckPayload> {
  const url = buildEndpoint(params.baseUrl, '/check');
  url.searchParams.set('version', params.currentVersion);
  url.searchParams.set('platform', params.platform);
  const response = await requestText(url, params.accessKey, RESPONSE_TIMEOUT_MS);
  return parseUpdateCheckPayload(response.body);
}

export interface DownloadPackageParams {
  baseUrl: string;
  accessKey: string;
  platform: UpdatePlatform;
  version: string;
  partPath: string;
  expectedSize: number;
  signal: AbortSignal;
  onProgress: (receivedBytes: number, totalBytes: number) => void;
}

/**
 * 流式下载安装包到 .part：
 * - 以清单 size + sha256 为唯一校验依据（Content-Length 只用于进度展示）；
 * - 传输中断保留 .part（下次覆盖写），用户取消由 manager 删除；
 * - 返回落盘字节数与流式 SHA-256。
 */
export async function downloadUpdatePackage(
  params: DownloadPackageParams,
): Promise<{ receivedBytes: number; sha256: string }> {
  const url = buildEndpoint(params.baseUrl, '/download');
  url.searchParams.set('platform', params.platform);
  if (params.version) {
    url.searchParams.set('version', params.version);
  }

  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const writeStream = createWriteStream(params.partPath, { flags: 'w' });
    let receivedBytes = 0;
    let lastProgressAt = 0;
    let lastProgressBytes = 0;
    let settled = false;
    let totalTimer: ReturnType<typeof setTimeout> | null = null;

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (totalTimer) {
        clearTimeout(totalTimer);
      }
      writeStream.destroy();
      reject(error instanceof UpdateRequestError ? error : mapNetworkError(error));
    };

    totalTimer = setTimeout(() => {
      fail(new UpdateRequestError(UPDATE_ERROR_CODES.TIMEOUT, '下载总时长超过上限'));
    }, DOWNLOAD_TOTAL_TIMEOUT_MS);

    const request = createRequest(
      url,
      {
        method: 'GET',
        headers: { [UPDATE_ACCESS_KEY_HEADER]: params.accessKey },
        timeout: DOWNLOAD_IDLE_TIMEOUT_MS,
        signal: params.signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const packageStatus = String(response.headers['x-delepi-package-status'] ?? '');
        if (status === 404) {
          response.resume();
          fail(new UpdateRequestError(UPDATE_ERROR_CODES.UNAUTHORIZED, '下载接口返回 404', 404));
          return;
        }
        if (status !== 200) {
          response.resume();
          fail(new UpdateRequestError(
            status >= 500 ? UPDATE_ERROR_CODES.SERVER : UPDATE_ERROR_CODES.BAD_RESPONSE,
            `下载接口返回 ${status}`,
            status,
          ));
          return;
        }
        if (packageStatus === 'absent') {
          response.resume();
          fail(new UpdateRequestError(UPDATE_ERROR_CODES.NO_PACKAGE, '服务端未提供安装包'));
          return;
        }

        response.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
          hash.update(chunk);
          const writable = writeStream.write(chunk);
          if (!writable) {
            response.pause();
          }
          const now = Date.now();
          if (now - lastProgressAt >= DOWNLOAD_PROGRESS_INTERVAL_MS
            || receivedBytes - lastProgressBytes >= DOWNLOAD_PROGRESS_BYTES_STEP) {
            lastProgressAt = now;
            lastProgressBytes = receivedBytes;
            params.onProgress(receivedBytes, params.expectedSize);
          }
        });
        writeStream.on('drain', () => response.resume());
        response.on('end', () => {
          params.onProgress(receivedBytes, params.expectedSize);
          writeStream.end();
        });
        response.on('error', (error) => fail(mapNetworkError(error)));
        response.on('aborted', () => fail(new UpdateRequestError(
          UPDATE_ERROR_CODES.NETWORK,
          '下载连接中断',
        )));
        response.on('close', () => {
          if (!response.complete) {
            fail(new UpdateRequestError(
              UPDATE_ERROR_CODES.NETWORK,
              '下载连接提前关闭',
            ));
          }
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new UpdateRequestError(UPDATE_ERROR_CODES.TIMEOUT, '下载连接无数据超时'));
    });
    request.on('error', (error) => fail(mapNetworkError(error)));
    writeStream.on('error', (error) => fail(
      new UpdateRequestError(UPDATE_ERROR_CODES.WRITE, `安装包落盘失败：${error.message}`),
    ));
    writeStream.on('finish', () => {
      if (settled) {
        return;
      }
      settled = true;
      if (totalTimer) {
        clearTimeout(totalTimer);
      }
      resolve({ receivedBytes, sha256: hash.digest('hex') });
    });
    request.end();
  });
}

/** 仅用于日志：从地址中提取主机名，绝不打印完整 URL 的 query */
export function extractEndpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '';
  }
}

/** 连接超时（保留常量导出，供未来复用；当前 requestText 使用 RESPONSE_TIMEOUT_MS） */
export const UPDATE_CONNECT_TIMEOUT_MS = CONNECT_TIMEOUT_MS;
