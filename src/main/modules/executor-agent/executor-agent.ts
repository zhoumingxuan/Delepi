/**
 * 执行子智能体核心模块
 * 100%复用自参考项目 E:\ai_fr\lib\chat\executor-agent.ts
 *
 * 适配改动：
 * 1. import 路径从 @/lib/* 改为相对路径
 * 3. 工具执行模式固定为 local
 * 4. 最终输出协议保留
 * 5. 无 auth/user/login/server 代码
 */

import {
  readFile,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

import type OpenAI from 'openai';

import { nonStreamChat } from '../llm/openai-client';
import { isModelApiAbortError } from '../llm/model-retry';
import { configManager } from '../config/config-manager';
import { buildRuntimeAssistantMessage } from './runtime-assistant-message';
import { buildExecutorSystemPrompt } from './executor-system-prompt';
import {
  type TaskTag,
} from '../../constants';
import {
  parseExecutorStructuredPayload,
} from './executor-structured-payload';
import type {
  ExecutorStructuredPayload,
} from './executor-structured-payload';
import type { AssistantRuntimeConfig } from './assistant-config';
import {
  BASELINE_WORKFLOW_TEMPLATE_ID,
  EXECUTOR_WORKFLOW_TEMPLATES,
  TASK_TAG_WORKFLOW_TEMPLATE_ID,
  type ExecutorWorkflowTemplate,
} from './executor-workflow-templates';
import {
  executeToolCall,
  getExecutorOpenAITools,
} from '../../tools/executor-registry';
import {
  buildToolResult,
  stringifyToolResult,
  type ToolResult,
} from '../../tools/result';
import {
  type ToolRuntimeContext,
} from '../../tools/runtime-context';
import {
  ensureErrorMessage,
  normalizeString,
  isRecord,
} from '../../utils/index';
import {
  MAX_WORKFLOW_TEMPLATE_COUNT,
  EXECUTOR_WORKER_SKILLS_DIR,
  EXECUTOR_TOOL_PROGRESS_NAMES,
  MAX_EXECUTOR_FINAL_OUTPUT_REPAIR_ATTEMPTS,
  EXECUTOR_OUTPUT_TRUNCATE_LENGTH,
  EXECUTOR_INVALID_OUTPUT_TRUNCATE_LENGTH,
  EXECUTOR_DELIVERY_TYPE_SET,
  TASK_TAG_SET,
  DELIVERY_TYPE_IMAGE,
  DELIVERY_TYPE_FILE_LINK,
  IMAGE_FILES_FIELD_NAME,
  LOCAL_FILES_FIELD_NAME,
  FILE_URLS_FIELD_NAME,
  EXECUTOR_INVALID_TOOL_CALL_NAME,
  ERR_DELEGATED_TASK_INVALID_INPUT,
  ERR_DELEGATED_TASK_INVALID_OUTPUT,
  ERR_DELEGATED_TASK_FILE_DELIVERY_FAILED,
  ERR_ABORTED,
  type ExecutorDeliveryType
} from '../../constants';
import { IMAGE_URLS_FIELD_NAME } from '../llm/constants';
import {
  buildLocalFileUrls,
} from '../../utils/file-url';
import {
  copyFilesToOutputDir,
} from '../../utils/storage-output';
import {
  appendExecutionLogToolCall,
  attachExecutionLogPathToResult,
  completeExecutionLogToolCall,
  createExecutorExecutionLog,
  extractExecutionLogPathFromToolResultText,
  setExecutionLogStructuredOutput,
  type ExecutorExecutionLogToolCall,
} from './executor-execution-log';
/** 委派任务中携带的上传文件 */
export interface DelegatedUploadedFile {
  name: string;
  absolutePath: string;
  contentType?: string;
  size?: number;
}

type RuntimeMessage = OpenAI.Chat.ChatCompletionMessageParam;
type DelegateExecutorInput = {
  taskname?: unknown;
  tasktype?: unknown;
  tasktarget?: unknown;
  constraints?: unknown;
  deliverytype?: unknown;
  deliveryspec?: unknown;
  skills?: unknown;
  context?: unknown;
};

type ExpectedDelivery = {
  deliveryType: ExecutorDeliveryType;
  deliveryDescription: string;
};

type ParsedDelegateExecutorInput = {
  taskName: string;
  taskType: string;
  taskTarget: string;
  taskConstraints: string[];
  contextData: string;
  expectedDelivery: ExpectedDelivery;
  skillTags: TaskTag[];
};

type ParsedDelegateExecutorInputResult = {
  input: ParsedDelegateExecutorInput | null;
  issues: string[];
};

type PreviousDelegatedTask = {
  taskName: string;
  output: string;
};

type CompletedTaskInfo = {
  seq: number;
  taskName: string;
  finishedAt: string;
  summary: string;
  logPath: string;
  status: string;
};

type ExecutorRuntimeContext = Partial<ToolRuntimeContext>;

function extractAssistantReasoning(
  message: OpenAI.Chat.ChatCompletionMessage,
): string {
  const payload = message as {
    reasoning_content?: unknown;
    reasoning?: unknown;
  };
  const reasoning = payload.reasoning_content ?? payload.reasoning;

  return typeof reasoning === 'string' ? reasoning : '';
}

function normalizeTaskTags(value: unknown): TaskTag[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const tags: TaskTag[] = [];

  for (const item of value) {
    const tag = normalizeString(item);

    if (!TASK_TAG_SET.has(tag) || tags.includes(tag as TaskTag)) {
      continue;
    }

    tags.push(tag as TaskTag);
  }

  return tags;
}

function normalizeExpectedDeliveryType(value: unknown): ExecutorDeliveryType | '' {
  const text = normalizeString(value);
  const mapped =
    text === '结论' || text === '独立结论'
      ? '权威结论'
      : text === '线索' || text === '独立线索'
        ? '线索集合'
        : text;

  return EXECUTOR_DELIVERY_TYPE_SET.has(mapped)
    ? mapped as ExecutorDeliveryType
    : '';
}
function normalizeTaskTarget(value: DelegateExecutorInput): unknown {
  const tasktarget = normalizeString(value.tasktarget);

  // 兼容映射：tasktarget 缺失或为空但 target 非空时，将 target 的值映射为 tasktarget
  const mapped =
    !tasktarget && normalizeString((value as Record<string, unknown>).target)
      ? (value as Record<string, unknown>).target
      : value.tasktarget;

  return mapped;
}

function collectExpectedDelivery(value: DelegateExecutorInput): ExpectedDelivery | null {
  const deliveryType = normalizeExpectedDeliveryType(value.deliverytype);
  const deliveryDescription = normalizeString(value.deliveryspec);

  if (!deliveryType || !deliveryDescription) {
    return null;
  }

  return {
    deliveryType,
    deliveryDescription,
  };
}

function collectTaskConstraintDescriptions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeString(item))
    .filter(Boolean);
}

function collectDelegateExecutorInputIssues(parsed: DelegateExecutorInput): string[] {
  const issues: string[] = [];

  if (!normalizeString(parsed.taskname)) {
    issues.push('taskname 缺失或不是非空字符串');
  }

  if (!normalizeString(parsed.tasktype)) {
    issues.push('tasktype 缺失或不是非空字符串');
  }

  if (!normalizeString(parsed.tasktarget)) {
    issues.push('tasktarget 缺失或不是非空字符串');
  }

  if (!normalizeExpectedDeliveryType(parsed.deliverytype)) {
    issues.push('deliverytype 缺失或不在允许范围内');
  }

  if (!normalizeString(parsed.deliveryspec)) {
    issues.push('deliveryspec 缺失或不是非空字符串');
  }

  if (!normalizeString(parsed.context)) {
    issues.push('context 缺失或不是非空字符串');
  }

  if (!Array.isArray(parsed.skills)) {
    issues.push('skills 缺失或不是数组');
  }

  return issues;
}

function buildDelegateExecutorInputIssueMessage(issues: string[]): string {
  if (!issues.length) {
    return '委派任务必填字段缺失或填写错误。';
  }

  return `委派任务必填字段缺失或填写错误：${issues.join('；')}。`;
}

function parseDelegateExecutorInput(rawArguments: string): ParsedDelegateExecutorInputResult {
  const rawParsed = rawArguments
    ? (JSON.parse(rawArguments) as unknown)
    : {};

  if (!isRecord(rawParsed)) {
    return {
      input: null,
      issues: ['arguments 不是 JSON 对象'],
    };
  }

  const parsed = rawParsed as DelegateExecutorInput;

  parsed.tasktarget = normalizeTaskTarget(parsed);

  const issues = collectDelegateExecutorInputIssues(parsed);

  const taskName = normalizeString(parsed.taskname);
  const taskType = normalizeString(parsed.tasktype);
  const contextData = normalizeString(parsed.context);
  const taskTarget = normalizeString(parsed.tasktarget);
  const taskConstraints = collectTaskConstraintDescriptions(parsed.constraints);
  const expectedDelivery = collectExpectedDelivery(parsed);
  const skillTags = normalizeTaskTags(parsed.skills);

  if (issues.length || !expectedDelivery) {
    return {
      input: null,
      issues,
    };
  }

  return {
    input: {
      taskName,
      taskType,
      taskTarget,
      taskConstraints,
      expectedDelivery,
      skillTags,
      contextData,
    },
    issues: [],
  };
}

function buildExpectedDeliveryText(delivery: ExpectedDelivery): string {
  return `[${delivery.deliveryType}] ${delivery.deliveryDescription}`;
}

function buildTaskConstraintText(constraints: string[]): string {
  return constraints
    .map((constraint, index) => `${index + 1}. ${constraint}`)
    .join('\n');
}

function buildCurrentUploadedFilesText(files?: DelegatedUploadedFile[]): string {
  if (!files?.length) {
    return '';
  }

  const fileTexts = files.map((file, index) => {
    const details = [
      `${index + 1}. 文件名：${file.name}`,
      `文件绝对路径："${file.absolutePath}" `,
    ];

    if (file.contentType) {
      details.push(`文件类型："${file.contentType}"`);
    }

    if (typeof file.size === 'number') {
      details.push(`文件大小："${file.size} bytes"`);
    }

    return details.join('；');
  });

  return `
# 当前用户上传的文件清单（不含历史上传）
\`\`\`
${fileTexts.join('\n')}
\`\`\`
`.trim();
}

function buildExecutorTaskIntro(
  input: ParsedDelegateExecutorInput,
  previousTasks?: CompletedTaskInfo[],
  currentUploadedFiles?: DelegatedUploadedFile[],
  finalOutputDir?: string,
  runDir?: string,
): string {
  const previousTasksSection = previousTasks?.length
    ? `
# 已完成任务列表
${previousTasks.map((task) => `
\`\`\`
- [任务序号]：${task.seq}
- [任务名称]：${task.taskName}
- [完成时间]：${task.finishedAt}
- [执行概要]：${task.summary.length > EXECUTOR_OUTPUT_TRUNCATE_LENGTH ? task.summary.slice(0, EXECUTOR_OUTPUT_TRUNCATE_LENGTH) + '...[截断]' : task.summary}
- [日志文件路径]：
  \`${task.logPath}\`
- [任务结果]：${task.status}
\`\`\`
`).join('\n')}
`
    : '';
  const currentUploadedFilesSection = buildCurrentUploadedFilesText(currentUploadedFiles);
  const finalOutputDirSection = finalOutputDir
    ? `# 最终输出目录（**仅用于写入最终输出协议文件**）\n\`${finalOutputDir}\``
    : '';
  const runDirSection = runDir
    ? `
    # 当前会话目录
      - \`${runDir}\`
    `
    : '';

  return `
## 任务信息
\`\`\`
- [任务名称]：
  ${input.taskName}
- [任务类型]：
  ${input.taskType}
- [任务目标]:
  ${input.taskTarget}
- [任务规则和约束]：
${buildTaskConstraintText(input.taskConstraints)}
- [最终交付产物]：
${buildExpectedDeliveryText(input.expectedDelivery)}
\`\`\`
${runDirSection ? `\n${runDirSection}` : ''}
${finalOutputDirSection ? `\n${finalOutputDirSection}` : ''}
${previousTasksSection}
# 任务上下文（包含任务交接信息等内容）
\`\`\`
  ${input.contextData}
\`\`\`
${currentUploadedFilesSection ? `\n\n${currentUploadedFilesSection}` : ''}
  `.trim();
}

function buildExecutorPlainTextPrompt(options: {
  taskInput: ParsedDelegateExecutorInput;
  workflowTemplates: string[];
  previousTasks?: CompletedTaskInfo[];
  currentUploadedFiles?: DelegatedUploadedFile[];
  finalOutputDir?: string;
  runDir?: string;
}): string {
  const sections = [
    buildExecutorTaskIntro(
      options.taskInput,
      options.previousTasks,
      options.currentUploadedFiles,
      options.finalOutputDir,
      options.runDir,
    ),
  ];

  for (const workflowTemplate of options.workflowTemplates) {
    if (workflowTemplate.trim()) {
      sections.push(workflowTemplate);
    }
  }

  return sections.join('\n\n');
}

function buildOutputDirectoryText(outputDir: string | undefined): string | undefined {
  if (!outputDir) {
    return undefined;
  }

  return [
    `- 【输出目录】：${outputDir}`,
    '- 需要作为独立文件交付的文件、图片、方案、详细规划和关键材料必须写入该目录。',
    '- 如果任务要求在用户指定项目或工作区内生成、修改文件，则按任务要求写入原项目路径，不要改放到该目录。',
  ].join('\n');
}

async function removeTemporaryPaths(temporaryPaths: string[]): Promise<void> {
  await Promise.all(
    temporaryPaths.map(async (temporaryPath) => {
      if (!temporaryPath || !path.isAbsolute(temporaryPath)) {
        return;
      }

      await rm(temporaryPath, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }),
  );
}

function getFileResultFieldName(
  deliveryType: ExecutorDeliveryType,
): 'image_files' | 'local_files' | null {
  if (deliveryType === DELIVERY_TYPE_IMAGE) {
    return IMAGE_FILES_FIELD_NAME;
  }

  if (deliveryType === DELIVERY_TYPE_FILE_LINK) {
    return LOCAL_FILES_FIELD_NAME;
  }

  return null;
}

function readStringArrayResultField(
  result: Record<string, unknown>,
  fieldName: 'image_files' | 'local_files',
): string[] {
  const value = result[fieldName];

  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function buildWarningsResultData(warnings: string[]): Record<string, unknown> {
  return warnings.length > 0
    ? { warnings }
    : {};
}

function buildExecutorMetadataResultData(
  payload: ExecutorStructuredPayload,
): Record<string, unknown> {
  return {
    ...buildWarningsResultData(payload.warnings),
  };
}

function buildExecutorFailureMessage(payload: ExecutorStructuredPayload): string {
  const summary = payload.summary.trim() || '无';
  const errors = payload.errors
    .map((error) => error.trim())
    .filter(Boolean)
    .join('\n\n') || '无';

  return `
# 执行摘要
\`\`\`
${summary}
\`\`\`

# 报错信息
\`\`\`
${errors}
\`\`\`
`;
}

/**
 * 根据文件路径字段名返回对应的 FILE URL 字段名。
 * 设计依据：参考 E:\ai_fr\lib\chat\executor-agent.ts:524-531
 *   local_files → can_openfile_url
 *   image_files → image_urls
 * Delepi 改造：文件链接不复制到 output，仅基于原始本地路径生成 file:// URL。
 */
function getFileResultUrlFieldName(
  fileFieldName: 'image_files' | 'local_files',
): 'image_urls' | 'can_openfile_url' {
  return fileFieldName === IMAGE_FILES_FIELD_NAME
    ? IMAGE_URLS_FIELD_NAME
    : FILE_URLS_FIELD_NAME;
}

async function buildExecutorResultData(options: {
  payload: ExecutorStructuredPayload;
  deliveryType: ExecutorDeliveryType;
  context: ExecutorRuntimeContext;
  outputDir?: string;
}): Promise<Record<string, unknown>> {
  const fileFieldName = getFileResultFieldName(options.deliveryType);

  if (!fileFieldName) {
    return {
      result: options.payload.result,
      ...buildExecutorMetadataResultData(options.payload),
    };
  }

  const sourceFilePaths = readStringArrayResultField(
    options.payload.result ?? {},
    fileFieldName,
  );

  if (sourceFilePaths.length === 0) {
    return {
      result: options.payload.result,
      ...buildExecutorMetadataResultData(options.payload),
    };
  }

  if (fileFieldName === LOCAL_FILES_FIELD_NAME) {
    return {
      result: {
        ...options.payload.result,
        [FILE_URLS_FIELD_NAME]: buildLocalFileUrls(sourceFilePaths),
      },
      ...buildExecutorMetadataResultData(options.payload),
    };
  }

  const outputFilePaths = await copyFilesToOutputDir(sourceFilePaths, options.outputDir);
  const fileUrls = buildLocalFileUrls(outputFilePaths);
  const urlFieldName = getFileResultUrlFieldName(fileFieldName);

  return {
    result: {
      ...options.payload.result,
      [fileFieldName]: outputFilePaths,
      [urlFieldName]: fileUrls,
    },
    ...buildExecutorMetadataResultData(options.payload),
  };
}

function resolveExecutorToolProgressName(toolName: string): string {
  return EXECUTOR_TOOL_PROGRESS_NAMES[toolName] ?? toolName;
}

function buildExecutorToolProgressText(options: {
  toolName: string;
  status: 'calling' | 'completed' | 'failed';
}): string {
  const toolDisplayName = resolveExecutorToolProgressName(options.toolName);

  if (options.status === 'calling') {
    return `正在调用${toolDisplayName}工具...`;
  }

  if (options.status === 'failed') {
    return `${toolDisplayName}工具返回错误，正在调整处理方式...`;
  }

  return `${toolDisplayName}工具完成，继续处理...`;
}

function selectWorkflowTemplates(taskTags: TaskTag[]): ExecutorWorkflowTemplate[] {
  const templates: ExecutorWorkflowTemplate[] = [];

  for (const tag of taskTags) {
    const templateId = TASK_TAG_WORKFLOW_TEMPLATE_ID[tag];
    if (templateId) {
      const template = EXECUTOR_WORKFLOW_TEMPLATES[templateId];
      if (template && !templates.some((t) => t.id === template.id)) {
        templates.push(template);
      }
    }
  }

  // baseline 模板仅在无匹配模板时兜底添加
  if (templates.length === 0) {
    const baselineTemplate = EXECUTOR_WORKFLOW_TEMPLATES[BASELINE_WORKFLOW_TEMPLATE_ID];
    if (baselineTemplate) {
      templates.push(baselineTemplate);
    }
  }

  return templates.slice(0, MAX_WORKFLOW_TEMPLATE_COUNT);
}

async function readWorkflowTemplateContent(fileName: string): Promise<string> {
  const templatePath = path.join(EXECUTOR_WORKER_SKILLS_DIR, fileName);
  try {
    const content = (await readFile(templatePath, 'utf-8')).trim();
    const template = Object.values(EXECUTOR_WORKFLOW_TEMPLATES).find((t) => t.fileName === fileName);
    const title = template?.title ?? '';
    return `
##【${title}】工作方式（**若当前任务需要执行此工作方式，则必须精确符合其每一项要求**）
\`\`\`
${content}
\`\`\`
`;
  } catch {
    return '';
  }
}

async function readWorkflowTemplates(taskTags: TaskTag[]): Promise<string[]> {
  const templates = selectWorkflowTemplates(taskTags);
  const contents: string[] = [];

  for (const template of templates) {
    const content = await readWorkflowTemplateContent(template.fileName);
    if (content.trim()) {
      contents.push(content);
    }
  }

  return contents;
}

function buildExecutorFinalOutputRepairPrompt(options: {
  error: string;
  output: string;
}): string {
  return `
# 出错的值

## 错误信息
\`\`\`
${options.error}
\`\`\`

## 上一次输出内容
\`\`\`
${options.output.substring(0, EXECUTOR_OUTPUT_TRUNCATE_LENGTH)}
\`\`\`

** 请修复并给出正确的【最终输出】**
`.trim();
}

function formatInvalidExecutorOutput(
  output: string,
  error: string | null,
): string {
  const truncatedOutput = output.length > EXECUTOR_INVALID_OUTPUT_TRUNCATE_LENGTH
    ? output.substring(0, EXECUTOR_INVALID_OUTPUT_TRUNCATE_LENGTH) + '...'
    : output;

  return `
## 原始输出
\`\`\`
${truncatedOutput || '(空)'}
\`\`\`

## 解析错误
\`\`\`
${error || '未知'}
\`\`\`
`.trim();
}

type NormalizedExecutorToolCall = OpenAI.Chat.ChatCompletionMessageFunctionToolCall;

function toToolCallText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value == null) {
    return '';
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeExecutorToolCalls(rawToolCalls: unknown[]): {
  toolCalls: NormalizedExecutorToolCall[];
  prebuiltResults: Array<{ id: string; result: ToolResult }>;
} {
  const toolCalls: NormalizedExecutorToolCall[] = [];
  const prebuiltResults: Array<{ id: string; result: ToolResult }> = [];

  rawToolCalls.forEach((rawToolCall, index) => {
    const rawRecord = isRecord(rawToolCall) ? rawToolCall : {};
    const rawFunction = isRecord(rawRecord.function) ? rawRecord.function : {};
    const rawId = typeof rawRecord.id === 'string' ? rawRecord.id.trim() : '';
    let id = rawId || `invalid_tool_call_${index + 1}`;
    const rawName = typeof rawFunction.name === 'string' ? rawFunction.name.trim() : '';
    const rawArguments = rawFunction.arguments;
    const argumentsText = toToolCallText(rawArguments);
    const issues: string[] = [];

    if (!rawId) {
      issues.push('tool_call.id 缺失');
    }
    if (!rawName) {
      issues.push('function.name 缺失');
    }
    if (typeof rawArguments !== 'string') {
      issues.push('function.arguments 必须是 JSON 字符串');
    }

    const toolName = rawName || EXECUTOR_INVALID_TOOL_CALL_NAME;

    toolCalls.push({
      id,
      type: 'function',
      function: {
        name: toolName,
        arguments: argumentsText,
      },
    });

    if (issues.length > 0) {
      prebuiltResults.push({
        id,
        result: buildToolResult({
          success: false,
          code: 'TOOL_CALL_INVALID',
          message: [
            `工具调用格式无效：${issues.join('；')}。`,
            '请根据错误信息修正工具名、参数 JSON 或执行方式后重试。',
          ].join('\n'),
          data: {
            tool_call_id: id,
            tool_name: toolName,
            arguments: argumentsText,
          },
        }),
      });
    }
  });

  return { toolCalls, prebuiltResults };
}

// ============================================================
// 核心：非流式 LLM 调用（ExecutorAgent 使用）
// ============================================================

async function completeExecutorTurn(options: {
  assistantConfig: AssistantRuntimeConfig;
  messages: RuntimeMessage[];
  tools: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  signal?: AbortSignal;
}): Promise<OpenAI.Chat.ChatCompletionMessage> {
  const result = await nonStreamChat({
    modelConfig: {
      baseUrl: options.assistantConfig.executorModel.baseUrl,
      apiKey: options.assistantConfig.executorModel.apiKey,
      model: options.assistantConfig.executorModel.model,
    },
    messages: options.messages,
    tools: options.tools.length ? options.tools : undefined,
    signal: options.signal,
    // 思考档位配置化：读 AppSettings.executorThinkingLevel（默认 'max'），默认行为与原硬编码一致
    thinking: { reasoningEffort: configManager.getSettings().executorThinkingLevel }
  });

  return result.assistantMessage;
}

// ============================================================
// 核心：runDelegatedTask - 执行委派任务
// ============================================================

export type RunDelegatedTaskOptions = {
  /** Assistant 运行时配置 */
  assistantConfig: AssistantRuntimeConfig;
  /** 委派任务参数（来自 MainAgent 的 delegate_executor 工具调用） */
  rawArguments: string;
  /** 对话 ID */
  conversationId: string;
  /** 工具运行时上下文 */
  toolContext?: Partial<ToolRuntimeContext>;
  /** @deprecated 使用 previousTasks 替代 */
  previousTask?: PreviousDelegatedTask;
  /** 已完成任务列表（用于任务交接） */
  previousTasks?: CompletedTaskInfo[];
  /** 当前上传文件 */
  currentUploadedFiles?: DelegatedUploadedFile[];
  /** 最终输出目录 */
  finalOutputDir?: string;
  /** 独立交付物输出目录 */
  outputDir?: string;
  /** 执行任务ID（用于SQLite事件写入） */
  taskId?: string;
  /** 中止信号 */
  signal?: AbortSignal;
  /** 思考回调 */
  onThinking?: (text: string, info?: { type: 'thinking' | 'tool-progress'; executorCallId?: string }) => void;
  /**
   * 注意：onThinking / onToolCall / onToolResult 三回调均会触发
   * persistExecutorIntermediate（见 main-agent.ts）。
   * type 字段约定：
   *   - onThinking: 'thinking'（普通思考）或 'tool-progress'（buildExecutorToolProgressText 输出）
   *   - onToolCall: 固定 'tool-progress'（与 executor-agent.ts:920 行语义对齐）
   *   - onToolResult: 固定 'tool-progress'（与 executor-agent.ts:975 行语义对齐）
   *
   * ★ 修复 callId 语义错位：onToolCall / onToolResult 第三/第四参数为子智能体工具的
   *   真实 callId（来自 LLM 返回的 toolCall.id），不再回传主智能体 delegate_executor 的 id。
   *   用于 main-agent.ts 在 onToolCall / onToolResult 回调中 emit 'executor:tool-progress'
   *   事件时携带真实 callId，前端可据此精确路由到子智能体的具体工具调用。
   */
  /** 工具调用回调 */
  onToolCall?: (toolName: string, args: string, callId: string) => void;
  /** 工具结果回调 */
  onToolResult?: (toolName: string, success: boolean, message: string, callId: string) => void;
};

export type RunDelegatedTaskResult = ToolResult;

export async function runDelegatedTask(
  options: RunDelegatedTaskOptions,
): Promise<RunDelegatedTaskResult> {
  // 解析委派任务输入
  const parseResult = parseDelegateExecutorInput(options.rawArguments);
  const executionLog = createExecutorExecutionLog({
    conversationId: options.conversationId,
    taskId: options.taskId,
    rawArguments: options.rawArguments,
    taskInput: parseResult.input,
    inputIssues: parseResult.issues,
  });

  if (!parseResult.input) {
    const message = buildDelegateExecutorInputIssueMessage(parseResult.issues);
    const failedResult = buildToolResult({
      success: false,
      code: ERR_DELEGATED_TASK_INVALID_INPUT,
      message,
    });
    executionLog.errors.push(message);

    return attachExecutionLogPathToResult({
      result: failedResult,
      log: executionLog,
      finalOutputDir: options.finalOutputDir,
    });
  }

  const parsedInput = parseResult.input;
  const deliveryType = parsedInput.expectedDelivery.deliveryType;

  // 构建工具上下文
  const toolContext: Partial<ToolRuntimeContext> = {
    ...options.toolContext,
    conversationId: options.conversationId,
    signal: options.signal,
  };

  // 获取工具定义
  // 复用 executor-registry.getExecutorOpenAITools() 构建 OpenAI 工具声明（消除 8 行重复）
  // 视觉识别总开关关闭时仅保留 run_exe / run_with_python（声明层过滤；执行层拦截见 executor-registry.executeToolCall）
  const executorTools = getExecutorOpenAITools(
    configManager.getSettings().visionEnabled ? undefined : ['run_exe', 'run_with_python'],
  );

  // 读取工作流模板
  const workflowTemplates = await readWorkflowTemplates(parsedInput.skillTags);

  // 构建消息
  const runtimeMessages: RuntimeMessage[] = [
    {
      role: 'system',
      content: buildExecutorSystemPrompt({
        deliveryType,
        sessionDirectoryText: buildOutputDirectoryText(options.outputDir),
        currentPid: process.pid,
      }),
    },
    {
      role: 'user',
      content: buildExecutorPlainTextPrompt({
        taskInput: parsedInput,
        workflowTemplates,
        previousTasks: options.previousTasks ?? (
          options.previousTask?.taskName && options.previousTask?.output
            ? [{
                seq: 1,
                taskName: options.previousTask.taskName,
                finishedAt: new Date().toISOString(),
                summary: options.previousTask.output,
                logPath: extractExecutionLogPathFromToolResultText(options.previousTask.output),
                status: 'success',
              }]
            : undefined
        ),
        currentUploadedFiles: options.currentUploadedFiles,
        finalOutputDir: options.finalOutputDir,
        runDir: toolContext.runDir,
      }),
    },
  ];

  let finalOutput = '';
  let finalOutputParseError: string | null = null;
  let finalOutputRepairAttempts = 0;
  let structuredPayload: ExecutorStructuredPayload | null = null;
  const toolCallLogById = new Map<string, ExecutorExecutionLogToolCall>();

  // 工具调用循环
  while (true) {
    const assistantMessage = await completeExecutorTurn({
      assistantConfig: options.assistantConfig,
      messages: runtimeMessages,
      tools: executorTools,
      signal: options.signal,
    });

    const {
      toolCalls,
      prebuiltResults: invalidToolCallResults,
    } = normalizeExecutorToolCalls((assistantMessage.tool_calls ?? []) as unknown[]);
    const thinking = extractAssistantReasoning(assistantMessage).trim();
    const assistantContent =
      typeof assistantMessage.content === 'string'
        ? assistantMessage.content.trim()
        : '';
    let thinkingOutput = thinking;
    if ((assistantContent && assistantContent !== '') &&
      (!thinkingOutput || thinkingOutput === '')) {
      thinkingOutput = assistantContent;
      options.onThinking?.(thinkingOutput, { type: 'thinking' });
    } else if (thinkingOutput && toolCalls.length > 0) {
      options.onThinking?.(thinkingOutput, { type: 'thinking' });
    }

    // 无工具调用 → 解析最终输出
    if (toolCalls.length === 0) {
      finalOutput = (assistantMessage.content as string) ?? '';
      const parseResultPayload = await parseExecutorStructuredPayload({
        raw: finalOutput,
        deliveryType,
        finalOutputDir: options.finalOutputDir,
        outputDir: options.outputDir,
      });

      if (parseResultPayload.payload) {
        structuredPayload = parseResultPayload.payload;
        setExecutionLogStructuredOutput(executionLog, {
          success: structuredPayload.success,
          summary: structuredPayload.summary,
          result: structuredPayload.result,
          warnings: structuredPayload.warnings,
          errors: structuredPayload.errors,
        });
        finalOutputParseError = null;
        break;
      }

      finalOutputParseError = parseResultPayload.error ?? '最终输出无法解析。';
      executionLog.errors.push(finalOutputParseError);

      if (finalOutputRepairAttempts >= MAX_EXECUTOR_FINAL_OUTPUT_REPAIR_ATTEMPTS) {
        break;
      }

      finalOutputRepairAttempts += 1;
      runtimeMessages.push(
        buildRuntimeAssistantMessage({
          content: assistantMessage.content ?? '',
          reasoning: thinking,
        }) as RuntimeMessage,
      );
      runtimeMessages.push({
        role: 'user',
        content: buildExecutorFinalOutputRepairPrompt({
          error: finalOutputParseError,
          output: finalOutput,
        }),
      });
      continue;
    }

    // 执行工具调用
    runtimeMessages.push(
      buildRuntimeAssistantMessage({
        content: assistantMessage.content ?? '',
        reasoning: thinking,
        toolCalls,
      }) as RuntimeMessage,
    );

    const threads: Promise<{ id: string; result: ToolResult }>[] = [];
    const invalidToolCallResultById = new Map(
      invalidToolCallResults.map((item) => [item.id, item]),
    );

    for (const toolCall of toolCalls) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error(ERR_ABORTED);
      }

      options.onThinking?.(buildExecutorToolProgressText({
        toolName: toolCall.function.name,
        status: 'calling',
      }), { type: 'tool-progress' });

      options.onToolCall?.(toolCall.function.name, toolCall.function.arguments, toolCall.id);

      const logToolCall = appendExecutionLogToolCall(executionLog, {
        callId: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      });
      toolCallLogById.set(toolCall.id, logToolCall);

      const invalidToolCallResult = invalidToolCallResultById.get(toolCall.id);
      if (invalidToolCallResult) {
        threads.push(Promise.resolve(invalidToolCallResult));
        continue;
      }

      const executionThread = executeToolCall(
        toolCall.function.name,
        toolCall.function.arguments,
        toolCall.id,
        toolContext,
      );

      threads.push(executionThread);
    }

    const toolCallResults = await Promise.all(threads);

    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error(ERR_ABORTED);
    }

    for (const toolCallResult of toolCallResults) {
      const execution = toolCallResult.result;
      const toolCallId = toolCallResult.id;
      const findToolCallEntity = toolCalls.find((x) => x.id === toolCallId);
      if (!findToolCallEntity) {
        continue;
      }

      options.onThinking?.(buildExecutorToolProgressText({
        toolName: findToolCallEntity.function.name,
        status: execution.success ? 'completed' : 'failed',
      }), { type: 'tool-progress' });

      options.onToolResult?.(
        findToolCallEntity.function.name,
        execution.success,
        execution.message,
        findToolCallEntity.id,
      );

      const logToolCall = toolCallLogById.get(findToolCallEntity.id);
      completeExecutionLogToolCall(logToolCall, execution);
      if (!execution.success) {
        executionLog.errors.push(execution.message);
      }

      runtimeMessages.push({
        role: 'tool',
        tool_call_id: findToolCallEntity.id,
        content: stringifyToolResult(execution),
      });
    }
  }

  // 构建最终结果
  if (!structuredPayload) {
    const outputDetail = formatInvalidExecutorOutput(
      finalOutput,
      finalOutputParseError,
    );

    const failedResult = buildToolResult({
      success: false,
      code: ERR_DELEGATED_TASK_INVALID_OUTPUT,
      message: `执行智能体返回内容无法解析为可用执行结果。\n${outputDetail}`,
    });

    return attachExecutionLogPathToResult({
      result: failedResult,
      log: executionLog,
      finalOutputDir: options.finalOutputDir,
    });
  }

  try {
    const metadataResultData = buildExecutorMetadataResultData(structuredPayload);
    let resultData: Record<string, unknown> | undefined =
      Object.keys(metadataResultData).length > 0 ? metadataResultData : undefined;

    if (structuredPayload.success) {
      try {
        resultData = await buildExecutorResultData({
          payload: structuredPayload,
          deliveryType,
          context: toolContext as ExecutorRuntimeContext,
          outputDir: options.outputDir,
        });
      } catch (error) {
        const failedResult = buildToolResult({
          success: false,
          code: ERR_DELEGATED_TASK_FILE_DELIVERY_FAILED,
          message: ensureErrorMessage(error),
        });
        executionLog.errors.push(failedResult.message);

        return attachExecutionLogPathToResult({
          result: failedResult,
          log: executionLog,
          finalOutputDir: options.finalOutputDir,
        });
      }
    }

    const finalResult = buildToolResult({
      success: structuredPayload.success,
      code: structuredPayload.success
        ? 'DELEGATED_TASK_COMPLETED'
        : 'DELEGATED_TASK_FAILED',
      message: structuredPayload.success
        ? structuredPayload.summary
        : buildExecutorFailureMessage(structuredPayload),
      data: resultData,
    });

    return attachExecutionLogPathToResult({
      result: finalResult,
      log: executionLog,
      finalOutputDir: options.finalOutputDir,
    });
  } finally {
    await removeTemporaryPaths(structuredPayload.temporaryPaths);
  }
}
