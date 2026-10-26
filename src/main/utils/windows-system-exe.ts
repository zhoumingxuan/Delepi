/**
 * Windows 系统可执行文件绝对路径解析。
 *
 * 背景：在 PATH 极短（例如仅含应用内置 Python 目录）的子进程环境中，系统工具的裸名
 * 无法被 CreateProcess 解析（实测 FileNotFoundError）。PowerShell 与进程终止
 * 工具均位于 %SystemRoot% 下的固定位置，直接以绝对路径寻址，不依赖 PATH。
 *
 * 参数契约：两个解析函数均无入参、返回字符串、不抛错、不依赖 electron 的 app 对象。
 */
import path from 'node:path';

/** 解析 Windows 系统根目录：SystemRoot → windir → SystemDrive 派生的 <SystemDrive>\\Windows → C:\\Windows 逐级回退，保证不抛错 */
function resolveWindowsSystemRoot(): string {
  return process.env.SystemRoot || process.env.windir || (process.env.SystemDrive ? path.join(process.env.SystemDrive, 'Windows') : '') || 'C:\\Windows';
}

/** 解析 Windows PowerShell 绝对路径：SystemRoot 下 System32\\WindowsPowerShell\\v1.0 目录内 */
export function resolveWindowsPowerShellPath(): string {
  return path.join(resolveWindowsSystemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** 解析进程终止工具绝对路径：SystemRoot 下 System32 目录内（不依赖 PATH 中的裸名） */
export function resolveWindowsTaskkillPath(): string {
  return path.join(resolveWindowsSystemRoot(), 'System32', 'taskkill.exe');
}
