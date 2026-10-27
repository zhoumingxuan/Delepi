/**
 * 客户端自动更新模块入口（生命周期导出；幂等启动）
 */

import { updateManager } from './update-manager';

let initialized = false;

export async function initUpdateManager(): Promise<void> {
  if (initialized) {
    return;
  }
  initialized = true;
  await updateManager.init();
}

export function disposeUpdateManager(): void {
  updateManager.dispose();
}

export { updateManager } from './update-manager';
