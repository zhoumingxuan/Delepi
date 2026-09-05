/**
 * 会话批量清理（清理对话功能）主进程执行器
 * - 预览：computeConversationCleanupPreview（纯只读统计）
 * - 执行：executeConversationCleanup（幂等闸门 + 会话级事务批删 + 文件并行清理）
 * - 候选集以主进程实时重算为准（不信任前端传 id）
 */

import {
  CONVERSATION_DATE_GROUPS,
  type ConversationCleanupOptions,
  type ConversationCleanupPreview,
  type ConversationCleanupResult,
  type ConversationDateGroup,
} from '@shared/types/conversation-cleanup';
import {
  listConversations,
  listEmptyConversationIds,
  deleteConversationGuarded,
} from '../db/repositories/conversation.repo';
import { clearExecutorTaskRecords } from '../modules/executor-agent/executor-task-record-store';
import {
  removeConversationUploadDir,
  removeConversationOutputFiles,
} from './uploads';

/**
 * 会话时间分组：与渲染端 Sidebar.tsx conversationGroupByDate 完全同算法的镜像实现
 * （受控重复，避免渲染/主进程跨层 import tsx；两处算法必须保持同步，改动需双向互指）
 * 算法：本地时区零点差值 diffDays → 今天(<=0)/昨天(==1)/7天前(<=7)/30天前(<=30)/更早
 */
export function groupConversationDate(iso: string): ConversationDateGroup {
  const input = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfInput = new Date(input.getFullYear(), input.getMonth(), input.getDate());
  const diffDays = Math.floor(
    (startOfToday.getTime() - startOfInput.getTime()) / (24 * 60 * 60 * 1000),
  );

  if (diffDays <= 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays <= 7) return '7天前';
  if (diffDays <= 30) return '30天前';
  return '更早';
}

/** 清理条件校验：removeEmpty 须为 boolean；dateGroups 须为数组且取值域限于 CONVERSATION_DATE_GROUPS */
function validateOptions(params: ConversationCleanupOptions): void {
  if (
    !params ||
    typeof params.removeEmpty !== 'boolean' ||
    !Array.isArray(params.dateGroups) ||
    params.dateGroups.some(
      (group) => !(CONVERSATION_DATE_GROUPS as readonly string[]).includes(group),
    )
  ) {
    throw new Error('清理参数无效');
  }
}

/** 构造候选集：全量会话 + 空会话集合 + 各时间组集合（分组键 updatedAt||createdAt，与 Sidebar 分组键一致） */
function buildCandidateSets() {
  const conversations = listConversations();
  const emptyIds = listEmptyConversationIds();
  const groupSets = new Map<string, Set<string>>();
  const dateGroupCounts: Record<string, number> = {};
  for (const group of CONVERSATION_DATE_GROUPS) {
    dateGroupCounts[group] = 0;
  }
  for (const conversation of conversations) {
    const group = groupConversationDate(conversation.updatedAt || conversation.createdAt);
    dateGroupCounts[group] = (dateGroupCounts[group] ?? 0) + 1;
    let set = groupSets.get(group);
    if (!set) {
      set = new Set<string>();
      groupSets.set(group, set);
    }
    set.add(conversation.id);
  }
  return { conversations, emptyIds, groupSets, dateGroupCounts };
}

/** 按条件取命中集（removeEmpty 空会话 ∪ 勾选时间组，Set 去重） */
function computeMatchedIds(
  params: ConversationCleanupOptions,
  emptyIds: string[],
  groupSets: Map<string, Set<string>>,
): string[] {
  const matched = new Set<string>();
  if (params.removeEmpty) {
    for (const id of emptyIds) {
      matched.add(id);
    }
  }
  for (const group of params.dateGroups) {
    const set = groupSets.get(group);
    if (set) {
      for (const id of set) {
        matched.add(id);
      }
    }
  }
  return Array.from(matched);
}

/** 预览统计（conv:cleanup-preview）：纯只读，不删任何数据、无闸门 */
export function computeConversationCleanupPreview(
  params: ConversationCleanupOptions,
): ConversationCleanupPreview {
  validateOptions(params);
  const { conversations, emptyIds, groupSets, dateGroupCounts } = buildCandidateSets();
  const matchedIds = computeMatchedIds(params, emptyIds, groupSets);
  const matchedSet = new Set(matchedIds);
  const runningCount = conversations.filter(
    (conversation) => matchedSet.has(conversation.id) && conversation.isRunning,
  ).length;
  return {
    total: conversations.length,
    emptyCount: emptyIds.length,
    dateGroupCounts,
    matched: matchedIds.length,
    runningCount,
    deletableCount: matchedIds.length - runningCount,
  };
}

/** 幂等闸门：同一时刻仅允许一个清理任务（覆盖渲染端 confirmLoading 之外的双实例/重入场景） */
let cleanupInProgress = false;

/**
 * 执行清理（conv:cleanup）：
 * - 实时重算候选集（不信任前端传参；覆盖"预览→执行"间隙的增删/新消息竞态）
 * - 命中中 is_running 会话跳过（skippedRunningIds）
 * - 逐会话 deleteConversationGuarded 会话级事务批删；单会话失败记入 failedItems 继续其余
 * - 删除成功后：clearExecutorTaskRecords + onDeleted 回调（宿主注入 lastActive 置空）+ 并行文件清理
 * - 文件清理失败仅记入 fileCleanupFailures（不判失败；file:cleanup-orphans 兜底）
 */
export async function executeConversationCleanup(
  params: ConversationCleanupOptions,
  onDeleted: (id: string) => void,
): Promise<ConversationCleanupResult> {
  if (cleanupInProgress) {
    throw new Error('已有清理任务正在执行，请稍后再试');
  }
  cleanupInProgress = true;
  try {
    validateOptions(params);
    const { conversations, emptyIds, groupSets } = buildCandidateSets();
    const matchedIds = computeMatchedIds(params, emptyIds, groupSets);
    const matchedSet = new Set(matchedIds);
    const deletableIds: string[] = [];
    const skippedRunningIds: string[] = [];
    for (const conversation of conversations) {
      if (!matchedSet.has(conversation.id)) {
        continue;
      }
      if (conversation.isRunning) {
        skippedRunningIds.push(conversation.id);
      } else {
        deletableIds.push(conversation.id);
      }
    }

    const deletedIds: string[] = [];
    const failedItems: Array<{ id: string; reason: string }> = [];
    for (const id of deletableIds) {
      try {
        const outcome = deleteConversationGuarded(id);
        if (outcome === 'deleted' || outcome === 'missing') {
          // missing：幂等语义，视为删除成功
          deletedIds.push(id);
        } else {
          // 事务内复查发现已进入运行态：跳过
          skippedRunningIds.push(id);
        }
      } catch (err) {
        failedItems.push({ id, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    const fileCleanupFailures: string[] = [];
    for (const id of deletedIds) {
      try {
        clearExecutorTaskRecords(id);
      } catch {
        // executor 记录清理失败不阻断主流程（函数本身幂等）
      }
      onDeleted(id);
      const fileResults = await Promise.allSettled([
        removeConversationUploadDir(id),
        removeConversationOutputFiles(id),
      ]);
      if (fileResults.some((result) => result.status === 'rejected')) {
        fileCleanupFailures.push(id);
      }
    }

    return {
      matchedCount: matchedIds.length,
      deletedCount: deletedIds.length,
      deletedIds,
      skippedRunningIds,
      failedItems,
      fileCleanupFailures,
    };
  } finally {
    cleanupInProgress = false;
  }
}
