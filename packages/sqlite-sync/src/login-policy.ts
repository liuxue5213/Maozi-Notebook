import { metaGet, metaSet } from './index';
import type { SQLiteLike } from './types';

/** 参与换号清库的同步实体表(P1-3 同口径:全部 13 实体 + outbox + deadletter) */
const WIPE_TABLES = [
  'ledgers', 'ledger_members', 'accounts', 'categories', 'tags', 'transactions',
  'budgets', 'budget_items', 'recurring_rules', 'attachments', 'pending_transactions',
  'debts', 'reimbursements', 'outbox', 'deadletter',
] as const;

/**
 * 清空本地同步数据(P0-1,第 27 轮从 web wiring.ts 上提):
 * 全实体表 + outbox + deadletter 清空,游标归零;
 * **保留 local_seeded** —— 丢失该标记会导致下次启动重复播种幽灵账本并上行(第 24 轮 P1-21)。
 */
export async function wipeAllTables(db: SQLiteLike): Promise<void> {
  const seeded = await metaGet(db, 'local_seeded');
  for (const t of WIPE_TABLES) {
    await db.runAsync(`DELETE FROM ${t}`);
  }
  await metaSet(db, 'sync_cursor', 0);
  if (seeded != null) await metaSet(db, 'local_seeded', seeded);
}

/**
 * 登录后的三态处理(与 web prepareAfterLogin 同一策略,SQLite 实现):
 * 1) last_user 存在且 ≠ 新 uid → 明确换号:清库;
 * 2) last_user 缺失:区分「纯本地离线数据」(游标 0 且无任何服务端行 → 保留并上行,离线优先)
 *    与「旧账号残留」(游标 > 0 或存在服务端行 → 清库,防跨账号可见与游标污染);
 * 3) 同账号重登:保留本地数据。
 */
export async function prepareAfterLogin(db: SQLiteLike, userId: string): Promise<'kept' | 'wiped'> {
  const last = (await metaGet(db, 'last_user')) as string | undefined;
  let action: 'kept' | 'wiped' = 'kept';
  if (last && last !== userId) {
    await wipeAllTables(db);
    action = 'wiped';
  } else if (!last) {
    const cursor = Number((await metaGet(db, 'sync_cursor')) ?? 0);
    const serverRows = await db.getAllAsync<{ n: number }>(
      'SELECT (SELECT COUNT(*) FROM ledgers WHERE server_version IS NOT NULL) + (SELECT COUNT(*) FROM transactions WHERE server_version IS NOT NULL) AS n',
    );
    const hasServerRows = Number(serverRows[0]?.n ?? 0) > 0;
    if (cursor > 0 || hasServerRows) {
      await wipeAllTables(db);
      action = 'wiped';
    }
  }
  await metaSet(db, 'last_user', userId);
  return action;
}
