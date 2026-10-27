/**
 * 客户端自动更新：进程平台 → 服务端平台枚举
 */

import type { UpdatePlatform } from '@shared/types/update';

export function resolveUpdatePlatform(): UpdatePlatform | null {
  if (process.platform === 'win32') {
    return 'win10';
  }
  if (process.platform === 'linux') {
    return 'linux';
  }
  if (process.platform === 'darwin') {
    return 'mac';
  }
  return null;
}
