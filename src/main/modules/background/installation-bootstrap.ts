import type Database from 'better-sqlite3';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BackgroundProtocol } from '@shared/types/background';
import type { GoalService } from '../goals/goal-service';
import { DEFAULT_EXPLORATION_LIMITS } from '../goals/goal-service';
import { AutonomyError, hashValue } from '../goals/autonomy-store';
import { permissionDate, permissionId, permissionObject } from '../permissions/permission-validation';
import type { BackgroundScheduler } from './scheduler';

export const BACKGROUND_EXCEL_SOURCES = [
  'https://pandas.pydata.org/docs/user_guide/missing_data.html',
  'https://pandas.pydata.org/docs/user_guide/io.html',
  'https://openpyxl.readthedocs.io/en/stable/optimized.html',
] as const;
interface EnablementRequest {
  schemaVersion: 1; requestId: string; preset: 'excel-data-quality-v1'; createdAt: string; expiresAt: string; protocol: BackgroundProtocol;
}
export interface BackgroundEnablementReceipt {
  requestId: string; preset: 'excel-data-quality-v1'; goalId: string; scheduleId: string;
  createdAt: string; expiresAt: string; protocol: BackgroundProtocol; consumedAt: string;
  replayed: boolean; cleanupPending?: true;
}
export interface BackgroundEnablementPort {
  goals: Pick<GoalService, 'listDestinations' | 'create'>;
  scheduler: Pick<BackgroundScheduler, 'configure'>;
  now?: () => number;
}
const MAX_REQUEST_BYTES = 4096, MAX_DURATION = 7 * 86400000;
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
  && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.uid === b.uid;
const ownedAuthorization = (stat: Stats) => (typeof process.getuid !== 'function' || stat.uid === process.getuid())
  && (stat.mode & 0o022) === 0;
const isMissing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

/** Consume the user's installation authorization through a private main-process
 * file. Neither model output nor IPC can provide source URLs, paths or grants. */
export async function consumeBackgroundEnablementRequest(db: Database.Database, runtime: BackgroundEnablementPort, userDataPath: string): Promise<BackgroundEnablementReceipt | null> {
  const root = await realpath(userDataPath), directory = path.join(root, 'muse');
  let directoryIdentity: Stats;
  try { directoryIdentity = await lstat(directory); } catch (error) { if (isMissing(error)) return null; throw error; }
  if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink() || !ownedAuthorization(directoryIdentity)
    || await realpath(directory) !== directory) throw new AutonomyError('BACKGROUND_REQUEST_INVALID');
  const requestPath = path.join(directory, 'background-enablement-request.json');
  let requestIdentity: Stats;
  try { requestIdentity = await lstat(requestPath); } catch (error) { if (isMissing(error)) return null; throw error; }
  if (!requestIdentity.isFile() || requestIdentity.isSymbolicLink() || !ownedAuthorization(requestIdentity)
    || requestIdentity.size < 2 || requestIdentity.size > MAX_REQUEST_BYTES) throw new AutonomyError('BACKGROUND_REQUEST_INVALID');
  const handle = await open(requestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const actual = await handle.stat();
    if (!sameFile(actual, requestIdentity) || !actual.isFile() || !ownedAuthorization(actual)) throw new AutonomyError('BACKGROUND_REQUEST_CHANGED');
    // A bounded positional read never follows file growth to an unbounded EOF.
    const bounded = Buffer.alloc(MAX_REQUEST_BYTES + 1);
    const { bytesRead } = await handle.read(bounded, 0, bounded.length, 0);
    if (bytesRead !== actual.size || bytesRead > MAX_REQUEST_BYTES || !sameFile(actual, await handle.stat())) throw new AutonomyError('BACKGROUND_REQUEST_CHANGED');
    bytes = bounded.subarray(0, bytesRead);
  } finally { await handle.close(); }
  const readDirectory = await lstat(directory);
  if (!readDirectory.isDirectory() || readDirectory.isSymbolicLink() || !ownedAuthorization(readDirectory)
    || readDirectory.dev !== directoryIdentity.dev || readDirectory.ino !== directoryIdentity.ino) throw new AutonomyError('BACKGROUND_REQUEST_CHANGED');
  let request: EnablementRequest;
  try {
    const raw = permissionObject(JSON.parse(bytes.toString('utf8')), ['schemaVersion', 'requestId', 'preset', 'createdAt', 'expiresAt', 'protocol']);
    if (raw.schemaVersion !== 1 || raw.preset !== 'excel-data-quality-v1' || !['chat-completions', 'responses'].includes(String(raw.protocol))) throw new AutonomyError('BACKGROUND_REQUEST_INVALID');
    request = { schemaVersion: 1, requestId: permissionId(raw.requestId), preset: 'excel-data-quality-v1',
      createdAt: permissionDate(raw.createdAt), expiresAt: permissionDate(raw.expiresAt), protocol: raw.protocol as BackgroundProtocol };
  } catch { throw new AutonomyError('BACKGROUND_REQUEST_INVALID'); }
  const now = runtime.now?.() ?? Date.now(), requestHash = hashValue(request);
  const project = (row: Record<string, unknown>, replayed: boolean): BackgroundEnablementReceipt => ({ requestId: String(row.request_id),
    preset: 'excel-data-quality-v1', goalId: String(row.goal_id), scheduleId: String(row.schedule_id), createdAt: String(row.created_at),
    expiresAt: String(row.expires_at), protocol: row.protocol as BackgroundProtocol, consumedAt: String(row.consumed_at), replayed });
  // Recheck authorization ownership and write permissions at the last async
  // boundary before the synchronous Goal/rule/receipt transaction.
  const commitDirectory = await lstat(directory), commitRequest = await lstat(requestPath);
  if (!commitDirectory.isDirectory() || commitDirectory.isSymbolicLink() || !ownedAuthorization(commitDirectory)
    || commitDirectory.dev !== directoryIdentity.dev || commitDirectory.ino !== directoryIdentity.ino
    || !commitRequest.isFile() || commitRequest.isSymbolicLink() || !ownedAuthorization(commitRequest)
    || !sameFile(commitRequest, requestIdentity)) throw new AutonomyError('BACKGROUND_REQUEST_CHANGED');
  const receipt = db.transaction(() => {
    const previous = db.prepare('SELECT * FROM muse_background_enablement_receipts WHERE request_id=?').get(request.requestId) as Record<string, unknown> | undefined;
    if (previous) {
      if (previous.request_hash !== requestHash) throw new AutonomyError('BACKGROUND_REQUEST_CONFLICT');
      // Completed requests are receipts, not another enable command. A later
      // user pause, schedule edit, provider change or expiry is preserved.
      return project(previous, true);
    }
    const createdAt = Date.parse(request.createdAt), expiry = Date.parse(request.expiresAt);
    if (!Number.isFinite(now) || createdAt > now + 60000 || createdAt < now - MAX_DURATION || expiry <= now || expiry <= createdAt || expiry > createdAt + MAX_DURATION) throw new AutonomyError('BACKGROUND_REQUEST_EXPIRED');
    const destinations = runtime.goals.listDestinations(), destination = destinations.find(value => value.available && value.label === '当前主模型') ?? destinations.find(value => value.available);
    if (!destination) throw new AutonomyError('DESTINATION_UNAVAILABLE');
    const goal = runtime.goals.create({
      title: 'Excel 数据质量与表格自动化',
      topic: '只研究已登记的 pandas 与 openpyxl 官方公开文档，学习缺失值、表格导入导出、字段校验、重复记录、公式和大文件处理。提炼可复用的数据质量检查与表格自动化知识，不读取本地聊天、附件或工作表，不执行代码，也不扩展来源。',
      sourceUrls: [...BACKGROUND_EXCEL_SOURCES], destinationId: destination.id,
      expectedOutput: '每轮交付总计不超过 900 汉字的简短中文 Markdown：检查步骤、适用条件、限制和来源；最多一个短纯文本技能候选，steps 不超过 5 项、checks 不超过 3 项、limitations 不超过 2 项，来源引用使用实际 resourceRef，不使用 URL 代替资源身份。',
      stopConditions: '每轮只执行一次公开资料读取和模型总结；遇授权、来源、模型或预算变化立即停止，不重试未知结果；每天最多 3 轮，授权 7 天内到期。',
      limits: { ...DEFAULT_EXPLORATION_LIMITS, modelRequests: 1, fetchRequests: 3, maxDocumentBytes: 1024 * 1024 },
    });
    const schedule = runtime.scheduler.configure(goal.id, goal.revision, { intervalMinutes: 30, dailyRoundLimit: 3, expiresAt: request.expiresAt,
      protocol: request.protocol, learningEnabled: true, autoPromote: true }, 1);
    const consumedAt = new Date(now).toISOString();
    db.prepare('INSERT INTO muse_background_enablement_receipts(request_id,request_hash,preset,goal_id,schedule_id,created_at,expires_at,protocol,consumed_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(request.requestId, requestHash, request.preset, goal.id, schedule.id, request.createdAt, request.expiresAt, request.protocol, consumedAt);
    return { requestId: request.requestId, preset: request.preset, goalId: goal.id, scheduleId: schedule.id,
      createdAt: request.createdAt, expiresAt: request.expiresAt, protocol: request.protocol, consumedAt, replayed: false } satisfies BackgroundEnablementReceipt;
  })();
  // Reporting and deletion follow the atomic database commit. If either fails,
  // the unchanged request remains a safe idempotent cleanup retry next startup.
  const receiptPath = path.join(directory, `background-enablement-receipt-${request.requestId}.json`), temporary = path.join(directory, `.enablement-${randomUUID()}.tmp`);
  try {
    const directoryNow = await lstat(directory);
    if (directoryIdentity.ino !== directoryNow.ino || directoryIdentity.dev !== directoryNow.dev
      || !directoryNow.isDirectory() || directoryNow.isSymbolicLink() || !ownedAuthorization(directoryNow)) throw new AutonomyError('BACKGROUND_REQUEST_CHANGED');
    try { const existing = await lstat(receiptPath); if (!existing.isFile() || existing.isSymbolicLink() || !ownedAuthorization(existing)) throw new AutonomyError('BACKGROUND_REQUEST_CHANGED'); }
    catch (error) { if (!isMissing(error)) throw error; }
    const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await output.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await output.sync(); } finally { await output.close(); }
    await rename(temporary, receiptPath);
    const final = await lstat(requestPath);
    if (!sameFile(final, requestIdentity) || !final.isFile() || final.isSymbolicLink() || !ownedAuthorization(final)) throw new AutonomyError('BACKGROUND_REQUEST_CHANGED');
    const verification = await open(requestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!sameFile(await verification.stat(), requestIdentity)) throw new AutonomyError('BACKGROUND_REQUEST_CHANGED');
      const bounded = Buffer.alloc(MAX_REQUEST_BYTES + 1), { bytesRead } = await verification.read(bounded, 0, bounded.length, 0);
      if (bytesRead !== bytes.length || !bounded.subarray(0, bytesRead).equals(bytes)) throw new AutonomyError('BACKGROUND_REQUEST_CHANGED');
    } finally { await verification.close(); }
    await unlink(requestPath);
  } catch { try { await unlink(temporary); } catch { /* retain the durable receipt */ } return { ...receipt, cleanupPending: true }; }
  return receipt;
}
