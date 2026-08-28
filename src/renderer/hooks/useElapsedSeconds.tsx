/**
 * 工具执行耗时显示（共享）
 * 100% 抽取自 ToolCallCard.tsx 和 ChatMessageContent.tsx 的重复实现
 *
 * 包含：
 * - formatElapsedTime：将秒数格式化为 "执行了 X 时 X 分 X 秒"
 * - useElapsedSeconds：基于 startedAt/finishedAt/active 计算实时耗时（秒）
 * - ExecutionElapsedTime：组合 hook + format 的显示组件
 */

import { useMemo, useRef, useSyncExternalStore } from 'react';
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

// ============================================================
// ★ P1 模块级共享 ticker（单定时器，引用计数生命周期）：
//   N 个 loading 态工具卡从 N 个每秒 setInterval 合并为 1 个共享 ticker，
//   每秒同步广播一次（React 18+ 自动批处理为单次 render pass）；
//   全部订阅者退订后自动停表（空闲期零开销）。
// ============================================================
let tickerSecond = 0;                       // 秒计数（getSnapshot 幂等源：同秒内恒等返回）
const tickListeners = new Set<() => void>();
let tickerTimer: number | null = null;

function ensureTicker(): void {
  if (tickerTimer === null) {
    tickerTimer = window.setInterval(() => {
      tickerSecond += 1;
      tickListeners.forEach((listener) => listener());   // 同步通知 → React 18+ 自动批处理为单次 render pass
    }, SECOND_MS);
  }
}
function releaseTickerIfIdle(): void {
  if (tickListeners.size === 0 && tickerTimer !== null) {
    window.clearInterval(tickerTimer);
    tickerTimer = null;
  }
}
function subscribeTick(listener: () => void): () => void {
  tickListeners.add(listener);
  ensureTicker();
  return () => {
    tickListeners.delete(listener);
    releaseTickerIfIdle();
  };
}
function getTickSecond(): number {
  return tickerSecond;                      // 幂等：两次 tick 之间恒等（useSyncExternalStore 安全）
}
const subscribeNoop = (): (() => void) => (() => undefined);  // 非 active 卡：不持 ticker 引用
const getZero = (): number => 0;                                  // 非 active 卡：常量快照，永不触发重渲染


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

  // ★ P1：active 卡订阅共享 ticker；非 active 卡订阅 noop+常量快照（不重渲染、不占 ticker）
  const tick = useSyncExternalStore(
    options.active ? subscribeTick : subscribeNoop,
    options.active ? getTickSecond : getZero,
  );

  // ★ 非 active 分支必须 useMemo 冻结：现状语义是 clearInterval 后 elapsedSeconds 冻结在最后值
  //   （父级重渲染不改变显示）；若每次渲染重算 Date.now() 会造成异常态卡（active=false 且无
  //   finishedAt）的读数随父级渲染漂移——行为不等价，故记忆化。
  const inactiveSeconds = useMemo(() => {
    const startedAtMs = Date.parse(options.startedAt);
    const finishedAtMs = options.finishedAt ? Date.parse(options.finishedAt) : Number.NaN;
    if (Number.isNaN(startedAtMs)) return 0;
    if (!Number.isNaN(finishedAtMs)) return Math.max(0, Math.floor((finishedAtMs - startedAtMs) / SECOND_MS));
    return Math.max(0, Math.floor((Date.now() - startedAtMs) / SECOND_MS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.startedAt, options.finishedAt]);

  // tick 每秒 +1 触发重渲染并重算（等价原 setInterval 每秒 setElapsedSeconds(getElapsedSeconds())）；
  // 非 active 时 tick 恒 0 → 不触发重渲染 → 显示冻结值（≡ 现状 clearInterval 冻结语义）
  void tick;
  const current = options.active ? getElapsedSeconds() : inactiveSeconds;
  return Math.max(0, current);
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
