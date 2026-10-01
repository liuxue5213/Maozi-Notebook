import { eq, max, sql } from 'drizzle-orm';
import { newId, PRESET_EXPENSE_CATEGORIES, PRESET_INCOME_CATEGORIES } from '@ledgerone/domain';
import { db } from './db';
import * as s from './schema';
import { AppError } from '../common/errors';

/* eslint-disable @typescript-eslint/no-explicit-any */

const GLOBAL_SEQ_ID = 'global';

/** 参与序号命名空间的表:13 个同步实体 + sync_changes(其 server_version 同源自 nextSeq) */
const SEQ_TABLES: any[] = [
  s.ledgers, s.ledger_members, s.accounts, s.categories, s.tags, s.transactions,
  s.budgets, s.budget_items, s.recurring_rules, s.attachments, s.pending_transactions,
  s.debts, s.reimbursements, s.sync_changes,
];

/**
 * 预留 n 个**全局**递增序号,返回本次可用起始值(PRD 5.4 下行增量依据 server_version)。
 *
 * P0-4 修复:原实现按「每用户一行计数器」(users.version_seq)分配,而 pull 用单一游标
 * **跨共享账本成员**消费所有成员写入的行 —— 两个成员计数器彼此独立,后加入成员的行号
 * 必然小于先加入者已推进的游标,导致其数据永不下发(第 20 轮 it.fails 已固化该缺陷)。
 * 改为单行全局计数器后所有行共享同一单调命名空间,单游标即可正确消费,
 * 且 `PullResponse` 协议不变、三端零改造。
 */
export async function reserveSeq(tx: any, n: number): Promise<number> {
  await tx
    .update(s.sync_seq)
    .set({ seq: sql`${s.sync_seq.seq} + ${n}` })
    .where(eq(s.sync_seq.id, GLOBAL_SEQ_ID));
  const rows = await tx.select({ seq: s.sync_seq.seq }).from(s.sync_seq).where(eq(s.sync_seq.id, GLOBAL_SEQ_ID)).limit(1);
  if (!rows.length) {
    throw new AppError('sync.seq.500', 500, '全局同步序号未初始化(应先执行 ensureGlobalSeq)');
  }
  return Number(rows[0].seq) - n + 1;
}

export async function getUserSeq(): Promise<number> {
  const rows = await db.select({ seq: s.sync_seq.seq }).from(s.sync_seq).where(eq(s.sync_seq.id, GLOBAL_SEQ_ID)).limit(1);
  return Number(rows[0]?.seq ?? 0);
}

/**
 * 初始化全局序号(启动期调用一次,幂等)。
 *
 * 迁移到全局序号前,存量行的 server_version 来自**各用户独立**的计数器(如 u1:1..82、u2:1..5),
 * 两个命名空间彼此重叠。若新序号从 0 起,新写入的行号会落在客户端已有游标之下 → 永不下发。
 * 因此初值取「全库现有最大 server_version + 1」,保证新分配值严格大于任何已同步过的游标。
 * 重复执行取 GREATEST,不会把已推进的序号回退。
 */
export async function ensureGlobalSeq(): Promise<number> {
  return db.transaction(async (tx: any) => {
    let floor = 0;
    for (const t of SEQ_TABLES) {
      const r = (await tx.select({ m: max(t.server_version) }).from(t))[0] as { m: unknown } | undefined;
      floor = Math.max(floor, Number(r?.m ?? 0));
    }
    const start = floor + 1;
    await tx.insert(s.sync_seq)
      .values({ id: GLOBAL_SEQ_ID, seq: start })
      .onDuplicateKeyUpdate({ set: { seq: sql`GREATEST(${s.sync_seq.seq}, ${start})` } });
    const current = await tx.select({ seq: s.sync_seq.seq }).from(s.sync_seq).where(eq(s.sync_seq.id, GLOBAL_SEQ_ID)).limit(1);
    return Number(current[0].seq);
  });
}

/**
 * 写串行化锁(P0-4 ②):序号在事务**提交前**预留,并发下会出现「预留早但提交晚」的行
 * (如 A 预留 100 后提交慢、B 预留 116 先提交,客户端游标推进到 116 后,A 的 100 被永久跳过)。
 *
 * 本锁在每个写事务开头锁住 sync_seq 单行,事务结束时自动释放,
 * 使「预留顺序 == 提交顺序」,消除上述空洞。
 *
 * 已知取舍:这是**全库单写锁**,所有同步写入被串行。当前目标规模(单用户/小家庭共享、
 * 约 1000 条/月、低并发)下开销可忽略;若将来写并发显著上升,应改为按账本分配序号
 * 并重设计游标或引入提交水位表。
 */
export async function lockGlobalWrite(tx: any): Promise<void> {
  const rows = await tx.select({ id: s.sync_seq.id }).from(s.sync_seq).where(eq(s.sync_seq.id, GLOBAL_SEQ_ID)).for('update');
  if (!rows.length) throw new AppError('sync.seq.500', 500, '全局同步序号未初始化');
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
  await lockGlobalWrite(tx);
  let seq = await reserveSeq(tx, total);
  const stamp = () => ({ client_version: 1, server_version: seq++, is_deleted: false, created_at: now, updated_at: now });

  await tx.insert(s.ledgers).values({ id: ledgerId, owner_user_id: userId, name, type, icon: '📒', sort: 0, ...stamp() });
  await tx
    .insert(s.ledger_members)
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
  await tx.insert(s.categories).values(catRows);

  await tx.insert(s.accounts).values([
    { id: newId(), ledger_id: ledgerId, name: '现金', type: 'cash', initial_balance: '0', initial_date: now, currency: 'CNY', include_in_net: true, is_archived: false, sort: 0, ...stamp() },
    { id: newId(), ledger_id: ledgerId, name: '储蓄卡', type: 'debit_card', initial_balance: '0', initial_date: now, currency: 'CNY', include_in_net: true, is_archived: false, sort: 1, ...stamp() },
  ]);
  return ledgerId;
}

/** 首次拉取前:无任何账本成员关系则播种默认账本(注册即用;若客户端已上行本地账本则跳过,见 D04) */
export async function bootstrapIfNeeded(userId: string): Promise<void> {
  const m = await db.select({ id: s.ledger_members.id }).from(s.ledger_members).where(eq(s.ledger_members.user_id, userId)).limit(1);
  if (m.length) return;
  await db.transaction(async (tx) => {
    await tx.select({ id: s.users.id }).from(s.users).where(eq(s.users.id, userId)).for('update');
    const again = await tx.select({ id: s.ledger_members.id }).from(s.ledger_members).where(eq(s.ledger_members.user_id, userId)).limit(1);
    if (again.length) return;
    await seedDefaultLedger(tx, userId);
  });
}
