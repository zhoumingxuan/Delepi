/**
 * IPC 通信相关类型定义
 */

import type { ChatAttachment } from '@shared/types/chat';

/** IPC 消息信封 */
export interface IpcEnvelope<T = unknown> {
  type: string;
  timestamp: string;
  payload: T;
}

/** 聊天发送参数 */
export interface ChatSendParams {
  conversationId: string;
  message: string;
  assistantMessageId?: string;
  files?: ChatSendFileInput[];
}

/** 聊天发送携带的本地上传文件：必须先通过 file:upload 落盘。 */
export interface ChatSendFileInput {
  name: string;
  size: number;
  contentType?: string;
  /** 上传后返回的存储 key */
  storageKey: string;
  /** 与 file:upload 返回的 id 对齐，便于前端关联 */
  id?: string;
}

export type ChatUploadedFile = ChatAttachment;

/** 聊天发送结果 */
export interface ChatSendResult {
  messageId: string;
  conversationId: string;
}

/** 对话列表项 */
export interface ConversationListItem {
  id: string;
  title: string;
  isRunning: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 配置保存参数 */
export interface ConfigSaveParams {
  key: string;
  value: unknown;
}

// ============================================================
// P5 文件上传独立 IPC 通道参数/返回类型
// 对齐 E:\ai_fr app/api/uploads/route.ts 三件套（去除鉴权层）
// ============================================================

/**
 * file:upload 参数
 * - conversationId: 目标对话 ID
 * - name: 原始文件名（必填）
 * - size: 文件字节数（必填，仅作为元数据返回）
 * - contentType: MIME 类型（可选，缺省 application/octet-stream）
 * - data: 文件二进制内容。H1 防御：优先 Base64 字符串（string，IPC 结构化克隆纯字符串，
 *   规避 ArrayBuffer 序列化断点）；主进程同时兼容 ArrayBuffer / Uint8Array / number[]（向后兼容）
 */
export interface FileUploadParams {
  conversationId: string;
  name: string;
  size: number;
  contentType?: string;
  data: string | ArrayBuffer | Uint8Array | number[];
}

/** file:upload 返回：单个上传后的 ChatUploadedFile */
export interface FileUploadResult {
  file: ChatUploadedFile;
}

/**
 * file:list 参数
 * - conversationId: 目标对话 ID
 */
export interface FileListParams {
  conversationId: string;
}

/** file:list 返回：当前会话 uploads/ 目录下的全部已上传文件 */
export interface FileListResult {
  files: ChatUploadedFile[];
}

/**
 * file:delete 参数
 * - conversationId: 目标对话 ID（用于校验 storageKey 前缀）
 * - storageKey: 待删除文件的存储 key
 */
export interface FileDeleteParams {
  conversationId: string;
  storageKey: string;
}

/** file:delete 返回：成功标记 */
export interface FileDeleteResult {
  success: boolean;
}

/**
 * file:read 参数（P7 切换会话恢复待发送文件）
 * - conversationId: 目标对话 ID（用于校验 storageKey 前缀）
 * - storageKey: 待读取文件的存储 key
 */
export interface FileReadParams {
  conversationId: string;
  storageKey: string;
}

/**
 * file:read 返回：已上传文件的二进制内容 + 元数据
 * - data: ArrayBuffer（IPC 序列化兼容,前端用 URL.createObjectURL(new Blob([data])) 重建预览）
 * - contentType: 文件 MIME 类型（用于 Blob type 字段,★ Phase 3 P3-3 后端基于扩展名/magic 推断）
 * - name: 原始文件名（用于 Blob name 字段,非必填但保留）
 * - size: 文件字节数（用于 Blob size 字段,与读取后大小一致）
 */
export interface FileReadResult {
  /**
   * 文件二进制内容（IPC 序列化 ArrayBuffer）
   * 前端用 URL.createObjectURL(new Blob([data], { type: contentType })) 重建预览
   */
  data: ArrayBuffer;
  /**
   * ★ Phase 3 P3-3 文件 MIME 类型（后端基于扩展名或 magic number 推断）
   * 前端直接使用 readResult.contentType 作为 Blob type,不再依赖 file:list 的二次关联
   */
  contentType: string;
  /**
   * 上传时的展示文件名（来自 metadata，不等同于磁盘存储文件名）
   */
  name: string;
  /**
   * 文件字节数（与读取后大小一致）
   * 前端可用作 File.size 字段
   */
  size: number;
}

// ============================================================
// P9 孤儿清理 IPC 通道参数/返回类型
// ============================================================

/**
 * file:cleanup-orphans 参数
 * - 空对象:Delepi 单用户无鉴权,无需任何参数
 */
export interface FileCleanupOrphansParams {
  // reserved for future options (e.g. dryRun)
}

/**
 * file:cleanup-orphans 返回
 * - removedConversationIds: 实际删除的会话 ID 列表
 * - scannedCount: 扫描的 bin/conversations/ 子目录总数
 * - removedCount: 删除数量（= removedConversationIds.length）
 */
export interface FileCleanupOrphansResult {
  removedConversationIds: string[];
  scannedCount: number;
  removedCount: number;
}

// ============================================================
// 执行子智能体任务记录增量查询（新版方案 §5.2-B2）
// ============================================================

/**
 * executor:get-task-record 请求参数（渲染→主，invoke）
 * 返回类型 ExecutorTaskRecordQueryResult 定义于 @shared/types/executor-record
 * （跨进程以结构化 JSON 传输，主进程 store 与渲染进程 hook 共同 import）
 */
export interface ExecutorTaskRecordQueryParams {
  conversationId: string;
  /** 委派工具调用 id（= 主智能体 delegate_executor toolCall.id，前端寻址主键） */
  delegateCallId: string;
  /** 增量基准（缺省/0 = 全量）；服务端 latestSeq < sinceSeq 时响应 reset=true */
  sinceSeq?: number;
}
