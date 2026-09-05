/**
 * 清理对话（会话批量清理）共享类型
 * 渲染进程 / 主进程共享的唯一事实源
 */

/** 会话时间分组名（与 Sidebar.tsx GROUP_PRIORITY 五值逐字一致；主进程 groupConversationDate 镜像同一组名） */
export const CONVERSATION_DATE_GROUPS = ['今天', '昨天', '7天前', '30天前', '更早'] as const;

export type ConversationDateGroup = (typeof CONVERSATION_DATE_GROUPS)[number];

/** 清理条件（传条件不传 id 列表：预览与执行以主进程实时口径为准） */
export interface ConversationCleanupOptions {
  /** M1：清理空会话（0 条消息） */
  removeEmpty: boolean;
  /** M2：命中的时间组名，取值域=CONVERSATION_DATE_GROUPS；可为空数组 */
  dateGroups: string[];
}

/** 预览统计（conv:cleanup-preview 返回） */
export interface ConversationCleanupPreview {
  /** 会话总数 */
  total: number;
  /** 空会话总数（全量口径，供 checkbox 计数） */
  emptyCount: number;
  /** 五组全量计数（键=组名） */
  dateGroupCounts: Record<string, number>;
  /** 当前条件下命中数（并集去重，含运行中） */
  matched: number;
  /** 命中中 is_running=true 将被跳过的数量 */
  runningCount: number;
  /** matched - runningCount */
  deletableCount: number;
}

/** 执行结果（conv:cleanup 返回） */
export interface ConversationCleanupResult {
  /** 本次条件命中数 */
  matchedCount: number;
  /** 实际删除数 */
  deletedCount: number;
  deletedIds: string[];
  /** 跳过的运行中会话 */
  skippedRunningIds: string[];
  /** SQLite 层失败明细 */
  failedItems: Array<{ id: string; reason: string }>;
  /** 文件清理失败 id（不影响成功判定，file:cleanup-orphans 兜底） */
  fileCleanupFailures: string[];
}
