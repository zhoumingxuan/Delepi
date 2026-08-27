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

export type ExecutorToolRegistryItem = {
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
 * 动态工具表：运行时注册（S5-2 开放 register/unregister API；S5-3 dyn-tool-loader
 * 扫描 userData/dyn-tools/<tool_name>/{manifest.json,main.py} 后写入）。
 * 空表时合并视图与改造前静态派生结果逐字节等价（S5-1 等价性硬约束）。
 */
const dynamicTools = new Map<string, ExecutorToolRegistryItem>();

/**
 * 合并视图：内置 EXECUTOR_TOOLS（编译期，内容锁定）∪ 动态注册表（运行时）。
 * 内置项逐字段派生（与原静态 Object.fromEntries 派生同构）；动态项整体接管。
 * 声明（getExecutorOpenAITools）、可用名单（getDefaultEnabledExecutorToolNames）、
 * 执行查找（executeToolCall）统一从本视图派生；纯派生无副作用，每次调用重建。
 */
export function getMergedExecutorTools(): Record<string, ExecutorToolRegistryItem> {
  const merged: Record<string, ExecutorToolRegistryItem> = {};
  for (const [name, tool] of Object.entries(EXECUTOR_TOOLS)) {
    merged[name] = {
      config: {
        name: tool.config.name,
        displayName: tool.config.displayName,
        buildDescription: tool.config.buildDescription,
      },
      parameters: (tool.parameters as ToolSchema) ?? {},
      execute: tool.execute,
    };
  }
  for (const [name, item] of dynamicTools) {
    merged[name] = item;
  }
  return merged;
}

/**
 * 工具注册表（函数式派生，替代原静态导出——S5-1 方向5改造）。
 * 不维护任何本地执行函数映射；动态注册/注销后下次调用即生效，无需刷新缓存。
 */
export function getExecutorToolRegistry(): Record<string, ExecutorToolRegistryItem> {
  return getMergedExecutorTools();
}

// ============================================================
// 动态注册 API（S5-2 方向5：内置4工具锁定，重名内置拒绝注册）
// ============================================================

export type RegisterExecutorToolResult = {
  success: boolean;
  error?: string;
};

/**
 * 注册动态工具：内置∪动态合并视图即时生效（声明/名单/执行查找下次取值即含新工具）。
 * 拒绝规则：名称空/格式非法、与内置 EXECUTOR_TOOLS 重名（内置4工具锁定）、与已注册动态重名。
 */
export function registerExecutorTool(item: ExecutorToolRegistryItem): RegisterExecutorToolResult {
  const name = typeof item?.config?.name === 'string' ? item.config.name.trim() : '';
  if (!name) {
    return { success: false, error: '动态工具注册失败：config.name 为空' };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return { success: false, error: `动态工具注册失败：${name} 名称仅允许字母/数字/下划线/中划线` };
  }
  if (Boolean(EXECUTOR_TOOLS[name as keyof typeof EXECUTOR_TOOLS])) {
    return { success: false, error: `动态工具注册失败：${name} 与内置工具重名，内置工具不可被覆盖（内置4工具锁定）` };
  }
  if (dynamicTools.has(name)) {
    return { success: false, error: `动态工具注册失败：${name} 已注册（重名动态工具），请先注销` };
  }
  dynamicTools.set(name, item);
  return { success: true };
}

/** 注销动态工具；注销后合并视图即时排除。返回是否实际移除。 */
export function unregisterExecutorTool(name: string): boolean {
  return dynamicTools.delete(name);
}

/** 当前已注册动态工具名列表（按注册顺序）。 */
export function getDynamicExecutorToolNames(): string[] {
  return [...dynamicTools.keys()];
}

/**
 * 动态工具展示元数据（S5-4 进度名三级回退 manifest.progressName→displayName→name 的数据源）。
 * 内置工具返回 null（调用方回退内置 EXECUTOR_TOOL_PROGRESS_NAMES 映射，行为与现状逐字节一致）。
 */
export function getDynamicExecutorToolMeta(name: string): {
  progressName?: string;
  displayName?: string;
} | null {
  const item = dynamicTools.get(name);
  if (!item) {
    return null;
  }
  return {
    progressName: (item as { progressName?: string }).progressName,
    displayName: item.config.displayName,
  };
}

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
  return Object.values(getExecutorToolRegistry()).map((item) => item.config.name);
}

export function resolveExecutorToolNames(requestedNames?: string[]): string[] {
  if (!requestedNames?.length) {
    return getDefaultEnabledExecutorToolNames();
  }

  const registry = getExecutorToolRegistry();
  const requestedExecutorTools = requestedNames.filter(
    (name) => Boolean(registry[name]),
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
  const registry = getExecutorToolRegistry();
  return resolveExecutorToolNames(requestedNames).flatMap((toolName) => {
    const tool = registry[toolName];

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
  return Object.values(getExecutorToolRegistry())
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

  const tool = getExecutorToolRegistry()[normalizedToolName];

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
