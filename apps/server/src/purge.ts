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
  // P1-34(Review):单事务 —— 中途失败整体回滚,不留半删状态;30 天窗口内同一批表级联删净
  await db.transaction(async (tx: any) => {
    for (const table of PURGE_TABLES) {
      const res = await tx.execute(
        sql.raw(`DELETE FROM ${table} WHERE is_deleted = true AND deleted_at IS NOT NULL AND deleted_at < ${cutoff}`),
      );
      purged += countOf(res);
    }
    // 待确认池里「忽略/已确认」超过 30 天的也一并清理
    const pend = await tx.execute(
      sql.raw(`DELETE FROM pending_transactions WHERE status <> 'pending' AND updated_at < ${cutoff}`),
    );
    purged += countOf(pend);
    // P1-34 补齐:refresh_tokens(过期 + 吊销超 30 天)与 phone_codes(过期超 30 天)此前无清理,单调增长
    const rt = await tx.execute(
      sql.raw(`DELETE FROM refresh_tokens WHERE expires_at < ${cutoff} OR revoked_at IS NOT NULL AND revoked_at < ${cutoff}`),
    );
    purged += countOf(rt);
    const pc = await tx.execute(
      sql.raw(`DELETE FROM phone_codes WHERE expires_at < ${cutoff}`),
    );
    purged += countOf(pc);
  });
  return purged;
}

/** 审计日志保留策略(第 6 轮审查 P3):默认保留 90 天,超期硬删(合规/排查窗口外的历史无审计价值) */
export async function purgeAuditLogs(now = Date.now(), retentionDays = 90): Promise<number> {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const res = await db.execute(sql.raw(`DELETE FROM audit_logs WHERE created_at < ${cutoff}`));
  return countOf(res);
}

/** mysql2 execute 返回 [ResultSetHeader, fields]。 */
function countOf(res: unknown): number {
  return Number((res as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
}
