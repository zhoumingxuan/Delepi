/**
 * Python 模块导出
 */

export { PythonManager, PythonState, type PythonStatus, type SystemPythonInfo } from './python-manager';
export { DepsManager } from './deps-manager';
export type { DepsStatus, DepsInstallProgress } from '@shared/types/deps';

import { PythonManager } from './python-manager';
import { DepsManager } from './deps-manager';

/** 全局单例 */
export const pythonManager = PythonManager.getInstance();

/** 依赖管理全局单例 */
export const depsManager = DepsManager.getInstance();

// 注册依赖安装回调：PythonManager 安装 pip 后，委托 DepsManager 安装 14 个 recommended 包
pythonManager.setDepsInstallCallback(() => depsManager.autoInstallRecommended());
