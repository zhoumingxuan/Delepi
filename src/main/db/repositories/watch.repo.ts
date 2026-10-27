/**
 * watch.repo — 值守模式两表仓储（watch_state / watch_processed_mails，v3 §10.3）
 *
 * 说明：
 * - 本仓储不经 src/main/db/index.ts 汇出（该文件不在阶段2改动白名单内），
 *   由 watch-service 以相对路径直接引用
 * - watch_state：单行水位（id 恒为 1）；UIDVALIDITY 变化时由调用方判定重置基线
 * - watch_processed_mails：
 *   - L2 邮件级幂等：message_id 主键（必须使用收件箱实际 Message-ID——腾讯会改写声明值）
 *   - L3 业务级幂等：UNIQUE (mailbox, request_id)
 *   - ignored 邮件以 'ignored:<uid>' 作为 request_id 写入，避免多条 ignored 记录在
 *     UNIQUE (mailbox, '') 约束下互相覆盖，保证逐封可审计
 */

import { getDb } from '../sqlite-adapter';
import { nowIso } from '../helpers';

export interface WatchStateRow {
  mailbox: string;
  uidvalidity: number;
  lastUid: number;
  updatedAt: string;
}

export interface WatchProcessedMailEntry {
  messageId: string;
  mailbox: string;
  uid: number;
  requestId: string;
  subject: string;
  sender: string;
  status: 'replied' | 'failed' | 'ignored';
  resultSummary: string;
  receiptChannel: '' | 'service_direct';
  attachmentCount: number;
  attachmentManifest: string;
}

export type WatchProcessedMailRow = WatchProcessedMailEntry & { createdAt: string };

/** 读取值守水位（无记录返回 null） */
export function getWatchState(): WatchStateRow | null {
  const db = getDb();
  const row = db
    .prepare('SELECT mailbox, uidvalidity, last_uid, updated_at FROM watch_state WHERE id = 1')
    .get() as { mailbox: string; uidvalidity: number; last_uid: number; updated_at: string } | undefined;
  if (!row) {
    return null;
  }
  return {
    mailbox: row.mailbox,
    uidvalidity: row.uidvalidity,
    lastUid: row.last_uid,
    updatedAt: row.updated_at,
  };
}

/** 写值守水位（单行 UPSERT，id 恒为 1） */
export function saveWatchState(mailbox: string, uidvalidity: number, lastUid: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO watch_state (id, mailbox, uidvalidity, last_uid, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET mailbox = excluded.mailbox, uidvalidity = excluded.uidvalidity,
       last_uid = excluded.last_uid, updated_at = excluded.updated_at`,
  ).run(mailbox, uidvalidity, lastUid, nowIso());
}

/** L2：该邮件（收件箱实际 Message-ID）是否已处理过 */
export function isMailProcessed(messageId: string): boolean {
  if (!messageId) {
    return false;
  }
  const db = getDb();
  const row = db.prepare('SELECT message_id FROM watch_processed_mails WHERE message_id = ?').get(messageId);
  return row !== undefined;
}

function mapProcessedRow(row: {
  message_id: string;
  mailbox: string;
  uid: number;
  request_id: string;
  subject: string;
  sender: string;
  status: string;
  result_summary: string;
  receipt_channel: string;
  attachment_count: number;
  attachment_manifest: string;
  created_at: string;
}): WatchProcessedMailRow {
  return {
    messageId: row.message_id,
    mailbox: row.mailbox,
    uid: row.uid,
    requestId: row.request_id,
    subject: row.subject,
    sender: row.sender,
    status: row.status as WatchProcessedMailRow['status'],
    resultSummary: row.result_summary,
    receiptChannel: row.receipt_channel as WatchProcessedMailRow['receiptChannel'],
    attachmentCount: row.attachment_count,
    attachmentManifest: row.attachment_manifest,
    createdAt: row.created_at,
  };
}

/** L3：按 mailbox + request_id 查找已处理记录（重复请求检测） */
export function findProcessedByRequestId(mailbox: string, requestId: string): WatchProcessedMailRow | null {
  if (!mailbox || !requestId) {
    return null;
  }
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM watch_processed_mails WHERE mailbox = ? AND request_id = ?')
    .get(mailbox, requestId) as Parameters<typeof mapProcessedRow>[0] | undefined;
  return row ? mapProcessedRow(row) : null;
}

/** 登记一封已处理邮件（INSERT OR REPLACE，单条原子写） */
export function markWatchMailProcessed(entry: WatchProcessedMailEntry): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO watch_processed_mails
       (message_id, mailbox, uid, request_id, subject, sender, status, result_summary,
        receipt_channel, attachment_count, attachment_manifest, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.messageId,
    entry.mailbox,
    entry.uid,
    entry.requestId,
    entry.subject,
    entry.sender,
    entry.status,
    entry.resultSummary,
    entry.receiptChannel,
    entry.attachmentCount,
    entry.attachmentManifest,
    nowIso(),
  );
}

/** 维护性清理：删除 30 天前记录；总量超 5000 时按 created_at 升序删至 4000（v3 §10.3） */
export function cleanupWatchProcessedMails(): void {
  const db = getDb();
  db.prepare("DELETE FROM watch_processed_mails WHERE created_at < datetime('now', 'localtime', '-30 days')").run();
  const count = (db.prepare('SELECT COUNT(*) AS c FROM watch_processed_mails').get() as { c: number }).c;
  if (count > 5000) {
    db.prepare(
      `DELETE FROM watch_processed_mails WHERE message_id IN (
         SELECT message_id FROM watch_processed_mails ORDER BY created_at ASC LIMIT ?
       )`,
    ).run(count - 4000);
  }
}

/** 已处理记录总数（状态展示/测试核验用） */
export function countWatchProcessedMails(): number {
  const db = getDb();
  return (db.prepare('SELECT COUNT(*) AS c FROM watch_processed_mails').get() as { c: number }).c;
}
