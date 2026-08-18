/**
 * 对话标题生成模块
 * 适配自参考项目 E:\\ai_fr\\lib\\chat\\openai.ts generateConversationTitle
 * 适配：
 *   1. 使用本项目的 ModelConfig 接口（baseUrl/apiKey/model）
 *   2. 简化版：不支持多模态附件（local 模式）
 *   3. title 输出严格遵循 E:\\ai_fr 的 "你是会话标题生成器" prompt 规范
 */

import { MAX_CONVERSATION_TITLE_LENGTH } from '../../constants';
import { DEFAULT_CONVERSATION_TITLE } from '@shared/constants';
import { nonStreamChat, type ModelConfig } from '../llm/openai-client';
import { buildMainAgentTitleUserContent } from './main-agent-message-content';

/**
 * 从原始字符串中提取 JSON 中的 title 字段
 * 适配自 E:\\ai_fr\\lib\\chat\\openai.ts extractConversationTitleFromJson
 */
function extractConversationTitleFromJson(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');

  if (start === -1 || end === -1 || end < start) {
    return '';
  }

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      title?: unknown;
    };

    if (parsed && typeof parsed === 'object' && typeof parsed.title === 'string') {
      return parsed.title;
    }
  } catch {
    return '';
  }

  return '';
}

/**
 * 截断/清理标题为合理长度
 * 适配自 E:\\ai_fr\\lib\\utils.ts truncateConversationTitle
 *   - 提取首行非空内容
 *   - 合并多余空白
 *   - 超出 maxLength 截断并加省略号
 */
export function truncateConversationTitle(text: string, maxLength = MAX_CONVERSATION_TITLE_LENGTH): string {
  const firstLine = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? '';

  if (!firstLine) {
    return DEFAULT_CONVERSATION_TITLE;
  }

  const normalized = firstLine.replace(/\s+/g, ' ');

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trim()}…`;
}

/**
 * 生成对话标题
 * - 调用 LLM 非流式生成
 * - 失败 fallback 到 DEFAULT_CONVERSATION_TITLE
 * - prompt 与 E:\\ai_fr 完全一致：\"你是会话标题生成器\"
 *
 * @param options.modelConfig - 主模型配置
 * @param options.userMessage - 用户首轮输入（用于生成标题）
 * @param options.signal - 中止信号
 * @returns 生成的标题（最多 12 汉字 + 截断到 28 字符）
 */
export async function generateConversationTitle(options: {
  modelConfig: ModelConfig;
  userMessage: string;
  signal?: AbortSignal;
}): Promise<string> {
  const fallbackTitle = DEFAULT_CONVERSATION_TITLE;

  try {
    const result = await nonStreamChat({
      modelConfig: options.modelConfig,
      messages: [
        {
          role: 'system',
          content: `# 角色
你是会话标题生成器。

# 任务
根据用户首轮输入生成标题。

# 输出要求
- 只返回 \`\`\`json 和 \`\`\` 包裹的内容
- 代码块内部必须是可被 JSON.parse 正常解析的标准 JSON
- JSON 结构必须是 {"title":"..."}
- title 使用中文，专业、准确、简洁
- title 不超过 12 个汉字
- 不要解释，不要回答问题，不要输出额外字段`,
        },
        {
          role: 'user',
          content: await buildMainAgentTitleUserContent({
            instruction: '请基于下面这条用户首轮输入生成标题，并且只返回 JSON。',
            content: options.userMessage,
            multimodalEnabled: false,
          }),
        },
      ],
      signal: options.signal,
      thinking: { reasoningEffort: 'low' }
    });

    const rawTitle = result.content;
    const parsedTitle = extractConversationTitleFromJson(rawTitle);

    return parsedTitle || fallbackTitle;
  } catch {
    return fallbackTitle;
  }
}
