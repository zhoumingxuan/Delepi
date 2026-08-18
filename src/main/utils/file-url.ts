
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 把本地绝对路径转换为 file:// URL。
 * - 绝对路径通过 path.resolve() 强制解析（避免相对路径以 cwd 为基准）。
 * - 调用 pathToFileURL（Node 标准库）保证 Windows 盘符、空格、中文等转义正确。
 * - 解析失败时返回 null（与 E:\ai_fr buildUserOutputStaticUrl 行为一致）。
 * @param absolutePath 本地绝对路径或可解析为绝对路径的字符串
 * @returns file:// URL 字符串，解析失败返回 null
 */
export function buildLocalFileUrl(absolutePath: string): string | null {
  if (!absolutePath || typeof absolutePath !== 'string') {
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
