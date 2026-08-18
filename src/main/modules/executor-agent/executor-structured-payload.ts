/**
 * 执行子智能体最终输出协议解析器
 * 100%复用自参考项目 E:\ai_fr 核心逻辑
 * 适配：import 路径
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { isRecord } from '../../utils/index';
import { copyFileToOutputDir } from '../../utils/storage-output';
import {
  JSON_CODE_BLOCK_START,
  JSON_CODE_BLOCK_END,
  KEY_MATERIAL_TRUNCATE_THRESHOLD,
  DELIVERY_TYPE_PLAN,
  DELIVERY_TYPE_PLAN_BOOK,
  DELIVERY_TYPE_REPORT,
  DELIVERY_TYPE_KEY_MATERIAL,
  type ExecutorDeliveryType,
} from '../../constants';


// ============================================================
// 类型定义
// ============================================================

export interface ExecutorStructuredPayload {
  success: boolean;
  summary: string;
  result: Record<string, unknown> | null;
  warnings: string[];
  errors: string[];
  temporaryPaths: string[];
}

// ============================================================
// 内部类型
// ============================================================

type FinalOutputPayload = {
  success: boolean;
  warnings: string[];
  errors: string[];
  summaryFilename: string;
  deliverableFilename: string;
  cleanableInfoFilename: string;
};

export type ExecutorStructuredPayloadParseResult = {
  payload: ExecutorStructuredPayload | null;
  error: string | null;
};

// ============================================================
// 工具函数
// ============================================================

function buildParseFailure(error: string): ExecutorStructuredPayloadParseResult {
  return { payload: null, error };
}

function describeValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function readStringArrayLoose(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string =>
    typeof item === 'string' && Boolean(item.trim()));
}

function normalizeErrorArray(value: unknown): {
  value: string[] | null;
  error: string | null;
} {
  if (!Array.isArray(value)) {
    return {
      value: null,
      error: `success=false 时 errors 必须是非空 string[]，当前类型为 ${describeValueType(value)}。`,
    };
  }

  const invalidIndex = value.findIndex((item) =>
    typeof item !== 'string' || !item.trim());

  if (invalidIndex !== -1) {
    return {
      value: null,
      error: `success=false 时 errors[${invalidIndex}] 必须是非空字符串。`,
    };
  }

  if (value.length === 0) {
    return {
      value: null,
      error: 'success=false 时 errors 必须是非空 string[]。',
    };
  }

  return { value, error: null };
}

function normalizeFilename(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseFinalOutputJson(raw: string): {
  value: unknown;
  error: string | null;
} {
  const normalized = raw.trim();
  const startFence = JSON_CODE_BLOCK_START;
  const endFence = JSON_CODE_BLOCK_END;

  if (!normalized) {
    return { value: null, error: '最终输出为空。' };
  }

  let scoped = normalized;
  const startFenceIndex = scoped.indexOf(startFence);

  if (startFenceIndex !== -1) {
    const afterStartFence = scoped.slice(startFenceIndex + startFence.length);
    const endFenceIndex = afterStartFence.lastIndexOf(endFence);
    scoped = endFenceIndex === -1
      ? afterStartFence
      : afterStartFence.slice(0, endFenceIndex);
  }

  const objectStart = scoped.indexOf('{');
  const objectEnd = scoped.lastIndexOf('}');

  if (objectStart === -1 || objectEnd === -1 || objectEnd <= objectStart) {
    return { value: null, error: '最终输出中未找到完整 JSON 对象。' };
  }

  const jsonText = scoped.slice(objectStart, objectEnd + 1);

  try {
    return { value: JSON.parse(jsonText) as unknown, error: null };
  } catch (error) {
    return {
      value: null,
      error: `最终 JSON 解析失败：${formatUnknownError(error)}。`,
    };
  }
}

function parseJsonText(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function readFinalOutputFile(
  finalOutputDir: string,
  filename: string,
): Promise<string> {
  return readFile(path.join(finalOutputDir, filename), 'utf8');
}

async function readFinalOutputFileIfPresent(
  finalOutputDir: string | undefined,
  filename: string,
): Promise<string | null> {
  if (!finalOutputDir || !filename) return null;
  try {
    return await readFinalOutputFile(finalOutputDir, filename);
  } catch {
    return null;
  }
}

function normalizeFinalOutputPayload(
  value: unknown,
): {
  payload: FinalOutputPayload | null;
  error: string | null;
} {
  const source = isRecord(value) ? value : {};

  if (typeof source.success !== 'boolean') {
    return {
      payload: null,
      error: `success 必须是 boolean，当前类型为 ${describeValueType(source.success)}。`,
    };
  }

  let errors: string[] = [];

  if (!source.success) {
    const normalizedErrors = normalizeErrorArray(source.errors);
    if (normalizedErrors.error) {
      return { payload: null, error: normalizedErrors.error };
    }
    errors = normalizedErrors.value ?? [];
  }

  const payload: FinalOutputPayload = {
    success: source.success,
    warnings: readStringArrayLoose(source.warnings),
    errors,
    summaryFilename: normalizeFilename(source.summary_filename),
    deliverableFilename: normalizeFilename(source.deliverable_filename),
    cleanableInfoFilename: normalizeFilename(source.cleanable_info_filename),
  };

  return { payload, error: null };
}

async function readDeliverable(
  finalOutputDir: string | undefined,
  filename: string,
  deliveryType: string,
): Promise<Record<string, unknown>> {
  const content = await readFinalOutputFileIfPresent(finalOutputDir, filename);
  if (!content) return {};

  const nameWithoutExt = path.basename(filename, path.extname(filename));

  if (
    deliveryType === DELIVERY_TYPE_PLAN
    || deliveryType === DELIVERY_TYPE_PLAN_BOOK
    || deliveryType === DELIVERY_TYPE_REPORT
    || deliveryType === DELIVERY_TYPE_KEY_MATERIAL
  ) {
    return content ? { [nameWithoutExt]: content } : {};
  }


  const parsed = parseJsonText(content);
  if (!isRecord(parsed)) return {};

  return parsed;
}

async function copyDeliverableToOutputDir(
  sourcePath: string,
  outputDir: string | undefined,
): Promise<string> {
  try {
    return await copyFileToOutputDir(sourcePath, outputDir);
  } catch {
    return sourcePath;
  }
}

function getDocumentPathFieldName(deliveryType: ExecutorDeliveryType): string | null {
  if (deliveryType === DELIVERY_TYPE_PLAN) {
    return '方案文档路径';
  }

  if (deliveryType === DELIVERY_TYPE_REPORT) {
    return '报告文档路径';
  }

  return null;
}

function shouldCopyDeliverableToOutput(deliveryType: ExecutorDeliveryType): boolean {
  return (
    deliveryType === DELIVERY_TYPE_PLAN
    || deliveryType === DELIVERY_TYPE_REPORT
    || deliveryType === DELIVERY_TYPE_KEY_MATERIAL
  );
}

function isSameAbsolutePath(value: string, expectedPath: string): boolean {
  if (!value || !expectedPath) return false;
  if (value === expectedPath) return true;
  if (!path.isAbsolute(value) || !path.isAbsolute(expectedPath)) return false;

  return path.resolve(value).toLowerCase() === path.resolve(expectedPath).toLowerCase();
}

function replaceCopiedDeliverablePath(
  value: unknown,
  sourcePath: string,
  outputPath: string,
): unknown {
  if (!sourcePath || !outputPath || sourcePath === outputPath) {
    return value;
  }

  if (typeof value === 'string') {
    return isSameAbsolutePath(value, sourcePath) ? outputPath : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceCopiedDeliverablePath(item, sourcePath, outputPath));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceCopiedDeliverablePath(item, sourcePath, outputPath),
      ]),
    );
  }

  return value;
}

function normalizeCopiedDeliverablePaths(
  result: Record<string, unknown>,
  sourcePath: string,
  outputPath: string,
): Record<string, unknown> {
  const normalized = replaceCopiedDeliverablePath(result, sourcePath, outputPath);
  return isRecord(normalized) ? normalized : result;
}

function readStringArrayField(value: unknown, fieldName: string): string[] {
  if (!isRecord(value) || !Array.isArray(value[fieldName])) return [];
  return value[fieldName].filter((item): item is string => typeof item === 'string');
}

/**
 * 解析执行子智能体最终输出为结构化协议
 */
export async function parseExecutorStructuredPayload(options: {
  raw: string;
  deliveryType: ExecutorDeliveryType;
  finalOutputDir?: string;
  outputDir?: string;
}): Promise<ExecutorStructuredPayloadParseResult> {
  try {
    const parsedJson = parseFinalOutputJson(options.raw);
    if (parsedJson.error) {
      return buildParseFailure(parsedJson.error);
    }

    const finalOutput = normalizeFinalOutputPayload(parsedJson.value);

    if (finalOutput.error || !finalOutput.payload) {
      return buildParseFailure(finalOutput.error ?? '最终 JSON 字段无法解析。');
    }

    const isStructuredData = options.deliveryType === DELIVERY_TYPE_KEY_MATERIAL;
    const documentPathFieldName = getDocumentPathFieldName(options.deliveryType);
    const deliverableAbsolutePath = finalOutput.payload.deliverableFilename && options.finalOutputDir
      ? path.join(options.finalOutputDir, finalOutput.payload.deliverableFilename)
      : '';
    const deliverableOutputPath = shouldCopyDeliverableToOutput(options.deliveryType)
      ? await copyDeliverableToOutputDir(deliverableAbsolutePath, options.outputDir)
      : deliverableAbsolutePath;

    const summary =
      await readFinalOutputFileIfPresent(
        options.finalOutputDir,
        finalOutput.payload.summaryFilename,
      ) ?? '';

    let readContent = await readDeliverable(
      options.finalOutputDir,
      finalOutput.payload.deliverableFilename,
      options.deliveryType,
    );
    readContent = normalizeCopiedDeliverablePaths(
      readContent,
      deliverableAbsolutePath,
      deliverableOutputPath,
    );

    let structuredDataFilePath = deliverableOutputPath;
    let result: Record<string, unknown> | null = null;

    if (isStructuredData) {
      const dataContent = await readFinalOutputFileIfPresent(
        options.finalOutputDir,
        finalOutput.payload.deliverableFilename,
      );
      if (dataContent && dataContent.length > KEY_MATERIAL_TRUNCATE_THRESHOLD) {
        result = {
          structured_data_file_path: structuredDataFilePath,
          first_part_content: `【必须注意以下仅为部分内容，不是完整内容】\n${dataContent.substring(0, KEY_MATERIAL_TRUNCATE_THRESHOLD)}......`,
          important_message: `当前数据内容过大，已超过${KEY_MATERIAL_TRUNCATE_THRESHOLD}个字符，输出被截断，部分内容可参考【first_part_content】；若需要看完整的【关键材料】，请用【信息整理】并且访问【structured_data_file_path】表示的文件。`,
        };
      } else if (dataContent) {
        result = readContent;
      } else {
        result = { read_error: '无法读取当前【关键材料】，可能需要重新执行' };
      }
    } else if (documentPathFieldName) {
      readContent = { ...readContent, [documentPathFieldName]: deliverableOutputPath };
      result = readContent;
    } else {
      result = readContent;
    }

    const cleanableInfo = parseJsonText(
      await readFinalOutputFileIfPresent(
        options.finalOutputDir,
        finalOutput.payload.cleanableInfoFilename,
      ) ?? '',
    );

    return {
      payload: {
        success: finalOutput.payload.success,
        summary,
        result,
        warnings: finalOutput.payload.warnings,
        errors: finalOutput.payload.errors,
        temporaryPaths: readStringArrayField(cleanableInfo, 'temporary_paths'),
      },
      error: null,
    };
  } catch (error) {
    return buildParseFailure(`解析最终输出时发生异常：${formatUnknownError(error)}。`);
  }
}
