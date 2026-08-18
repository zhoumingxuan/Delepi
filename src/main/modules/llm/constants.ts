/**
 * LLM 模块常量
 * 归集自 agent.ts、tools.ts、errors.ts 中的视觉模型/多模态相关常量
 */

// ============================================================
// 多模态/视觉模型常量
// ============================================================

/** 图片交付类型对应的 FILE URL 字段名（原 main/constants/agent.ts） */
export const IMAGE_URLS_FIELD_NAME = 'image_urls';

/** 模型图片 JPEG 编码质量（原 main/constants/tools.ts） */
export const MODEL_IMAGE_JPEG_QUALITY = 100;

/** 视觉模型调用错误码（原 main/constants/errors.ts） */
export const ERR_VISION_MODEL_ERROR = 'VISION_MODEL_ERROR';
