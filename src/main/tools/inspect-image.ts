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
import {
  ERR_VISION_MODEL_ERROR,
} from '../modules/llm/constants';
import {
  ERR_PATH_NOT_FILE,
  ERR_FILE_NOT_FOUND,
  ERR_FILE_READ_ERROR,
  ERR_ABORTED,
  ERR_OK,
} from '../constants';

type InspectImageInput = {
  file_path?: unknown;
  query_target?: unknown;
};

const VISION_SYSTEM_PROMPT = `
# 角色
\`\`\`
你是图片事实分析助手。
\`\`\`

# 任务
\`\`\`
- 仅依据输入图片和查询目标，识别、提取并分析当前图片中的可见信息。
- 分析信息必须足够全面、细致，没有遗漏。
- 结论必须依据图片中的事实信息，禁止虚构。
\`\`\`

# 分析约束
\`\`\`
- 只描述图片中可见、可识别、可直接依据视觉信息判断的内容。
- 禁止把图片外知识、常识推断、意图猜测或未显示内容写成事实。
- 无法确认的内容必须明确说明“不确定”或“图片中无法确认”。
- 查询目标相关的主体、文字、数字、符号、颜色、位置、数量、关系、状态、界面元素、表格结构、异常细节、上下文线索等等，必须尽量覆盖。
- 查询目标较宽泛时，先给整体描述，再按信息类型归纳。
- 查询目标具体时，优先回答查询目标，再补充与查询目标直接相关的可见信息。
\`\`\`

# 输出要求
\`\`\`
- 默认使用中文。
- 直接输出图片分析结果。
- 禁止输出与图片无关的解释。
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
  queryTarget: string;
  imageDataUrl: string;
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
    messages: buildVisionMessages(options),
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

export async function inspectImage(
  input: unknown,
  context: ToolRuntimeContext,
): Promise<ToolResult> {
  const resolvedInput =
    input && typeof input === 'object' ? (input as InspectImageInput) : {};
  const filePath = normalizeFilePath(resolvedInput.file_path);
  const queryTarget = normalizeString(resolvedInput.query_target);
  const resolvedFilePath = resolveImagePath(filePath, context);

  let buffer: Buffer;

  try {
    const fileStat = await stat(resolvedFilePath);

    if (!fileStat.isFile()) {
      return buildToolResult({
        success: false,
        code: ERR_PATH_NOT_FILE,
        message: '图片路径不是文件',
      });
    }
  } catch {
    return buildToolResult({
      success: false,
      code: ERR_FILE_NOT_FOUND,
      message: '图片文件不存在',
    });
  }

  try {
    buffer = await readFile(resolvedFilePath);
  } catch (error) {
    const message = ensureErrorMessage(error);

    return buildToolResult({
      success: false,
      code: ERR_FILE_READ_ERROR,
      message: `图片文件读取失败：${message}`,
    });
  }

  const imagePayload = await prepareModelImagePayload(buffer);

  if (!imagePayload.success) {
    return buildToolResult({
      success: false,
      code: imagePayload.code,
      message: imagePayload.message,
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
      queryTarget,
      imageDataUrl: buildDataUrl(imagePayload.buffer, imagePayload.mimeType),
      modelConfig: visionModelConfig,
    });

    return buildToolResult({
      success: true,
      code: ERR_OK,
      message: '图片识别完成',
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
        message: '图片识别已取消',
      });
    }

    return buildToolResult({
      success: false,
      code: ERR_VISION_MODEL_ERROR,
      message: `识图模型调用失败：${message}`,
    });
  }
}
