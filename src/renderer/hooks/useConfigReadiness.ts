/**
 * useConfigReadiness — 配置就绪检查 Hook
 *
 * 功能：
 * - 接收 config / configLoading
 * - 返回 canCheck（configLoading 时为 false）和 check() 函数
 * - check() 依次检查：
 *   1. 大模型配置 3 项：baseUrl / apiKey / modelName 均非空
 *   2. Python 环境：customPythonPath 非空（自定义模式）
 * - 返回 ConfigReadinessResult { isReady, missingItems }
 */

import { useCallback, useMemo } from 'react';
import type { AppSettings, ConfigMissingItem, ConfigReadinessResult } from '@shared/types/config';

// ---------------------------------------------------------------------------
// Hook 参数
// ---------------------------------------------------------------------------

export interface UseConfigReadinessParams {
  config: AppSettings | null;
  configLoading: boolean;
}

// ---------------------------------------------------------------------------
// Hook 实现
// ---------------------------------------------------------------------------

export function useConfigReadiness({
  config,
  configLoading,
}: UseConfigReadinessParams) {
  /** 加载中不可检查，避免使用未就绪的配置数据 */
  const canCheck = true;

  const check = useCallback((): ConfigReadinessResult => {
    const missingItems: ConfigMissingItem[] = [];

    // --- 1. 大模型配置检查（3 项非空） ---
    if (config) {
      const baseUrl = (config.mainModelBaseUrl ?? '').trim();
      const apiKey = (config.mainModelApiKey ?? '').trim();
      const modelName = (config.mainModelName ?? '').trim();

      if (!baseUrl || !apiKey || !modelName) {
        const detail: string[] = [];
        if (!baseUrl) detail.push('API 地址（Base URL）未填写');
        if (!apiKey) detail.push('API Key 未填写');
        if (!modelName) detail.push('模型名称未填写');

        missingItems.push({
          type: 'llm_config',
          label: '大模型配置',
          targetTab: 'model',
          detail,
        });
      }
    } else {
      // config 为 null 时，视为全部缺失
      missingItems.push({
        type: 'llm_config',
        label: '大模型配置',
        targetTab: 'model',
        detail: ['API 地址（Base URL）未填写', 'API Key 未填写', '模型名称未填写'],
      });
    }

    // --- 2. Python 环境检查 ---
    const useBuiltin = config?.useBuiltinPython ?? true;

    if (!useBuiltin) {
      // 自定义模式：检查 customPythonPath 是否非空
      if (!config?.customPythonPath?.trim()) {
        missingItems.push({
          type: 'python_config',
          label: 'Python 环境',
          targetTab: 'python',
          detail: ['自定义 Python 路径未设置，请选择或输入 Python 解释器路径'],
        });
      }
    }

    return {
      isReady: missingItems.length === 0,
      missingItems,
    };
  }, [config]);

  return { check, canCheck };
}
