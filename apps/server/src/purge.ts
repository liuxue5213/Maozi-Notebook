import { sql } from 'drizzle-orm';
import { db } from './db/db';

/** 回收站 30 天清理(PRD M01-F12/全检 #13):硬删软删超过 30 天的行(客户端残留本地行不受影响) */
const PURGE_TABLES = [
  'transactions', 'categories', 'accounts', 'budgets', 'budget_items', 'recurring_rules',
  'attachments', 'debts', 'reimbursements', 'ledger_members', 'ledgers',
] as const;

export async function purgeRecycleBin(now = Date.now()): Promise<number> {
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  let purged = 0;
  for (const table of PURGE_TABLES) {
    const res = await db.execute(
      sql.raw(`DELETE FROM ${table} WHERE is_deleted = true AND deleted_at IS NOT NULL AND deleted_at < ${cutoff}`),
    );
    purged += countOf(res);
  }
  // 待确认池里「忽略/已确认」超过 30 天的也一并清理
  await db.execute(sql.raw(`DELETE FROM pending_transactions WHERE status <> 'pending' AND updated_at < ${cutoff}`));
  return purged;
}

/** 审计日志保留策略(第 6 轮审查 P3):默认保留 90 天,超期硬删(合规/排查窗口外的历史无审计价值) */
export async function purgeAuditLogs(now = Date.now(), retentionDays = 90): Promise<number> {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const res = await db.execute(sql.raw(`DELETE FROM audit_logs WHERE created_at < ${cutoff}`));
  return countOf(res);
}

/** 影响行数:node-postgres 是 rowCount,PGlite 是 affectedRows(此前只读 rowCount,PGlite 上恒为 0) */
function countOf(res: unknown): number {
  const r = res as { rowCount?: number; affectedRows?: number };
  return Number(r.affectedRows ?? r.rowCount ?? 0);
}
