/**
 * 自动更新状态订阅（渲染层）
 *
 * 先 getState 对齐首帧，再订阅 update:state-changed；
 * useEffect 卸载时取消订阅，避免窗口重建后重复推送。
 */

import { useEffect, useState } from 'react';
import type { UpdateStateSnapshot } from '@shared/types/update';

export function useUpdateState(): { snapshot: UpdateStateSnapshot | null; available: boolean } {
  const [snapshot, setSnapshot] = useState<UpdateStateSnapshot | null>(null);

  useEffect(() => {
    const api = window.electronAPI?.update;
    if (!api) {
      return;
    }
    let alive = true;
    void api.getState()
      .then((state) => {
        if (alive) {
          setSnapshot(state);
        }
      })
      .catch(() => undefined);
    const unsubscribe = api.onStateChanged((state) => {
      if (alive) {
        setSnapshot(state);
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  return { snapshot, available: Boolean(window.electronAPI?.update) };
}
