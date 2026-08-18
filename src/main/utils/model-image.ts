import sharp from 'sharp';
import { MODEL_IMAGE_JPEG_QUALITY } from '../modules/llm/constants';
import {
  ERR_IMAGE_RESIZE_FAILED,
  ERR_NOT_IMAGE_FILE,
  ERR_UNSUPPORTED_IMAGE_FORMAT,
  MAX_MODEL_IMAGE_HEIGHT,
  MAX_MODEL_IMAGE_WIDTH,
} from '../constants';
import { ensureErrorMessage } from './index';
import {
  CONTENT_TYPE_BY_EXTENSION,
  DEFAULT_CONTENT_TYPE,
} from '@shared/utils/file-mime';

export type ModelImagePayload =
  | {
      success: true;
      buffer: Buffer;
      mimeType: string;
    }
  | {
      success: false;
      code: string;
      message: string;
    };

export function buildDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function shouldResizeImage(width: number, height: number): boolean {
  return width > MAX_MODEL_IMAGE_WIDTH || height > MAX_MODEL_IMAGE_HEIGHT;
}

async function encodeModelImage(
  pipeline: sharp.Sharp,
): Promise<{
  buffer: Buffer;
  mimeType: string;
}> {
  return {
    buffer: await pipeline
      .flatten({ background: '#fff' })
      .jpeg({
        quality: MODEL_IMAGE_JPEG_QUALITY,
        mozjpeg: true,
      })
      .toBuffer(),
    mimeType: 'image/jpeg',
  };
}

export async function prepareModelImagePayload(
  buffer: Buffer,
): Promise<ModelImagePayload> {
  let metadata: sharp.Metadata;

  try {
    metadata = await sharp(buffer, {
      animated: false,
    }).metadata();
  } catch {
    return {
      success: false,
      code: ERR_NOT_IMAGE_FILE,
      message: '文件不是图片',
    };
  }

  const formatExtension = metadata.format ? `.${metadata.format.toLowerCase()}` : '';
  const sourceMimeType = CONTENT_TYPE_BY_EXTENSION[formatExtension] ?? DEFAULT_CONTENT_TYPE;

  if (!sourceMimeType.startsWith('image/')) {
    return {
      success: false,
      code: ERR_UNSUPPORTED_IMAGE_FORMAT,
      message: `图片格式不支持：${sourceMimeType || 'unknown'}`,
    };
  }

  const originalWidth = metadata.width ?? 0;
  const originalHeight = metadata.height ?? 0;

  if (!originalWidth || !originalHeight) {
    return {
      success: false,
      code: ERR_NOT_IMAGE_FILE,
      message: '文件不是图片',
    };
  }

  try {
    let pipeline = sharp(buffer, {
      animated: false,
    }).rotate();

    if (shouldResizeImage(originalWidth, originalHeight)) {
      pipeline = pipeline.resize({
        width: MAX_MODEL_IMAGE_WIDTH,
        height: MAX_MODEL_IMAGE_HEIGHT,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    const encoded = await encodeModelImage(pipeline);
    const encodedMetadata = await sharp(encoded.buffer, {
      animated: false,
    }).metadata();

    if (
      !encodedMetadata.width ||
      !encodedMetadata.height ||
      shouldResizeImage(encodedMetadata.width, encodedMetadata.height)
    ) {
      return {
        success: false,
        code: ERR_IMAGE_RESIZE_FAILED,
        message: '图片处理失败',
      };
    }

    return {
      success: true,
      buffer: encoded.buffer,
      mimeType: encoded.mimeType,
    };
  } catch (error) {
    return {
      success: false,
      code: ERR_IMAGE_RESIZE_FAILED,
      message: `图片处理失败：${ensureErrorMessage(error)}`,
    };
  }
}
