/**
 * 工具执行耗时显示（共享）
 * 100% 抽取自 ToolCallCard.tsx 和 ChatMessageContent.tsx 的重复实现
 *
 * 包含：
 * - formatElapsedTime：将秒数格式化为 "执行了 X 时 X 分 X 秒"
 * - useElapsedSeconds：基于 startedAt/finishedAt/active 计算实时耗时（秒）
 * - ExecutionElapsedTime：组合 hook + format 的显示组件
 */

import { useEffect, useRef, useState } from 'react';
import { Typography } from 'antd';
import { SECOND_MS } from '../lib/constants';

/** 将秒数格式化为 "执行了 X 时 X 分 X 秒" */
export function formatElapsedTime(totalSeconds: number): string {
  const normalizedSeconds = Math.max(0, totalSeconds);
  const hours = Math.floor(normalizedSeconds / 3600);
  const minutes = Math.floor((normalizedSeconds % 3600) / 60);
  const seconds = normalizedSeconds % 60;

  if (hours > 0) {
    return `执行了${hours}时${minutes}分${seconds}秒`;
  }

  if (minutes > 0) {
    return `执行了${minutes}分${seconds}秒`;
  }

  return `执行了${seconds}秒`;
}

/**
 * 计算实时耗时（秒），对齐 E:\ai_fr useElapsedSeconds
 * - 工具完成后：以 finishedAt 为终点
 * - 工具进行中：以当前时间为终点，每秒更新
 */
export function useElapsedSeconds(options: {
  startedAt: string;
  finishedAt?: string;
  active: boolean;
}): number {
  const activeAnchorRef = useRef<{
    elapsedSeconds: number;
    localTimeMs: number;
    startedAt: string;
  } | null>(null);

  const getElapsedSeconds = (): number => {
    const startedAtMs = Date.parse(options.startedAt);
    const finishedAtMs = options.finishedAt
      ? Date.parse(options.finishedAt)
      : Number.NaN;

    if (Number.isNaN(startedAtMs)) {
      return 0;
    }

    if (!options.active && !Number.isNaN(finishedAtMs)) {
      return Math.floor((finishedAtMs - startedAtMs) / SECOND_MS);
    }

    const currentMs = Date.now();
    const absoluteElapsedSeconds = Math.floor(
      (currentMs - startedAtMs) / SECOND_MS,
    );

    if (!options.active) {
      return absoluteElapsedSeconds;
    }

    if (
      !activeAnchorRef.current ||
      activeAnchorRef.current.startedAt !== options.startedAt
    ) {
      activeAnchorRef.current = {
        elapsedSeconds: Math.max(0, absoluteElapsedSeconds),
        localTimeMs: currentMs,
        startedAt: options.startedAt,
      };
    }

    const anchoredElapsedSeconds =
      activeAnchorRef.current.elapsedSeconds +
      Math.floor((currentMs - activeAnchorRef.current.localTimeMs) / SECOND_MS);

    return Math.max(absoluteElapsedSeconds, anchoredElapsedSeconds);
  };

  const [elapsedSeconds, setElapsedSeconds] = useState<number>(getElapsedSeconds);

  useEffect(() => {
    setElapsedSeconds(getElapsedSeconds());

    if (!options.active) {
      return;
    }

    const timer = window.setInterval(() => {
      setElapsedSeconds(getElapsedSeconds());
    }, SECOND_MS);

    return () => {
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.active, options.finishedAt, options.startedAt]);

  return Math.max(0, elapsedSeconds);
}

/** 实时计时显示组件 */
export function ExecutionElapsedTime({
  active,
  finishedAt,
  startedAt,
}: {
  active: boolean;
  finishedAt?: string;
  startedAt: string;
}) {
  const elapsedSeconds = useElapsedSeconds({ active, finishedAt, startedAt });

  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {formatElapsedTime(elapsedSeconds)}
    </Typography.Text>
  );
}
