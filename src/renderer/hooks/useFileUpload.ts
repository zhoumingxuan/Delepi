/**
 * useFileUpload Hook —— 「粘贴即落盘、无中间态」直通模型
 *
 * 核心理念（2026-09-04 上传链路整体重构）：剪贴板粘贴 = 一次本地文件复制粘贴
 * （剪贴板 → 读取 → Base64 → IPC → 本地落盘 → 附件就绪）。
 *
 * - 状态机三态：saving（读取+Base64+IPC+主进程写盘的物理异步窗口）/ ready（落盘完成，
 *   uploadedFile 元数据在手，可直接随消息发送）/ error（失败即报终态，红条 title +
 *   批次聚合 toast + 主进程持久日志三层反馈）
 * - 无会话粘贴：粘贴时刻经 options.ensureConversation 前置创建会话后立即落盘，
 *   不存在「等待会话」的挂起中间态（hook 侧在途 promise 去重；创建期间用户切走则
 *   本批丢弃并 toast）
 * - 唯一上传触发点：addPendingFiles 内同步循环逐项 performSave（不依赖任何 state
 *   提交时序 —— R1-safe：全部要素在更新器外派生、更新器只做纯合并、触发遍历使用
 *   更新器外部的数组）
 * - saving 期间被用户点 × 的项经 removedWhileSavingRef 显式登记，settle 成功后
 *   最佳努力 file:delete 孤儿回收（按构造安全：该 storageKey 在项被移除前从未达到
 *   ready，消息只消费 ready 项，物理上不可能被任何消息引用）
 * - 卸载清理仅 revokeObjectURL（渲染端在卸载时刻无法权威判定文件是否已被消息引用，
 *   完全退出 file:delete 消费；孤儿处置归 R6 搁置口径 + 会话级 cleanup-orphans 兜底）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_UPLOAD_COUNT } from '@shared/constants';
import { isImageContentType } from '@shared/utils/image-type';
import { getFileContentType } from '@shared/utils/file-mime';
import type { PendingFile } from '../components/SenderBox';

/** 附件三态：saving=落盘物理窗口；ready=已落盘就绪；error=失败即报 */
export type PendingUploadStatus = 'saving' | 'ready' | 'error';

/** 主进程 file:upload 返回的 ChatUploadedFile 元数据（ready 时持有，含 storageKey） */
export interface UploadedFileMeta {
  id: string;
  name: string;
  size: number;
  contentType: string;
  storageKey: string;
  uploadedAt: string;
}

/** 带落盘状态的 PendingFile（在 SenderBox.PendingFile 基础上扩展） */
export interface UploadPendingFile extends PendingFile {
  /** 落盘状态：saving(读取+IPC+写盘物理窗口)/ready(落盘完成，元数据在手)/error(失败即报) */
  uploadStatus: PendingUploadStatus;
  /** MIME 类型：由文件声明或 file-mime 探测得到，不改变原始文件内容 */
  contentType?: string | undefined;
  /** ready 时必有：主进程返回的元数据，包含 storageKey */
  uploadedFile?: UploadedFileMeta | undefined;
  /** error 时必有：失败原因（附件条 title + 批次聚合 toast 消费） */
  uploadError?: string | undefined;
}

export interface UseFileUploadOptions {
  /** 无会话粘贴时的前置会话创建器：返回新会话 id；失败/在途且未产出返回 null */
  ensureConversation: () => Promise<string | null>;
  /** 用户可见反馈（预筛跳过 / 会话创建失败 / 批次聚合失败 toast） */
  notify: (level: 'warning' | 'error', text: string) => void;
}

export interface UseFileUploadReturn {
  pendingFiles: UploadPendingFile[];
  addPendingFiles: (files: File[]) => void;
  removePendingFile: (localKey: string) => void;
  /** 仅清空本地 pendingFiles state（revoke + 清空），不触发 file:delete（磁盘保留，R6 口径） */
  clearLocalOnly: () => void;
  /** 当前落盘物理窗口内的文件数量（ChatShell 场景c 守卫与 canSend 派生使用） */
  savingCount: number;
  /** 同步当前会话 ID（file:upload 路由目标）；A→B / A→null 清空本地列表，null→B 不清 */
  setConversationId: (id: string | null) => void;
}

/**
 * 直通落盘的最小 item 信息（模块内部类型，外部零引用）：
 * - 包含 localKey/file/contentType/fileName，全部在 setPendingFiles 更新器外派生，
 *   避免 setState 闭包后从 ref 同步读取
 */
type AcceptedUploadItem = {
  localKey: string;
  file: File;
  contentType: string;
  fileName: string;
};

/** performSave 单项结果：ok=true 携带落盘元数据；ok=false 携带失败原因（批次聚合 toast 消费） */
type SaveOutcome = { ok: true; meta: UploadedFileMeta } | { ok: false; error: string };

/**
 * 读取单个 File 为 ArrayBuffer（MIME 探测与 Base64 编码共用）
 */
async function fileToArrayBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

/**
 * ArrayBuffer → Base64 字符串（H1 防御核心）
 * - file:upload 通道 IPC 传输数据由 ArrayBuffer 改为 Base64 字符串：
 *   纯字符串经结构化克隆传输不存在二进制序列化断点；主进程 fileInputToBuffer
 *   以 Buffer.from(data, 'base64') 解码，并兼容旧 ArrayBuffer 入参（向后兼容）；
 * - 分块拼接规避 String.fromCharCode 单次展开参数上限。
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function detectFileContentType(file: File): Promise<string> {
  const headerBuffer = await file.slice(0, 4100).arrayBuffer();
  return getFileContentType(file.name, new Uint8Array(headerBuffer));
}

export function useFileUpload(options: UseFileUploadOptions): UseFileUploadReturn {
  const [pendingFiles, setPendingFiles] = useState<UploadPendingFile[]>([]);
  const [savingCount, setSavingCount] = useState(0);
  const pendingFilesRef = useRef<UploadPendingFile[]>([]);
  const conversationIdRef = useRef<string | null>(null);
  const ensureInflightRef = useRef<Promise<string | null> | null>(null);
  // saving 期间被用户点 × 删除的 localKey（settle 后孤儿回收专用；显式登记按构造安全，
  // 不依赖 pendingFilesRef 缺席探测 —— ref 镜像在 commit 前可能滞后，缺席探测有误删在列项的风险）
  const removedWhileSavingRef = useRef<Set<string>>(new Set());

  // options 解构（ChatShell 侧两个回调均 useCallback 稳定；依赖解构项而非 options 对象本体）
  const { ensureConversation: ensureConversationFn, notify } = options;

  // 同步 pendingFiles 到 ref（仅镜像自身；严禁把 ref 当作最新列表的权威判源）
  useEffect(() => {
    pendingFilesRef.current = pendingFiles;
  }, [pendingFiles]);

  // 卸载清理：仅释放 ObjectURL（不再触发 file:delete —— 卸载时刻渲染端无法权威判定
  // 文件是否已被消息引用，任何卸载期删除都携带误删已发送附件的风险；孤儿归 R6 口径）
  useEffect(() => {
    return () => {
      for (const item of pendingFilesRef.current) {
        try {
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        } catch {
          // ignore
        }
      }
    };
  }, []);

  /**
   * 前置会话就绪（无会话粘贴时在粘贴时刻创建会话）：
   * - 已有会话 → 直接返回 conversationIdRef.current；
   * - 在途 promise 去重：无会话连续快速粘贴两次复用同一次创建；
   * - 创建期间用户已切走（ref 已被切会话 effect 写为其他 id）→ 返回 null（本批丢弃）。
   */
  const ensureConversation = useCallback(async (): Promise<string | null> => {
    if (conversationIdRef.current) return conversationIdRef.current;
    if (!ensureInflightRef.current) {
      ensureInflightRef.current = ensureConversationFn().then((id) => {
        ensureInflightRef.current = null;
        if (id && conversationIdRef.current === null) conversationIdRef.current = id;
        return id !== null && conversationIdRef.current === id ? id : null;
      });
    }
    return ensureInflightRef.current;
  }, [ensureConversationFn]);

  /**
   * 唯一上传路径：saving → file:upload IPC → ready / error（纯更新器，R1-safe）
   * - settle 更新使用纯 prev.map（项已被移除则 map 不命中即 no-op）；
   * - 失败三层反馈：error 态 + uploadError（附件条 title）、console、log:renderer ERROR 转发；
   * - saving 期间被点 × 的项（removedWhileSavingRef 显式登记）settle 成功后最佳努力
   *   file:delete 孤儿回收。
   */
  const performSave = useCallback(
    async (convId: string, item: AcceptedUploadItem): Promise<SaveOutcome> => {
      const { localKey, file, fileName } = item;
      const fileType: string = item.contentType || file.type;
      setSavingCount((c) => c + 1);
      try {
        const arrayBuffer = await fileToArrayBuffer(file);
        const dataBase64 = arrayBufferToBase64(arrayBuffer);   // H1：IPC 传输数据为 Base64 字符串
        if (!window.electronAPI?.file?.upload) {
          throw new Error('file:upload 通道不可用');
        }
        const result = await window.electronAPI.file.upload({
          conversationId: convId,
          name: fileName,
          size: file.size,
          contentType: fileType || 'application/octet-stream',
          data: dataBase64,
        });
        const uploaded = result?.file;
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
        setPendingFiles((prev) =>
          prev.map((entry) =>
            entry.localKey === localKey
              ? { ...entry, uploadStatus: 'ready', uploadedFile: { ...meta }, uploadError: undefined }
              : entry,
          ),
        );
        // settle 孤儿回收：仅回收「saving 期间被用户点 ×」的项（显式登记命中才回收；
        // 该 storageKey 从未达到 ready，物理上不可能进入任何消息 attachments）
        if (removedWhileSavingRef.current.delete(localKey)) {
          window.electronAPI?.file
            ?.delete?.({ conversationId: convId, storageKey: meta.storageKey })
            ?.catch(() => {
              // ignore：最佳努力回收失败不影响状态机
            });
        }
        return { ok: true, meta };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error('[useFileUpload] save failed:', msg);
        // R3：渲染端失败转发主进程持久日志（ERROR 级含 err.message/stack），打包版亦可查
        try {
          window.electronAPI?.log
            ?.write({
              level: 'ERROR',
              stage: 'useFileUpload.performSave',
              message: `file:upload 失败 name=${fileName} conversationId=${convId} localKey=${localKey}`,
              err: {
                message: msg,
                stack: err instanceof Error ? err.stack : undefined,
              },
            })
            ?.catch(() => {
              // 日志通道自身失败不放大故障
            });
        } catch {
          // ignore：日志转发失败不影响上传状态机
        }
        setPendingFiles((prev) =>
          prev.map((entry) =>
            entry.localKey === localKey ? { ...entry, uploadStatus: 'error', uploadError: msg } : entry,
          ),
        );
        return { ok: false, error: msg };
      } finally {
        setSavingCount((c) => Math.max(0, c - 1));
      }
    },
    [],
  );

  /**
   * 直通入口：粘贴/拖拽/+按钮收集的文件 → 预筛 → 会话就绪 → saving 入列 → 逐项 performSave
   * R1-safe 四段：①prepare 在更新器外派生；②预筛基于渲染闭包快照 pendingFiles 判断；
   * ③更新器只做纯合并 + 基于 prev 的权威去重/上限兜底；④触发遍历使用更新器外部数组。
   */
  const addPendingFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;

      // ── ① prepare：MIME 字节签名探测 + localKey 生成（全部在更新器外派生）──
      type PreparedFile = {
        originalKey: string;
        localKey: string;
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
          // localKey 在 setPendingFiles 更新器外部生成 —— React 19（react-dom
          // dispatchSetStateInternal）在 fiber.lanes!==0 时推迟更新器到渲染期执行，
          // 更新器内部构造的数据对紧随其后的同步遍历不可见。localKey/file/
          // contentType 等全部要素在更新器外先行确定，更新器与触发遍历共用同一份外部数据。
          localKey: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          file,
          contentType: preparedContentType,
          isImage: previewIsImage,
        });
      }

      const acceptedItems: AcceptedUploadItem[] = preparedList.map((p) => ({
        localKey: p.localKey,
        file: p.file,
        contentType: p.contentType,
        fileName: p.file.name,
      }));

      // ── ② 预筛：同名同大小去重 + MAX_UPLOAD_COUNT 预检（基于渲染闭包快照
      //    pendingFiles 判断——严禁把 ref 镜像当最新列表）；预筛跳过的项不创建
      //    ObjectURL（零泄漏）、不触发上传 ──
      const existingKeys = new Set(
        pendingFiles.map((item) => `${item.file.name}:${item.file.size}`),
      );
      const acceptedCandidates: UploadPendingFile[] = [];
      const skippedKeys = new Set<string>();
      let duplicateSkipped = 0;
      let limitSkipped = 0;
      for (const p of preparedList) {
        if (existingKeys.has(p.originalKey)) {
          skippedKeys.add(p.localKey);
          duplicateSkipped += 1;
          continue;
        }
        if (pendingFiles.length + acceptedCandidates.length >= MAX_UPLOAD_COUNT) {
          skippedKeys.add(p.localKey);
          limitSkipped += 1;
          continue;
        }
        existingKeys.add(p.originalKey);
        acceptedCandidates.push({
          localKey: p.localKey,
          file: p.file,
          previewUrl: p.isImage ? URL.createObjectURL(p.file) : '',
          isImage: p.isImage,
          contentType: p.contentType,
          uploadStatus: 'saving',
        });
      }

      // 预筛拒绝 toast（升级用户可见反馈——修复现状仅 console.warn 的 R3 盲区）
      if (duplicateSkipped > 0 || limitSkipped > 0) {
        const skippedTotal = duplicateSkipped + limitSkipped;
        const reasons: string[] = [];
        if (duplicateSkipped > 0) reasons.push(`同名重复 ${duplicateSkipped} 个`);
        if (limitSkipped > 0) reasons.push(`已达上限 ${MAX_UPLOAD_COUNT} 个（超出 ${limitSkipped} 个）`);
        // eslint-disable-next-line no-console
        console.warn('[useFileUpload] skipped:', skippedTotal, reasons.join('；'));
        notify('warning', `跳过 ${skippedTotal} 个文件：${reasons.join('；')}`);
      }
      if (!acceptedCandidates.length) return;

      // ── ③ 会话就绪：无会话粘贴在粘贴时刻前置创建会话（不存在挂起等待）──
      let convId = conversationIdRef.current;
      if (!convId) {
        convId = await ensureConversation();
        if (!convId) {
          notify('error', '会话创建失败，附件未添加，请重试粘贴');
          return;
        }
        if (conversationIdRef.current !== convId) {
          // 创建期间用户切走会话（ref 已被切会话 effect 改写）→ 本批丢弃
          notify('warning', '会话已切换，附件未添加');
          return;
        }
      }

      // ── ④ 纯更新器合并：项以 saving 入列；更新器内基于 prev 权威去重 + 上限兜底
      //    （纯函数无副作用，被 React 推迟或重复调用均不影响外部已构造的 acceptedItems）──
      setPendingFiles((prev) => {
        if (!acceptedCandidates.length) return prev;
        const prevKeys = new Set(
          prev.map((item) => `${item.file.name}:${item.file.size}`),
        );
        const merged: UploadPendingFile[] = [];
        for (const candidate of acceptedCandidates) {
          if (prev.length + merged.length >= MAX_UPLOAD_COUNT) break;
          const key = `${candidate.file.name}:${candidate.file.size}`;
          if (prevKeys.has(key)) continue;
          prevKeys.add(key);
          merged.push(candidate);
        }
        return merged.length ? [...prev, ...merged] : prev;
      });

      // ── ⑤ 唯一触发点：遍历更新器外部的数组逐项直通落盘（不依赖 state 提交时序；
      //    预筛跳过的项不触发；同 tick 并发重复项由更新器权威去重丢弃但其 IPC 已发出，
      //    孤儿继承现状行为归 R6 口径）──
      const tasks: Array<Promise<SaveOutcome>> = [];
      for (const item of acceptedItems) {
        if (skippedKeys.has(item.localKey)) continue;
        tasks.push(performSave(convId, item));
      }

      // ── ⑥ 批次汇总：失败即报（单次聚合 toast，首个失败原因）──
      const results = await Promise.allSettled(tasks);
      let failedCount = 0;
      let firstError = '';
      for (const result of results) {
        if (result.status === 'fulfilled' && !result.value.ok) {
          failedCount += 1;
          if (!firstError) firstError = result.value.error;
        }
      }
      if (failedCount > 0) {
        notify('warning', `${failedCount} 个文件保存失败：${firstError || '未知错误'}`);
      }
    },
    [ensureConversation, performSave, pendingFiles, notify],
  );

  const removePendingFile = useCallback(
    (localKey: string) => {
      // 按 localKey 单项查找（ref 的安全用途：单项查找而非最新列表判源）
      const target = pendingFilesRef.current.find((item) => item.localKey === localKey);
      if (target?.previewUrl) {
        try {
          URL.revokeObjectURL(target.previewUrl);
        } catch {
          // ignore
        }
      }
      // saving 项：显式登记，settle 成功后由 performSave 最佳努力孤儿回收
      if (target?.uploadStatus === 'saving') {
        removedWhileSavingRef.current.add(localKey);
      }
      setPendingFiles((prev) => prev.filter((item) => item.localKey !== localKey));
      // 仅 ready 项立即删除磁盘文件：发送受理在 sendMessage 之前已 clearLocalOnly
      // 清空列表，故列表内 ready 项必未随任何消息发送（未被引用安全证明）
      const convId = conversationIdRef.current;
      if (target?.uploadStatus === 'ready' && target.uploadedFile?.storageKey && convId) {
        window.electronAPI?.file
          ?.delete?.({ conversationId: convId, storageKey: target.uploadedFile.storageKey })
          ?.catch(() => {
            // ignore：最佳努力删除失败不影响状态机
          });
      }
    },
    [],
  );

  /** 切会话/发送受理时清理：仅清本地 state + revoke，不触发 file:delete（磁盘保留，R6 口径） */
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

  const setConversationId = useCallback(
    (id: string | null) => {
      const previous = conversationIdRef.current;
      conversationIdRef.current = id;
      // A→B / A→null：清空旧会话本地列表（revoke + 清空，不发 file:delete）；
      // null→B（粘贴前置建会话后的激活同步/无会话态新建）不清——首次挂载列表必空，
      // 前置建会话场景列表正承载本批 saving 项，规则天然安全
      if (previous !== null && id !== previous) clearLocalOnly();
    },
    [clearLocalOnly],
  );

  return {
    pendingFiles,
    addPendingFiles,
    removePendingFile,
    clearLocalOnly,
    savingCount,
    setConversationId,
  };
}
