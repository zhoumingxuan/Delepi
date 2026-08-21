
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * R5③：判断字符串是否为本地绝对路径。
 * Windows 主进程下仅接受盘符形态（如 E:\... 或 E:/...）、UNC 形态（如 \\server\share\...）
 * 以及 path.isAbsolute 判定的其余绝对形态；相对路径一律视为非绝对路径。
 */
function isAbsoluteLocalPath(candidate: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(candidate) ||
    candidate.startsWith('\\\\') ||
    path.isAbsolute(candidate)
  );
}

/**
 * 把本地绝对路径转换为 file:// URL。
 * - 仅接受绝对路径：相对路径不按主进程 CWD resolve（R5③ 修复，避免解析出错误绝对路径），记录警告并返回 null。
 * - 绝对路径经 path.resolve() 规范化后调用 pathToFileURL（Node 标准库），
 *   保证 Windows 盘符、空格、中文等转义正确。
 * - 解析失败时返回 null（与 E:\ai_fr buildUserOutputStaticUrl 行为一致）。
 * @param absolutePath 本地绝对路径字符串
 * @returns file:// URL 字符串；相对路径或解析失败返回 null
 */
export function buildLocalFileUrl(absolutePath: string): string | null {
  if (!absolutePath || typeof absolutePath !== 'string') {
    return null;
  }

  if (!isAbsoluteLocalPath(absolutePath)) {
    console.warn(`[file-url] 非绝对路径，跳过 file:// URL 生成：${absolutePath}`);
    return null;
  }

  try {
    const resolved = path.resolve(absolutePath);
    return pathToFileURL(resolved).href;
  } catch {
    return null;
  }
}

/**
 * 批量构建 FILE URL，跳过解析失败项。
 * @param absolutePaths 本地绝对路径数组
 * @returns file:// URL 数组（已过滤 null）
 */
export function buildLocalFileUrls(absolutePaths: string[]): string[] {
  const urls: string[] = [];

  for (const absolutePath of absolutePaths) {
    const url = buildLocalFileUrl(absolutePath);
    if (url) {
      urls.push(url);
    }
  }

  return urls;
}
