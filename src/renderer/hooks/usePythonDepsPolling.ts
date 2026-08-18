import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface DepsPackageWithSize {
  name: string;
  version: string;
  size: number;
}

export interface UsePythonDepsPollingOptions {
  /** 是否激活轮询（Tab 可见时为 true） */
  active: boolean;
  /** 轮询间隔，默认 30000ms */
  interval?: number;
}

export interface UsePythonDepsPollingReturn {
  /** 包列表（含 name+version+size） */
  packages: DepsPackageWithSize[];
  /** 是否正在加载 */
  loading: boolean;
  /** 上次刷新时间 */
  lastRefreshTime: number | null;
  /** 手动刷新 */
  manualRefresh: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook 实现
// ---------------------------------------------------------------------------

export function usePythonDepsPolling(
  options: UsePythonDepsPollingOptions,
): UsePythonDepsPollingReturn {
  const { active, interval = 30000 } = options;

  const [packages, setPackages] = useState<DepsPackageWithSize[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastRefreshTime, setLastRefreshTime] = useState<number | null>(null);

  // useRef 存储定时器 ID，防止闭包陈旧
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 清除定时器
  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 获取包列表
  const fetchPackages = useCallback(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI?.deps;
    if (!api) {
      console.warn('[usePythonDepsPolling] electronAPI.deps 不可用');
      return;
    }

    try {
      const result = await api.getPackages();
      if (Array.isArray(result)) {
        setPackages(result);
      } else {
        console.warn('[usePythonDepsPolling] getPackages 返回格式异常:', result);
      }
    } catch (err) {
      console.warn('[usePythonDepsPolling] getPackages 调用失败:', err);
      // 优雅降级：保持上次数据，不清空
    }
  }, []);

  // 手动刷新：先 REFRESH 再 GET_PACKAGES
  const manualRefresh = useCallback(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI?.deps;
    if (!api) {
      console.warn('[usePythonDepsPolling] electronAPI.deps 不可用');
      return;
    }

    setLoading(true);
    try {
      // Step 1: 触发刷新（SHA256 对比+全量替换）
      await api.refresh();
      // Step 2: 获取最新包列表
      const result = await api.getPackages();
      if (Array.isArray(result)) {
        setPackages(result);
      }
      setLastRefreshTime(Date.now());
    } catch (err) {
      console.warn('[usePythonDepsPolling] manualRefresh 失败:', err);
      // 优雅降级：保持上次数据
    } finally {
      setLoading(false);
    }
  }, []);

  // 定时轮询（仅获取列表，不触发刷新）
  const startPolling = useCallback(() => {
    clearTimer();
    timerRef.current = setInterval(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).electronAPI?.deps;
      if (!api) return;

      try {
        const result = await api.getPackages();
        if (Array.isArray(result)) {
          setPackages(result);
        }
      } catch (err) {
        console.warn('[usePythonDepsPolling] 轮询 getPackages 失败:', err);
      }
    }, interval);
  }, [interval, clearTimer]);

  // 监听 active 变化
  useEffect(() => {
    if (active) {
      // active=true：立即刷新 + 启动定时器
      setLoading(true);
      (async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api = (window as any).electronAPI?.deps;
        if (!api) {
          setLoading(false);
          return;
        }

        try {
          // 先触发刷新
          await api.refresh();
          // 再获取列表
          const result = await api.getPackages();
          if (Array.isArray(result)) {
            setPackages(result);
          }
          setLastRefreshTime(Date.now());
        } catch (err) {
          console.warn('[usePythonDepsPolling] 初始加载失败:', err);
        } finally {
          setLoading(false);
        }
      })();

      // 启动定时轮询
      startPolling();
    } else {
      // active=false：清除定时器
      clearTimer();
    }

    // 组件卸载时清除定时器
    return () => {
      clearTimer();
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    packages,
    loading,
    lastRefreshTime,
    manualRefresh,
  };
}

export default usePythonDepsPolling;
