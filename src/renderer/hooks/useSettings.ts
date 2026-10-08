/** Configuration writes are serialized and committed atomically by main. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings } from '@shared/types/config';
import { DEFAULT_APP_SETTINGS } from '@shared/constants';

export function useSettings() {
  const [config, setConfig] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const revisionRef = useRef<number | undefined>(undefined);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const loadGeneration = useRef(0), sequence = useRef(0);
  const confirmedConfig = useRef<AppSettings>({ ...DEFAULT_APP_SETTINGS });
  const pendingPatches = useRef(new Map<number, Partial<AppSettings>>());
  const publishConfig = useCallback(() => {
    const next = { ...confirmedConfig.current };
    for (const patch of pendingPatches.current.values()) Object.assign(next, patch);
    setConfig(next);
  }, []);
  const loadConfig = useCallback(async () => {
    const ownGeneration = ++loadGeneration.current;
    try {
      setLoading(true); setError(null);
      if (window.electronAPI) {
        const result = await window.electronAPI.config.get();
        if (loadGeneration.current !== ownGeneration) return;
        if (result.revision !== undefined && revisionRef.current !== undefined && result.revision < revisionRef.current) return;
        confirmedConfig.current = { ...DEFAULT_APP_SETTINGS, ...result.settings };
        revisionRef.current = result.revision;
        publishConfig();
      }
    } catch (err) { if (loadGeneration.current === ownGeneration) setError(err instanceof Error ? err.message : '加载配置失败'); }
    finally { if (loadGeneration.current === ownGeneration) setLoading(false); }
  }, [publishConfig]);
  useEffect(() => { queueRef.current = loadConfig(); return () => { loadGeneration.current++; }; }, [loadConfig]);
  const savePatch = useCallback((patch: Partial<AppSettings>, singleKey?: keyof AppSettings) => {
    const submission = ++sequence.current;
    pendingPatches.current.set(submission, patch); publishConfig();
    const pending = queueRef.current.then(async () => {
      loadGeneration.current++; setLoading(false);
      try {
        setError(null);
        if (window.electronAPI) {
          const result = singleKey
            ? await window.electronAPI.config.save({ key: singleKey, value: patch[singleKey], expectedRevision: revisionRef.current })
            : await window.electronAPI.config.saveBatch({ patch, expectedRevision: revisionRef.current });
          revisionRef.current = result.revision;
        }
        confirmedConfig.current = { ...confirmedConfig.current, ...patch };
        pendingPatches.current.delete(submission); publishConfig();
      } catch (err) {
        pendingPatches.current.delete(submission); publishConfig();
        await loadConfig();
        setError(err instanceof Error ? err.message : '保存配置失败');
        throw err;
      }
    });
    queueRef.current = pending.then(() => undefined, () => undefined);
    return pending;
  }, [loadConfig, publishConfig]);
  const saveConfig = useCallback((key: keyof AppSettings, value: unknown) => savePatch({ [key]: value } as Partial<AppSettings>, key), [savePatch]);
  const saveAllConfig = useCallback((updates: Partial<AppSettings>) => savePatch(updates), [savePatch]);
  const reloadConfig = useCallback(() => {
    const pending = queueRef.current.then(async () => {
      try { if (window.electronAPI) await window.electronAPI.config.reload(); await loadConfig(); }
      catch (err) { setError(err instanceof Error ? err.message : '重载配置失败'); }
    });
    queueRef.current = pending;
    return pending;
  }, [loadConfig]);
  return { config, loading, error, saveConfig, saveAllConfig, reloadConfig };
}
