/**
 * 文件 MIME 类型探测工具(P2)
 *
 * 从 E:\ai_fr\lib\utils\file-mime.ts 复制实现,适配 Delepi 客户端:
 * - 放在 src/shared/utils 目录,供主进程和渲染进程共享使用
 * - IMAGE_SIGNATURES + detectImageContentTypeFromBytes 也放在本文件
 *   (供主进程和渲染进程共用)
 * - 使用 Uint8Array 替代 Buffer 参数(主进程 Buffer / 渲染进程 Uint8Array 都兼容)
 *
 * 探测顺序:
 * 1. detectImageContentTypeFromBytes - 按字节 magic number 探测图片(png/jpeg/gif/webp/bmp/svg)
 * 2. CONTENT_TYPE_BY_EXTENSION - 按文件扩展名映射(120+ 扩展名)
 * 3. 默认 application/octet-stream
 */

import path from 'node:path';

/** 默认 MIME 类型(无法识别时 fallback) */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** 120+ 扩展名 → MIME 映射 */
export const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.3g2': 'video/3gpp2',
  '.3gp': 'video/3gpp',
  '.7z': 'application/x-7z-compressed',
  '.aac': 'audio/aac',
  '.apk': 'application/vnd.android.package-archive',
  '.apng': 'image/apng',
  '.avi': 'video/x-msvideo',
  '.avif': 'image/avif',
  '.azw': 'application/vnd.amazon.ebook',
  '.bat': 'application/x-msdownload',
  '.bin': 'application/octet-stream',
  '.bmp': 'image/bmp',
  '.br': 'application/brotli',
  '.bz': 'application/x-bzip',
  '.bz2': 'application/x-bzip2',
  '.c': 'text/plain; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.conf': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.cur': 'image/x-icon',
  '.dmg': 'application/x-apple-diskimage',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.eot': 'application/vnd.ms-fontobject',
  '.epub': 'application/epub+zip',
  '.exe': 'application/x-msdownload',
  '.flac': 'audio/flac',
  '.gif': 'image/gif',
  '.gz': 'application/gzip',
  '.h': 'text/plain; charset=utf-8',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/vnd.microsoft.icon',
  '.ics': 'text/calendar; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.iso': 'application/x-iso9660-image',
  '.jar': 'application/java-archive',
  '.jpe': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonld': 'application/ld+json; charset=utf-8',
  '.jsonl': 'application/jsonl; charset=utf-8',
  '.jsx': 'text/jsx; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.m4v': 'video/x-m4v',
  '.map': 'application/json; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.oga': 'audio/ogg',
  '.ogv': 'video/ogg',
  '.ogx': 'application/ogg',
  '.opus': 'audio/opus',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.py': 'text/x-python; charset=utf-8',
  '.rar': 'application/vnd.rar',
  '.rtf': 'application/rtf',
  '.sfnt': 'font/sfnt',
  '.sh': 'application/x-sh',
  '.sql': 'application/sql; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.tar': 'application/x-tar',
  '.text': 'text/plain; charset=utf-8',
  '.tgz': 'application/gzip',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.toml': 'application/toml; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.weba': 'audio/webm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.wmv': 'video/x-ms-wmv',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.xz': 'application/x-xz',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.zip': 'application/zip',
  '.zst': 'application/zstd',
};

/**
 * 图片字节签名表 - 按 magic number 探测图片类型
 * 对齐 E:\ai_fr 的图片字节签名判断
 * - png: 89 50 4E 47 0D 0A 1A 0A (8 字节 PNG magic)
 * - jpeg: FF D8 FF (3 字节 JPEG SOI + marker)
 * - gif: GIF87a / GIF89a (6 字节 ASCII)
 * - webp: RIFF....WEBP (12 字节 RIFF + WEBP)
 * - bmp: BM (2 字节 ASCII)
 * - svg: <svg 或 <?xml 包含 <svg (前 512 字节 UTF-8 trimStart)
 */
export const IMAGE_SIGNATURES = [
  {
    mime: 'image/png',
    matches: (buffer: Uint8Array): boolean =>
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a,
  },
  {
    mime: 'image/jpeg',
    matches: (buffer: Uint8Array): boolean =>
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff,
  },
  {
    mime: 'image/gif',
    matches: (buffer: Uint8Array): boolean => {
      if (buffer.length < 6) return false;
      const head = bytesToAscii(buffer, 0, 6);
      return head === 'GIF87a' || head === 'GIF89a';
    },
  },
  {
    mime: 'image/webp',
    matches: (buffer: Uint8Array): boolean => {
      if (buffer.length < 12) return false;
      const riff = bytesToAscii(buffer, 0, 4);
      const webp = bytesToAscii(buffer, 8, 4);
      return riff === 'RIFF' && webp === 'WEBP';
    },
  },
  {
    mime: 'image/bmp',
    matches: (buffer: Uint8Array): boolean => {
      if (buffer.length < 2) return false;
      return bytesToAscii(buffer, 0, 2) === 'BM';
    },
  },
  {
    mime: 'image/svg+xml',
    matches: (buffer: Uint8Array): boolean => {
      // 读取前 512 字节(UTF-8 解码)
      const head = bytesToUtf8(buffer, 0, Math.min(512, buffer.length)).trimStart();
      return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
    },
  },
] as const;

/** 工具:将 Uint8Array 指定区间转 ASCII 字符串 */
function bytesToAscii(buffer: Uint8Array, start: number, length: number): string {
  let result = '';
  const end = Math.min(start + length, buffer.length);
  for (let i = start; i < end; i++) {
    result += String.fromCharCode(buffer[i]);
  }
  return result;
}

/** 工具:将 Uint8Array 指定区间按 UTF-8 解码为字符串 */
function bytesToUtf8(buffer: Uint8Array, start: number, length: number): string {
  // TextDecoder 在主进程和渲染进程都可用
  try {
    return new TextDecoder('utf-8').decode(buffer.subarray(start, start + length));
  } catch {
    return '';
  }
}

/**
 * 按字节 magic number 探测图片 MIME 类型
 * 命中 IMAGE_SIGNATURES 任一项时返回对应 mime,否则 null
 * @param buffer 文件前若干字节(PNG/JPEG/GIF/WEBP 只需前 12 字节,BMP 2 字节,SVG 512 字节)
 *                主进程可传 Buffer(Buffer extends Uint8Array),渲染进程可传 Uint8Array
 */
export function detectImageContentTypeFromBytes(buffer: Uint8Array): string | null {
  if (!buffer || buffer.length === 0) {
    return null;
  }
  for (const signature of IMAGE_SIGNATURES) {
    if (signature.matches(buffer)) {
      return signature.mime;
    }
  }
  return null;
}

/**
 * 获取文件的 MIME 类型(完整探测)
 * 优先级:
 * 1. detectImageContentTypeFromBytes(字节 magic)
 * 2. CONTENT_TYPE_BY_EXTENSION(扩展名映射)
 * 3. DEFAULT_CONTENT_TYPE (application/octet-stream)
 *
 * @param filename 原始文件名(用于扩展名映射;无扩展名时按字节探测)
 * @param buffer 文件字节内容(用于 magic number 探测;可为 Uint8Array 或 Buffer)
 */
export function getFileContentType(filename: string, buffer: Uint8Array): string {
  // 1. 先尝试字节 magic 探测
  const detectedContentType = detectImageContentTypeFromBytes(buffer);
  if (detectedContentType) {
    return detectedContentType;
  }

  // 2. fallback 到扩展名映射
  const extension = path.extname(filename).toLowerCase();
  if (!extension) {
    return DEFAULT_CONTENT_TYPE;
  }

  return CONTENT_TYPE_BY_EXTENSION[extension] ?? DEFAULT_CONTENT_TYPE;
}
