/**
 * 思考类 IPC 事件渲染端合帧器（P02 保守档）
 *
 * 机制：分桶缓冲（桶 key = conversationId + 通道名）→ rAF 合帧窗口 → flush 时每桶 last-wins 应用
 *
 * 安全边界：
 *  - 仅「携带幂等全量字段」的事件允许入桶合并（last-wins 无损终态——M13/M14 后主进程
 *    每事件均携带全量幂等字段：chat:thinking 的 segments/thinking、executor:thinking 的 accumulated）；
 *  - 纯增量兜底事件（无全量字段）立即同步透传，绝不缓冲（防丢增量、顺序保持）；
 *  - flush 在 rAF 回调执行，React 18+ 自动批处理使多桶 apply 合并为一次 render；
 *  - dispose 取消挂起 rAF 并清空桶（useChat 订阅 useEffect cleanup 调用）；
 *  - rAF 在窗口隐藏时暂停——后台会话本就不投影（M02），重新可见后恢复 flush，桶内事件无丢失。
 *
 * 插入位置：useChat 订阅回调与 applyConversationEvent 路由器之间——路由器仍是唯一状态入口，
 * 本模块只改变「到达路由器的事件时机」（帧内合并），不改变写入值与路由器语义。
 */
export interface ThinkingEventMerger<T> {
  push(event: T): void;   // 订阅回调唯一入口
  dispose(): void;        // 卸载清理
}

export function createThinkingEventMerger<T>(
  bucketKeyOf: (e: T) => string,          // 如 `${conversationId}|chat-thinking`
  isMergeable: (e: T) => boolean,          // 幂等全量事件判定（判定条件与消费端全量分支优先级一致）
  apply: (e: T) => void,                   // 实际处理（订阅回调体逐字搬入：校验+applyConversationEvent 块）
): ThinkingEventMerger<T> {
  const buckets = new Map<string, T>();
  let rafId: number | null = null;
  const flush = () => {
    rafId = null;
    const events = [...buckets.values()];
    buckets.clear();
    events.forEach(apply);                  // 每桶最新一条；多会话互不阻塞（M02 隔离保持）
  };
  return {
    push(e) {
      if (!isMergeable(e)) {
        apply(e);                           // 纯增量事件：同步透传，顺序保持
        return;
      }
      buckets.set(bucketKeyOf(e), e);       // last-wins
      if (rafId === null) {
        rafId = requestAnimationFrame(flush);  // 合帧窗口 = 1 rAF（~16.7ms@60Hz）
      }
    },
    dispose() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      buckets.clear();
    },
  };
}
