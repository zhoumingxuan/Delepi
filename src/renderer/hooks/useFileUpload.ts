/**
 * useFileUpload Hook
 * 文件上传本地状态管理 + 主进程落盘异步调用
 *
 * Phase 1 样式基础：
 * - 从原 ChatShell.tsx 中抽取
 * - 删除对 var(--color-*) 的依赖
 * - 接口与 SenderBox 的 PendingFile 保持一致
 *
 * Phase 3 P5 适配层（适配 file:upload 独立 IPC 通道）：
 * - addPendingFiles 后异步触发 file:upload，主进程落盘到 conversations/{id}/uploads/
 * - 每个 pendingFile 维护 uploadStatus：pending/uploading/uploaded/error
 * - uploaded 后写入 uploadedFile（包含 storageKey + id），供 sendMessage 复用
 * - removePendingFile 时若已上传则同步触发 file:delete，避免磁盘孤儿文件
 * - clearPendingFiles 时对所有已上传文件触发 file:delete（最佳努力）
 * - 暴露 uploadingCount 给 useChat 的 P3-1 守卫 4 使用
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_UPLOAD_COUNT } from '@shared/constants';
import { isImageContentType } from '@shared/utils/image-type';
import { getFileContentType } from '@shared/utils/file-mime';
import type { PendingFile } from '../components/SenderBox';

export type PendingUploadStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

/** 同步主进程 file:upload 返回的 ChatUploadedFile 元数据 */
export interface UploadedFileMeta {
  id: string;
  name: string;
  size: number;
  contentType: string;
  storageKey: string;
  uploadedAt: string;
}

/** 带主进程上传状态的 PendingFile（在 SenderBox.PendingFile 基础上扩展） */
export interface UploadPendingFile extends PendingFile {
  /** 上传状态：pending(刚加入待传)/uploading(主进程落盘中)/uploaded(成功)/error(失败) */
  uploadStatus: PendingUploadStatus;
  /** MIME 类型：由文件声明或 file-mime 探测得到，不改变原始文件内容 */
  contentType?: string | undefined;
  /** 上传成功后主进程返回的元数据，包含 storageKey */
  uploadedFile?: UploadedFileMeta | undefined;
  /** 上传失败的错误信息 */
  uploadError?: string | undefined;
}

export interface UseFileUploadReturn {
  pendingFiles: UploadPendingFile[];
  addPendingFiles: (files: File[]) => void;
  removePendingFile: (localKey: string) => void;
  clearPendingFiles: () => void;
  /**
   * P7 切换会话：仅清空本地 pendingFiles state，**不**触发 file:delete（保留磁盘文件）
   * 用于切会话时的清理：避免清空时误删磁盘文件，也避免 new conversation 看到旧 session 的待发送文件
   * 与 clearPendingFiles 的差异：
   * - clearPendingFiles: 卸载/发送后清理，对已上传文件触发 file:delete
   * - clearLocalOnly: 切会话时清理，仅清本地 state，不触发 file:delete（磁盘文件保留）
   */
  clearLocalOnly: () => void;
  pendingFilesRef: React.MutableRefObject<UploadPendingFile[]>;
  /** 当前正在上传的文件数量（P3-1 守卫 4 使用） */
  uploadingCount: number;
  /**
   * 同步当前会话 ID 到上传通道（用于 file:upload 路由）
   * 由 ChatShell 在 conversationId 变化时调用，确保上传指向正确的会话
   */
  setConversationId: (id: string | null) => void;
  setPendingUploadStatus: (localKeys: string[], status: 'uploading' | 'pending') => void;
  uploadFilesForSend: (convId: string, items: AcceptedUploadItem[]) => Promise<{ uploaded: UploadedFileMeta[]; failed: string[] }>;
}

/**
 * 序列化单个 File 为 IPC 可传输的 ArrayBuffer
 * - 用于 file:upload 通道替代 multipart/form-data
 */
async function fileToArrayBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

async function detectFileContentType(file: File): Promise<string> {
  const headerBuffer = await file.slice(0, 4100).arrayBuffer();
  return getFileContentType(file.name, new Uint8Array(headerBuffer));
}

/**
 * triggerUpload 接受的最小 item 信息：
 * - 包含 localKey/file/contentType/fileName，避免在 setState 闭包后从 ref 同步读取
 * - 解决 P0-7：addPendingFiles 中 setPendingFiles 之后立即调用 triggerUpload 时 ref 还未同步的问题
 */
export type AcceptedUploadItem = {
  localKey: string;
  file: File;
  contentType: string;
  fileName: string;
};

export function useFileUpload(): UseFileUploadReturn {
  const [pendingFiles, setPendingFiles] = useState<UploadPendingFile[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const pendingFilesRef = useRef<UploadPendingFile[]>([]);
  const conversationIdRef = useRef<string | null>(null);

  // 同步 pendingFiles 到 ref
  useEffect(() => {
    pendingFilesRef.current = pendingFiles;
  }, [pendingFiles]);

  // 卸载时释放 ObjectURL + 最佳努力清理已上传文件
  useEffect(() => {
    const finalConvId = conversationIdRef.current;
    return () => {
      for (const item of pendingFilesRef.current) {
        try {
          URL.revokeObjectURL(item.previewUrl);
        } catch {
          // ignore
        }
        // 最佳努力：卸载时尝试删除已上传文件，避免磁盘孤儿
        if (
          finalConvId &&
          item.uploadStatus === 'uploaded' &&
          item.uploadedFile?.storageKey &&
          window.electronAPI?.file?.delete
        ) {
          window.electronAPI.file
            .delete({ conversationId: finalConvId, storageKey: item.uploadedFile.storageKey })
            .catch(() => {
              // ignore
            });
        }
      }
    };
  }, []);

  /**
   * 内部函数：将单个 AcceptedUploadItem 标记为 uploading 并异步调用 file:upload
   * 完成后更新 uploadStatus 和 uploadedFile
   *
   * 实现说明（P0-7 修复）：
   * - 旧版本接收 localKey，从 pendingFilesRef.current.find 同步读取 item
   * - 问题：addPendingFiles 中 setPendingFiles 之后 ref 还未同步（useEffect 在 commit 阶段才触发），
   *   导致 find 返回 undefined，提前 return
   * - 修复：改为接收完整 item（localKey/file/contentType/fileName），
   *   调用方在 setState 之前已持有 item 引用，避免依赖 ref 同步性
   */
  const performUpload = useCallback(
    async (convId: string, item: AcceptedUploadItem): Promise<UploadedFileMeta | null> => {
      const { localKey, file, fileName } = item;                 // 原 L165
      const fileType: string = item.contentType || file.type;    // 原 L166
      setPendingFiles((prev) =>                                  // 原 L168-172
        prev.map((p) => (p.localKey === localKey ? { ...p, uploadStatus: 'uploading' } : p)),
      );
      setUploadingCount((c) => c + 1);                           // 原 L173
      try {
        const arrayBuffer = await fileToArrayBuffer(file);       // 原 L177
        if (!window.electronAPI?.file?.upload) {                 // 原 L178-180
          throw new Error('file:upload 通道不可用');
        }
        const result = await window.electronAPI.file.upload({    // 原 L181-187
          conversationId: convId,
          name: fileName,
          size: file.size,
          contentType: fileType || 'application/octet-stream',
          data: arrayBuffer,
        });
        const uploaded = result?.file;                           // 原 L188-191
        if (!uploaded || !uploaded.storageKey) {
          throw new Error('上传响应缺少 storageKey');
        }
        const meta: UploadedFileMeta = {
          id: uploaded.id,
          name: uploaded.name,
          size: uploaded.size,
          contentType: uploaded.contentType,
          storageKey: uploaded.storageKey,
          uploadedAt: uploaded.uploadedAt,
        };
        setPendingFiles((prev) =>                                // 原 L192-210（uploadedFile 字段用 meta 展开）
          prev.map((item) =>
            item.localKey === localKey
              ? { ...item, uploadStatus: 'uploaded', uploadedFile: { ...meta }, uploadError: undefined }
              : item,
          ),
        );
        return meta;                                             // ★新增：向调用方回传元数据
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);   // 原 L212-221
        // eslint-disable-next-line no-console
        console.error('[useFileUpload] upload failed:', msg);
        setPendingFiles((prev) =>
          prev.map((item) =>
            item.localKey === localKey ? { ...item, uploadStatus: 'error', uploadError: msg } : item,
          ),
        );
        return null;                                             // ★新增：失败回传 null（不 throw，由调用方汇总）
      } finally {
        setUploadingCount((c) => Math.max(0, c - 1));            // 原 L222-224
      }
    },
    [],
  );

  const triggerUpload = useCallback(
    (item: AcceptedUploadItem) => {
      const convId = conversationIdRef.current;
      if (!convId) {
        // 没有会话时保持 status='pending'，由发送流程 uploadFilesForSend 或 setConversationId 触发重试
        return;
      }
      void performUpload(convId, item);
    },
    [performUpload],
  );

  /**
   * 发送流程专用：批量改写指定文件的 uploadStatus。
   * - 置 'uploading'：在 createConversation 之前调用，防止 conversationId 变化 effect 内
   *   setUploadConversationId 的 pending 重试（L496-510）与发送流程的显式上传重复上传同一文件
   * - 置 'pending'：发送流程异常中断时回滚（恢复可重试状态）
   */
  const setPendingUploadStatus = useCallback((localKeys: string[], status: 'uploading' | 'pending') => {
    const keySet = new Set(localKeys);
    setPendingFiles((prev) =>
      prev.map((p) =>
        keySet.has(p.localKey) && (status === 'uploading' ? p.uploadStatus === 'pending' : p.uploadStatus === 'uploading')
          ? { ...p, uploadStatus: status }
          : p,
      ),
    );
  }, []);

  /**
   * 发送流程专用：显式指定会话 ID 并行上传并等待全部完成。
   * 返回值不依赖 pendingFiles state 时序（元数据直接来自 performUpload 回传）。
   */
  const uploadFilesForSend = useCallback(
    async (convId: string, items: AcceptedUploadItem[]): Promise<{ uploaded: UploadedFileMeta[]; failed: string[] }> => {
      const uploaded: UploadedFileMeta[] = [];
      const failed: string[] = [];
      const results = await Promise.all(items.map((item) => performUpload(convId, item)));
      results.forEach((result, index) => {
        if (result) uploaded.push(result);
        else failed.push(items[index].fileName);
      });
      return { uploaded, failed };
    },
    [performUpload],
  );

  const addPendingFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;

      const acceptedItems: AcceptedUploadItem[] = [];
      const rejected: string[] = [];

      // MIME 字节签名探测：只用于识别类型和预览，不改变原始文件内容。
      type PreparedFile = {
        originalKey: string;
        file: File;
        contentType: string;
        isImage: boolean;
      };
      const preparedList: PreparedFile[] = [];

      for (const file of files) {
        const isImage = isImageContentType(file.type);
        let preparedContentType: string = file.type || '';

        try {
          const detected = await detectFileContentType(file);
          if (detected && detected !== 'application/octet-stream') {
            preparedContentType = detected;
          }
        } catch {
          // MIME 探测失败时保留 preparedContentType
        }

        // previewIsImage 基于最终 preparedContentType 决定
        const previewIsImage = isImageContentType(preparedContentType) || isImage;

        preparedList.push({
          originalKey: `${file.name}:${file.size}`,
          file,
          contentType: preparedContentType,
          isImage: previewIsImage,
        });
      }

      setPendingFiles((prev) => {
        const existingKeys = new Set(
          prev.map((item) => `${item.file.name}:${item.file.size}`),
        );
        const accepted: UploadPendingFile[] = [];

        for (const p of preparedList) {
          if (prev.length + accepted.length >= MAX_UPLOAD_COUNT) {
            rejected.push(`已达上限 ${MAX_UPLOAD_COUNT} 个文件`);
            break;
          }
          if (existingKeys.has(p.originalKey)) continue;
          existingKeys.add(p.originalKey);

          const previewUrl = p.isImage ? URL.createObjectURL(p.file) : '';
          const localKey = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          // P0-7: 收集完整 item 信息（含 file/contentType/fileName）供 triggerUpload 使用，
          // 避免依赖 pendingFilesRef 同步性
          acceptedItems.push({
            localKey,
            file: p.file,
            contentType: p.contentType,
            fileName: p.file.name,
          });
          accepted.push({
            localKey,
            file: p.file,
            previewUrl,
            isImage: p.isImage,
            contentType: p.contentType,
            uploadStatus: 'pending',
          });
        }

        if (rejected.length) {
          // eslint-disable-next-line no-console
          console.warn('[useFileUpload] rejected:', rejected);
        }

        return [...prev, ...accepted];
      });

      // 触发异步上传（必须在 setPendingFiles 之外，避免闭包时序问题）
      // P0-7：直接传入已构造的 item（不需要再从 ref 查找）
      for (const item of acceptedItems) {
        triggerUpload(item);
      }
    },
    [triggerUpload],
  );

  const removePendingFile = useCallback((localKey: string) => {
    // 从 ref 同步读取待删除文件信息
    const target = pendingFilesRef.current.find((item) => item.localKey === localKey);
    if (target?.previewUrl) {
      try {
        URL.revokeObjectURL(target.previewUrl);
      } catch {
        // ignore
      }
    }
    const storageKeyToDelete: string | undefined =
      target?.uploadStatus === 'uploaded' && target.uploadedFile?.storageKey
        ? target.uploadedFile.storageKey
        : undefined;

    setPendingFiles((prev) => prev.filter((item) => item.localKey !== localKey));

    // 已上传 → 异步触发 file:delete（最佳努力）
    const convId = conversationIdRef.current;
    if (storageKeyToDelete && convId && window.electronAPI?.file?.delete) {
      window.electronAPI.file
        .delete({ conversationId: convId, storageKey: storageKeyToDelete })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[useFileUpload] delete orphan file failed:', err);
        });
    }
  }, []);

  /**
   * 清空所有 pending 文件
   * - keepUploaded=false（默认）：对已上传文件触发 file:delete（卸载/发送后清理）
   * - keepUploaded=true：仅清本地 state,磁盘文件保留（一般不直接使用,优先用 clearLocalOnly）
   */
  const clearPendingFiles = useCallback((options?: { keepUploaded?: boolean }) => {
    const convId = conversationIdRef.current;
    const keepUploaded = options?.keepUploaded === true;
    const toDeletes: Array<{ conversationId: string; storageKey: string }> = [];
    for (const item of pendingFilesRef.current) {
      if (item.previewUrl) {
        try {
          URL.revokeObjectURL(item.previewUrl);
        } catch {
          // ignore
        }
      }
      if (
        !keepUploaded &&
        convId &&
        item.uploadStatus === 'uploaded' &&
        item.uploadedFile?.storageKey
      ) {
        toDeletes.push({ conversationId: convId, storageKey: item.uploadedFile.storageKey });
      }
    }
    setPendingFiles([]);
    // 最佳努力：批量删除已上传文件(仅在 keepUploaded=false 时)
    for (const payload of toDeletes) {
      if (window.electronAPI?.file?.delete) {
        window.electronAPI.file
          .delete(payload)
          .catch(() => {
            // ignore
          });
      }
    }
  }, []);

  /**
   * P7 切换会话：仅清空本地 state,不触发 file:delete
   * 与 clearPendingFiles 的区别：仅清本地 state，磁盘文件保留
   */
  const clearLocalOnly = useCallback(() => {
    for (const item of pendingFilesRef.current) {
      if (item.previewUrl) {
        try {
          URL.revokeObjectURL(item.previewUrl);
        } catch {
          // ignore
        }
      }
    }
    setPendingFiles([]);
  }, []);

  const setConversationId = useCallback((id: string | null) => {
    const previous = conversationIdRef.current;
    conversationIdRef.current = id;

    // 当 conversationId 从 null 切换到具体 id 时（新建/切换会话），
    // 重试所有 pending 状态的文件上传
    if (id && id !== previous) {
      // P0-7：从 ref 构造 AcceptedUploadItem 后传入 triggerUpload（不再传 localKey）
      const pendingItems = pendingFilesRef.current
        .filter((item) => item.uploadStatus === 'pending')
        .map(
          (item): AcceptedUploadItem => ({
            localKey: item.localKey,
            file: item.file,
            contentType: item.contentType || item.file.type,
            fileName: item.file.name,
          }),
        );
      for (const item of pendingItems) {
        triggerUpload(item);
      }
    }
  }, [triggerUpload]);

  return {
    pendingFiles,
    addPendingFiles,
    removePendingFile,
    clearPendingFiles,
    clearLocalOnly,
    pendingFilesRef,
    uploadingCount,
    setConversationId,
    setPendingUploadStatus,
    uploadFilesForSend,
  };
}
