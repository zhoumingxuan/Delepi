/**
 * 配置管理 Hook
 * 通过 IPC config:get / config:save 持久化
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings } from '@shared/types/config';
import { DEFAULT_APP_SETTINGS } from '@shared/constants';

export function useSettings() {
  const [config, setConfig] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      if (window.electronAPI) {
        const result = await window.electronAPI.config.get();
        // 兼容新旧返回格式：新格式含 settings 字段，旧格式直接是 AppSettings
        const saved = result && typeof result === 'object' && 'settings' in result
          ? (result as unknown as { settings: AppSettings }).settings
          : result as AppSettings | null;
        if (saved) {
          setConfig({ ...DEFAULT_APP_SETTINGS, ...saved });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const configRef = useRef(config);
  configRef.current = config;

  const saveConfig = useCallback(
    async (key: keyof AppSettings, value: unknown) => {
      try {
        setError(null);
        setConfig((prev) => ({ ...prev, [key]: value }));
        if (window.electronAPI) {
          await window.electronAPI.config.save({ key, value });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存配置失败');
        // 回滚
        await loadConfig();
      }
    },
    [loadConfig],
  );

  const saveAllConfig = useCallback(
    async (updates: Partial<AppSettings>) => {
      try {
        setError(null);
        setConfig((prev) => ({ ...prev, ...updates }));
        if (window.electronAPI) {
          const savedKeys: string[] = [];
          try {
            for (const [key, value] of Object.entries(updates)) {
              await window.electronAPI.config.save({ key, value });
              savedKeys.push(key);
            }
          } catch (saveErr) {
            // 回滚已保存的键，尽力恢复DB一致性
            const oldConfig = configRef.current;
            for (const key of savedKeys) {
              try {
                await window.electronAPI.config.save({
                  key,
                  value: (oldConfig as unknown as Record<string, unknown>)[key],
                });
              } catch {
                // 回滚失败忽略，loadConfig 会恢复 UI 状态
              }
            }
            throw saveErr;
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存配置失败');
        await loadConfig();
      }
    },
    [loadConfig],
  );

  const reloadConfig = useCallback(async () => {
    try {
      if (window.electronAPI) {
        await window.electronAPI.config.reload();
      }
      await loadConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : '重载配置失败');
    }
  }, [loadConfig]);

  return {
    config,
    loading,
    error,
    saveConfig,
    saveAllConfig,
    reloadConfig,
  };
}
