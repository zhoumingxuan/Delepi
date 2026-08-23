/**
 * Python 模块导出
 */

export { PythonManager, PythonState, type SystemPythonInfo } from './python-manager';

import { PythonManager } from './python-manager';

/** 全局单例 */
export const pythonManager = PythonManager.getInstance();

