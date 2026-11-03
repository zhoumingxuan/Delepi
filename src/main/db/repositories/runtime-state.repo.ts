/**
 * 跨表运行时状态重置（事务完整性）
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

    // 保持仅 running：Delepi context_compressions CHECK 无 failed 态（schema.sql）
    db.prepare(`
      DELETE FROM context_compressions
      WHERE status = 'running'
    `).run();
  })();
}
