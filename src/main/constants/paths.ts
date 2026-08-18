/**
 * 路径相关常量
 * 归集自 sqlite-adapter.ts、storage-paths.ts、main/index.ts、run-with-python.ts
 */

// ============================================================
// 数据库路径
// ============================================================

/** 数据库文件名 */
export const DB_FILE_NAME = 'delepi.db';

/** 数据目录名 */
export const DATA_DIR_NAME = 'data';

// ============================================================
// 存储目录名
// ============================================================

/** 客户端本地数据根目录名 */
export const BIN_DIR_NAME = 'bin';

/** 会话目录名 */
export const CONVERSATIONS_DIR_NAME = 'conversations';

/** 输出目录名 */
export const OUTPUT_DIR_NAME = 'output';

/** 上传目录名 */
export const UPLOADS_DIR_NAME = 'uploads';

// ============================================================
// 文件名
// ============================================================

/** manifest 文件名 */
export const MANIFEST_FILE_NAME = 'manifest.json';

// ============================================================
// Electron 路径段
// ============================================================

/** preload 路径段 */
export const PRELOAD_PATH_SEGMENT = 'preload';

/** preload 文件名 */
export const PRELOAD_FILE_NAME = 'preload.js';

/** renderer 路径段 */
export const RENDERER_PATH_SEGMENT = 'renderer';

/** renderer 入口文件名 */
export const RENDERER_INDEX_FILE = 'index.html';

// ============================================================
// Python 缓存
// ============================================================

/** Python 缓存目录名 */
export const PYCACHE_DIR_NAME = '__pycache__';
