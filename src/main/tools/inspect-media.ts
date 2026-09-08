import {
  readFile,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

import type OpenAI from 'openai';

import { nonStreamChat, type ModelConfig } from '../modules/llm/openai-client';
import {
  type ToolRuntimeContext,
} from './runtime-context';
import { configManager } from '../modules/config/config-manager';
import {
  buildToolResult,
  type ToolResult,
} from './result';
import { ensureErrorMessage, normalizeString } from '../utils/index';
import {
  buildDataUrl,
  prepareModelImagePayload,
} from '../utils/model-image';
import { CONTENT_TYPE_BY_EXTENSION } from '@shared/utils/file-mime';
import {
  ERR_VISION_MODEL_ERROR,
} from '../modules/llm/constants';
import {
  ERR_PATH_NOT_FILE,
  ERR_FILE_NOT_FOUND,
  ERR_FILE_READ_ERROR,
  ERR_ABORTED,
  ERR_OK,
  ERR_INVALID_ARGUMENT,
  ERR_UNSUPPORTED_VIDEO_FORMAT,
} from '../constants';

type InspectMediaInput = {
  file_path?: unknown;
  query_target?: unknown;
  type?: unknown;
};

const VISION_SYSTEM_PROMPT = `
# 角色
\`\`\`
你是视觉特征分析,视觉信息抓取助手。
\`\`\`

# 任务
\`\`\`
- 1.先尽最大努力分析，输入的【图片或视频】中【细微/极难发现】的视觉特征或视觉动作。
- 2.不做任何假设或者预设条件，依据查询目标，提取所有视觉信息和所有视觉区域。
- 3.剪除【图片或视频】实际不存在的内容。
\`\`\`

# 分析约束
\`\`\`
- 只描述视觉上中可见、可识别、可直接依据视觉信息判断的内容。
- 禁止把图片外知识、常识推断、意图猜测或未显示内容写成事实。
- 无法确认的内容必须明确说明“不确定”或“无法确认”。
\`\`\`

# 输出要求
\`\`\`
- 默认使用中文。
- 输出视觉分析所有结果，禁止输出与视觉分析无关的解释。
\`\`\`
`.trim();

function normalizeFilePath(value: unknown): string {
  return normalizeString(value).replace(/^["']+|["']+$/g, '');
}

function resolveImagePath(
  filePath: string,
  _context: ToolRuntimeContext,
): string {
  return path.resolve(filePath);
}

function buildUserPrompt(queryTarget: string): string {
  return [
    '## 查询目标',
    queryTarget,
  ].join('\n');
}

function buildVisionMessages(options: {
  queryTarget: string;
  imageDataUrl: string;
}): OpenAI.Chat.ChatCompletionMessageParam[] {
  return [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: VISION_SYSTEM_PROMPT,
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: buildUserPrompt(options.queryTarget),
        },
        {
          type: 'image_url',
          image_url: {
            url: options.imageDataUrl,
          },
        },
      ],
    },
  ];
}

function parseMediaType(value: unknown): 'image' | 'video' | null {
  const normalized = normalizeString(value).trim().toLowerCase();

  if (!normalized) {
    return 'image';
  }

  if (normalized === 'image' || normalized === 'video') {
    return normalized;
  }

  return null;
}

function getVideoContentType(filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = extension ? CONTENT_TYPE_BY_EXTENSION[extension] : undefined;

  return mimeType && mimeType.startsWith('video/') ? mimeType : null;
}

function buildVideoVisionMessages(options: {
  queryTarget: string;
  videoDataUrl: string;
}): OpenAI.Chat.ChatCompletionMessageParam[] {
  // 视觉模型（GLM 系等）的视频输入扩展：video_url 内容类型不在 OpenAI SDK 类型内，运行时按原样透传
  const videoContentPart = {
    type: 'video_url',
    video_url: {
      url: options.videoDataUrl,
    },
  } as unknown as OpenAI.Chat.ChatCompletionContentPart;

  return [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: VISION_SYSTEM_PROMPT,
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: buildUserPrompt(options.queryTarget),
        },
        videoContentPart,
      ],
    },
  ];
}

function extractMessageText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (!Array.isArray(value)) {
    return '';
  }

  return value
    .map((item) => {
      if (
        item &&
        typeof item === 'object' &&
        'text' in item &&
        typeof item.text === 'string'
      ) {
        return item.text;
      }

      return '';
    })
    .join('')
    .trim();
}

async function completeImageInspection(options: {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  signal?: AbortSignal;
  modelConfig: ModelConfig;
}): Promise<{
  analysis: string;
  model: string;
  finishReason: string | null;
}> {
  const isGlmModel = options.modelConfig.model.toLowerCase().startsWith('glm');
  const result = await nonStreamChat({
    modelConfig: options.modelConfig,
    messages: options.messages,
    signal: options.signal,
    thinking: isGlmModel
      ? { enableThinking: true, reasoningEffort: 'low' }
      : { enableThinking: false }
  });

  return {
    analysis: extractMessageText(result.content),
    model: result.model,
    finishReason: result.finishReason,
  };
}

export async function InspectMedia(
  input: unknown,
  context: ToolRuntimeContext,
): Promise<ToolResult> {
  const resolvedInput =
    input && typeof input === 'object' ? (input as InspectMediaInput) : {};
  const filePath = normalizeFilePath(resolvedInput.file_path);
  const queryTarget = normalizeString(resolvedInput.query_target);
  const mediaType = parseMediaType(resolvedInput.type);

  if (!mediaType) {
    return buildToolResult({
      success: false,
      code: ERR_INVALID_ARGUMENT,
      message: 'type 参数仅支持 image 或 video',
    });
  }

  const resolvedFilePath = resolveImagePath(filePath, context);

  let buffer: Buffer;

  try {
    const fileStat = await stat(resolvedFilePath);

    if (!fileStat.isFile()) {
      return buildToolResult({
        success: false,
        code: ERR_PATH_NOT_FILE,
        message: mediaType === 'video' ? '视频路径不是文件' : '图片路径不是文件',
      });
    }
  } catch {
    return buildToolResult({
      success: false,
      code: ERR_FILE_NOT_FOUND,
      message: mediaType === 'video' ? '视频文件不存在' : '图片文件不存在',
    });
  }

  try {
    buffer = await readFile(resolvedFilePath);
  } catch (error) {
    const message = ensureErrorMessage(error);

    return buildToolResult({
      success: false,
      code: ERR_FILE_READ_ERROR,
      message: mediaType === 'video' ? `视频文件读取失败：${message}` : `图片文件读取失败：${message}`,
    });
  }

  let visionMessages: OpenAI.Chat.ChatCompletionMessageParam[];

  if (mediaType === 'video') {
    const videoMimeType = getVideoContentType(resolvedFilePath);

    if (!videoMimeType) {
      return buildToolResult({
        success: false,
        code: ERR_UNSUPPORTED_VIDEO_FORMAT,
        message: '视频格式不支持，请使用 mp4、webm、mov 等常见视频格式',
      });
    }

    visionMessages = buildVideoVisionMessages({
      queryTarget,
      videoDataUrl: buildDataUrl(buffer, videoMimeType),
    });
  } else {
    const imagePayload = await prepareModelImagePayload(buffer);

    if (!imagePayload.success) {
      return buildToolResult({
        success: false,
        code: imagePayload.code,
        message: imagePayload.message,
      });
    }

    visionMessages = buildVisionMessages({
      queryTarget,
      imageDataUrl: buildDataUrl(imagePayload.buffer, imagePayload.mimeType),
    });
  }

  try {
    const settings = configManager.getSettings();
    const visionModelConfig: ModelConfig = {
      baseUrl: settings.visionLlmBaseUrl,
      apiKey: settings.visionLlmApiKey,
      model: settings.visionLlmModel,
    };

    const completion = await completeImageInspection({
      messages: visionMessages,
      modelConfig: visionModelConfig,
    });

    return buildToolResult({
      success: true,
      code: ERR_OK,
      message: '视觉识别完成',
      data: {
        analysis: completion.analysis,
      },
    });
  } catch (error) {
    const message = ensureErrorMessage(error);

    if (message === ERR_ABORTED) {
      return buildToolResult({
        success: false,
        code: ERR_ABORTED,
        message: '视觉识别已取消',
      });
    }

    return buildToolResult({
      success: false,
      code: ERR_VISION_MODEL_ERROR,
      message: `识图模型调用失败：${message}`,
    });
  }
}
