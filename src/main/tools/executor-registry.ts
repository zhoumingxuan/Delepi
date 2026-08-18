import {
  buildSimpleToolResult,
  type ToolResult,
} from './result';
import {
  type ToolRuntimeContext,
} from './runtime-context';
import { ensureErrorMessage } from '../utils/index';
import { EXECUTOR_TOOLS } from '../modules/executor-agent/prompt';
import { configManager } from '../modules/config/config-manager';

type ToolSchema = Record<string, unknown>;

type ExecutorToolRegistryItem = {
  config: {
    name: string;
    displayName?: string;
    buildDescription: string;
  };
  parameters: ToolSchema;
  execute: (
    input: unknown,
    context: ToolRuntimeContext,
  ) => Promise<ToolResult> | ToolResult;
};

/**
 * 工具注册表：直接基于 EXECUTOR_TOOLS 派生
 * 不维护任何本地执行函数映射
 */
export const executorToolRegistry: Record<string, ExecutorToolRegistryItem> =
  Object.fromEntries(
    Object.entries(EXECUTOR_TOOLS).map(([name, tool]) => [
      name,
      {
        config: {
          name: tool.config.name,
          displayName: tool.config.displayName,
          buildDescription: tool.config.buildDescription,
        },
        parameters: (tool.parameters as ToolSchema) ?? {},
        execute: tool.execute,
      },
    ]),
  );

function parseToolArguments(rawArguments: string): Record<string, unknown> {
  let parsedArguments: unknown;

  try {
    parsedArguments = rawArguments ? JSON.parse(rawArguments) : {};
  } catch (error) {
    throw new Error(`工具参数不是合法 JSON：${ensureErrorMessage(error)}`);
  }

  if (!parsedArguments || typeof parsedArguments !== 'object' || Array.isArray(parsedArguments)) {
    throw new Error('工具参数必须是 JSON 对象');
  }

  const nextArguments = { ...parsedArguments } as Record<string, unknown>;
  delete nextArguments.context;
  return nextArguments;
}

export function getDefaultEnabledExecutorToolNames(): string[] {
  return Object.values(executorToolRegistry).map((item) => item.config.name);
}

export function resolveExecutorToolNames(requestedNames?: string[]): string[] {
  if (!requestedNames?.length) {
    return getDefaultEnabledExecutorToolNames();
  }

  const requestedExecutorTools = requestedNames.filter(
    (name) => Boolean(executorToolRegistry[name]),
  );

  if (requestedExecutorTools.length) {
    return requestedExecutorTools;
  }

  return [];
}

export function getExecutorOpenAITools(requestedNames?: string[]): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolSchema;
  };
}> {
  return resolveExecutorToolNames(requestedNames).flatMap((toolName) => {
    const tool = executorToolRegistry[toolName];

    if (!tool) {
      return [];
    }

    return [{
      type: 'function' as const,
      function: {
        name: tool.config.name,
        description: tool.config.buildDescription,
        parameters: tool.parameters,
      },
    }];
  });
}

function getAvailableExecutorToolNamesText(): string {
  return Object.values(executorToolRegistry)
    .map((item) => item.config.name)
    .join(', ');
}

export async function executeToolCall(
  toolName: string,
  rawArguments: string,
  toolCallId: string,
  context?: Partial<ToolRuntimeContext>,
): Promise<{ id: string; result: ToolResult }> {
  const normalizedToolName = toolName.trim();
  const availableToolNames = getAvailableExecutorToolNamesText();

  if (!normalizedToolName) {
    return buildSimpleToolResult({
      success: false,
      code: 'TOOL_NAME_EMPTY',
      message: `工具名称为空。必须选择一个可用工具调用。可用工具：${availableToolNames}`,
    }, toolCallId);
  }

  const tool = executorToolRegistry[normalizedToolName];

  if (!tool) {
    return buildSimpleToolResult({
      success: false,
      code: 'TOOL_NOT_FOUND',
      message: `未找到工具 ${normalizedToolName}。可用工具：${availableToolNames}`,
    }, toolCallId);
  }

  // 视觉识别总开关关闭时拒绝执行 inspect_image（执行层拦截；声明层过滤见 executor-agent.ts runDelegatedTask）
  if (normalizedToolName === 'inspect_image' && !configManager.getSettings().visionEnabled) {
    return buildSimpleToolResult({
      success: false,
      code: 'TOOL_DISABLED_VISION_OFF',
      message: `视觉识别已关闭，${normalizedToolName} 工具不可用。请在设置中开启视觉识别后重试。`,
    }, toolCallId);
  }

  let parsedArguments: Record<string, unknown>;

  try {
    parsedArguments = parseToolArguments(rawArguments);
  } catch (error) {
    return buildSimpleToolResult({
      success: false,
      code: 'TOOL_ARGUMENTS_INVALID',
      message: `工具 ${normalizedToolName} 参数无效：${ensureErrorMessage(error)}\n请根据错误信息修正工具参数 JSON 后重试。`,
    }, toolCallId);
  }

  try {
    const result = await tool.execute(
      parsedArguments,
      (context ?? {}) as ToolRuntimeContext,
    );
    return {
      id: toolCallId,
      result,
    };
  } catch (error) {
    const errorMessage = ensureErrorMessage(error);

    return buildSimpleToolResult({
      success: false,
      code: 'TOOL_EXECUTION_EXCEPTION',
      message: `工具 ${normalizedToolName} 执行异常：${errorMessage}\n请根据异常信息修正工具参数或执行方式后重试。`,
    }, toolCallId);
  }
}
