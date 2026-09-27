import { eq, sql } from 'drizzle-orm';
import { newId, PRESET_EXPENSE_CATEGORIES, PRESET_INCOME_CATEGORIES } from '@ledgerone/domain';
import { db } from './db';
import { accounts, categories, ledger_members, ledgers, users } from './schema';
import { AppError } from '../common/errors';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 预留 n 个全局递增序号,返回本次可用起始值(PRD 5.4 下行增量依据 users.version_seq) */
export async function reserveSeq(tx: any, userId: string, n: number): Promise<number> {
  const rows = await tx
    .update(users)
    .set({ version_seq: sql`${users.version_seq} + ${n}` })
    .where(eq(users.id, userId))
    .returning({ seq: users.version_seq });
  if (!rows.length) throw new AppError('sync.user.404', 404, '用户不存在');
  return rows[0].seq - n + 1;
}

export async function getUserSeq(userId: string): Promise<number> {
  const rows = await db.select({ seq: users.version_seq }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0]?.seq ?? 0;
}

/** 为新账本播种:owner 成员 + 预置分类(M03-F01)+ 现金/储蓄卡默认账户,全部盖 server_version 使其可下行 */
export async function seedDefaultLedger(
  tx: any,
  userId: string,
  name = '我的账本',
  type: string = 'personal',
): Promise<string> {
  const now = Date.now();
  const ledgerId = newId();
  const defs = [
    ...PRESET_EXPENSE_CATEGORIES.map((d) => ({ ...d, kind: 'expense' })),
    ...PRESET_INCOME_CATEGORIES.map((d) => ({ ...d, kind: 'income' })),
  ];
  const childCount = defs.reduce((acc, d) => acc + d.children.length, 0);
  const total = 1 + 1 + defs.length + childCount + 2;
  let seq = await reserveSeq(tx, userId, total);
  const stamp = () => ({ client_version: 1, server_version: seq++, is_deleted: false, created_at: now, updated_at: now });

  await tx.insert(ledgers).values({ id: ledgerId, owner_user_id: userId, name, type, icon: '📒', sort: 0, ...stamp() });
  await tx
    .insert(ledger_members)
    .values({ id: newId(), ledger_id: ledgerId, user_id: userId, role: 'owner', joined_at: now, ...stamp() });

  const catRows: Record<string, unknown>[] = [];
  let sort = 0;
  for (const d of defs) {
    const topId = newId();
    catRows.push({ id: topId, ledger_id: ledgerId, parent_id: null, name: d.name, kind: d.kind, icon: d.icon, sort: sort++, is_hidden: false, is_preset: true, ...stamp() });
    for (const child of d.children) {
      catRows.push({ id: newId(), ledger_id: ledgerId, parent_id: topId, name: child, kind: d.kind, icon: d.icon, sort: sort++, is_hidden: false, is_preset: true, ...stamp() });
    }
  }
  await tx.insert(categories).values(catRows);

  await tx.insert(accounts).values([
    { id: newId(), ledger_id: ledgerId, name: '现金', type: 'cash', initial_balance: '0', initial_date: now, currency: 'CNY', include_in_net: true, is_archived: false, sort: 0, ...stamp() },
    { id: newId(), ledger_id: ledgerId, name: '储蓄卡', type: 'debit_card', initial_balance: '0', initial_date: now, currency: 'CNY', include_in_net: true, is_archived: false, sort: 1, ...stamp() },
  ]);
  return ledgerId;
}

/** 首次拉取前:无任何账本成员关系则播种默认账本(注册即用;若客户端已上行本地账本则跳过,见 D04) */
export async function bootstrapIfNeeded(userId: string): Promise<void> {
  const m = await db.select({ id: ledger_members.id }).from(ledger_members).where(eq(ledger_members.user_id, userId)).limit(1);
  if (m.length) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
    const again = await tx.select({ id: ledger_members.id }).from(ledger_members).where(eq(ledger_members.user_id, userId)).limit(1);
    if (again.length) return;
    await seedDefaultLedger(tx, userId);
  });
}
