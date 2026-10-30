/**
 * 客户端自动更新：构建期默认值读取（全模块唯一读取点）
 *
 * L2：Vite define 注入的 __DELEPI_UPDATE_*_OVERRIDE__（未设置时为空串）；
 * L3：已废弃（恒空串），保留读取代码以兼容读取旧安装包内已注入的 package.json；
 * L4：src/shared/update-constants.ts 的源码常量。
 *
 * 注意：必须用 fs.readFileSync 读取 package.json，禁止 require——require 会被 bundler
 * 内联为构建机上的静态值，导致 L3 永远读不到安装包内的真实注入值。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveDefaultUpdateBaseUrl,
  resolveUpdateAccessKey,
  type UpdateValueSource,
} from './update-resolve';

declare const __DELEPI_UPDATE_BASE_URL_OVERRIDE__: string;
declare const __DELEPI_UPDATE_ACCESS_KEY_OVERRIDE__: string;

export interface EffectiveUpdateDefaults {
  baseUrl: string;
  baseUrlSource: UpdateValueSource;
  accessKey: string;
  accessKeySource: UpdateValueSource;
}

interface PackagedUpdateMetadata {
  baseUrl: string;
  accessKey: string;
}

let cachedDefaults: EffectiveUpdateDefaults | null = null;

/** 读取当前 app 的 package.json（dev=工程根；packaged=resources/app.asar/package.json） */
function readPackagedUpdateMetadata(): PackagedUpdateMetadata {
  try {
    const pkgPath = path.join(app.getAppPath(), 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      delepiUpdate?: { baseUrl?: unknown; accessKey?: unknown };
    };
    const meta = parsed?.delepiUpdate;
    return {
      baseUrl: typeof meta?.baseUrl === 'string' ? meta.baseUrl : '',
      accessKey: typeof meta?.accessKey === 'string' ? meta.accessKey : '',
    };
  } catch {
    return { baseUrl: '', accessKey: '' };
  }
}

function readEnvOverride(kind: 'baseUrl' | 'accessKey'): string {
  if (kind === 'baseUrl') {
    return typeof __DELEPI_UPDATE_BASE_URL_OVERRIDE__ === 'string'
      ? __DELEPI_UPDATE_BASE_URL_OVERRIDE__
      : '';
  }
  return typeof __DELEPI_UPDATE_ACCESS_KEY_OVERRIDE__ === 'string'
    ? __DELEPI_UPDATE_ACCESS_KEY_OVERRIDE__
    : '';
}

/** 解析生效默认值（进程内缓存：构建期注入值与安装包 package.json 在运行期不会变化） */
export function resolveEffectiveUpdateDefaults(): EffectiveUpdateDefaults {
  if (cachedDefaults) {
    return cachedDefaults;
  }
  const packaged = readPackagedUpdateMetadata();
  const base = resolveDefaultUpdateBaseUrl(readEnvOverride('baseUrl'), packaged.baseUrl);
  const key = resolveUpdateAccessKey(readEnvOverride('accessKey'), packaged.accessKey);
  cachedDefaults = {
    baseUrl: base.baseUrl,
    baseUrlSource: base.source,
    accessKey: key.accessKey,
    accessKeySource: key.source,
  };
  return cachedDefaults;
}
