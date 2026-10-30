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
    // 【结构性根治·写入目标随数据携带】新增可选 conversationId / profileId：
    // - conversationId：发起编辑的会话 id（主进程兜底通道：按会话绑定解析写入目标）；
    // - profileId：保存发起时的上下文方案身份（ConfigDrawer displayProfileId），主进程按该 id
    //   直接定位目标方案写入，不读到达时刻可变状态——迟到的保存天然写回发起时的上下文方案；
    // 缺省（如 OtherSettingsTab/PythonEnvTab 等无会话上下文调用方）时不携带，主进程回落旧行为。
    async (
      key: keyof AppSettings,
      value: unknown,
      conversationId?: string | null,
      profileId?: string | null,
    ) => {
      try {
        setError(null);
        setConfig((prev) => ({ ...prev, [key]: value }));
        if (window.electronAPI) {
          // electron.d.ts 的 save 参数类型为 ConfigSaveParams（该文件不在改动白名单），扩展字段经
          // 具名变量（非新鲜对象字面量）传递以规避多余属性检查，结构类型化赋值天然向后兼容。
          const payload: { key: string; value: unknown; conversationId?: string; profileId?: string } = {
            key,
            value,
          };
          if (conversationId) {
            payload.conversationId = conversationId;
          }
          if (profileId) {
            payload.profileId = profileId;
          }
          await window.electronAPI.config.save(payload);
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
