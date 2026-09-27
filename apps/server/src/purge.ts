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
    purged += Number((res as unknown as { rowCount?: number }).rowCount ?? 0);
  }
  // 待确认池里「忽略/已确认」超过 30 天的也一并清理
  await db.execute(sql.raw(`DELETE FROM pending_transactions WHERE status <> 'pending' AND updated_at < ${cutoff}`));
  return purged;
}
