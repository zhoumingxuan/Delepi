/**
 * 跨进程共享的图片 MIME 类型判断工具
 * 主进程和渲染进程均从此文件导入
 */

/**
 * 判断 MIME 类型是否为图片
 * @param contentType MIME 类型字符串
 * @returns 是否为图片类型
 */
export function isImageContentType(contentType: string): boolean {
  return contentType.startsWith('image/');
}
