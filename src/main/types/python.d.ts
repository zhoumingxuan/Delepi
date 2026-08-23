/**
 * Python 内置环境 IPC 类型声明
 */

/**
 * 系统 Python 环境检测信息
 */
export interface SystemPythonInfo {
  found: boolean;
  pythonPath?: string;
  version?: string;
  error?: string;
}
