/**
 * 跨表运行时状态重置
 * 从 repository.ts 拆分，保留事务完整性
 * ★ S4（M7）：对齐 ai_fr sqlite-adapter.ts:621-639 收敛为 2 SQL
 *   （委派任务表 failed 化与 messages loading→abort 重写随 S4 读取链摘除删除）
 */

import { getDb } from '../sqlite-adapter';

export function resetInterruptedRuntimeState(): void {
  const db = getDb();

  db.transaction(() => {
    db.prepare(`
      UPDATE conversations
      SET is_running = 0
      WHERE is_running <> 0
    `).run();

    // 保持仅 running：Delepi context_compressions CHECK 无 failed 态（schema.sql），与 ai_fr 差异登记
    db.prepare(`
      DELETE FROM context_compressions
      WHERE status = 'running'
    `).run();
  })();
}
