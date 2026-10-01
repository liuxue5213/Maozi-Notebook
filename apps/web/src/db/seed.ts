import {
  DEFAULT_CURRENCY, newId,
  PRESET_EXPENSE_CATEGORIES, PRESET_INCOME_CATEGORIES,
  type AccountRow, type CategoryRow,
} from '@ledgerone/domain';
import { db } from './db';
import { enqueue } from '../sync/wiring';

/** 未登录开箱可用:本地播种默认账本 + 预置分类 + 默认账户;登录后由服务端数据接管(README · 离线优先) */
export async function ensureLocalSeed(): Promise<void> {
  const flag = await db.meta.get('local_seeded');
  if (flag) return;
  const ledgerId = await createLedgerLocally('我的账本');
  await db.meta.bulkPut([
    { key: 'local_seeded', value: true },
    { key: 'active_ledger', value: ledgerId },
  ]);
}

/**
 * 本地新建账本(M02 多账本,第 14 轮):账本 + 预置分类 + 默认账户一并落库并入队上行,
 * 服务端自动建立 owner 成员关系(与开箱播种同链路)。返回新账本 id。
 */
export async function createLedgerLocally(name: string, icon = '📒'): Promise<string> {
  const now = Date.now();
  const ledgerId = newId();
  const stamp = () => ({
    client_version: 1, server_version: null as number | null, is_deleted: false,
    deleted_at: null as number | null, created_at: now, updated_at: now,
  });
  const defs = [
    ...PRESET_EXPENSE_CATEGORIES.map((d) => ({ ...d, kind: 'expense' as const })),
    ...PRESET_INCOME_CATEGORIES.map((d) => ({ ...d, kind: 'income' as const })),
  ];
  const cats: CategoryRow[] = [];
  let sort = 0;
  for (const d of defs) {
    const topId = newId();
    cats.push({ id: topId, ledger_id: ledgerId, parent_id: null, name: d.name, kind: d.kind, icon: d.icon, color: null, sort: sort++, is_hidden: false, is_preset: true, ...stamp() });
    for (const child of d.children) {
      cats.push({ id: newId(), ledger_id: ledgerId, parent_id: topId, name: child, kind: d.kind, icon: d.icon, color: null, sort: sort++, is_hidden: false, is_preset: true, ...stamp() });
    }
  }
  const ledgerRow = { id: ledgerId, owner_user_id: 'local', name, type: 'personal' as const, icon, sort: 0, ...stamp() };
  const accountRows = [
    { id: newId(), ledger_id: ledgerId, name: '现金', type: 'cash' as const, initial_balance: '0', initial_date: now, currency: DEFAULT_CURRENCY, include_in_net: true, is_archived: false, sort: 0, credit_bill_day: null, credit_due_day: null, credit_limit: null, balance_cached: null, ...stamp() },
    { id: newId(), ledger_id: ledgerId, name: '储蓄卡', type: 'debit_card' as const, initial_balance: '0', initial_date: now, currency: DEFAULT_CURRENCY, include_in_net: true, is_archived: false, sort: 1, credit_bill_day: null, credit_due_day: null, credit_limit: null, balance_cached: null, ...stamp() },
  ];
  await db.transaction('rw', db.ledgers, db.categories, db.accounts, db.outbox, async () => {
    await db.ledgers.put(ledgerRow);
    await db.categories.bulkPut(cats);
    await db.accounts.bulkPut(accountRows);
    // 播种与全部同步消息一起提交,避免登录时引用缺失的账本或分类。
    await enqueue('ledger', ledgerRow as unknown as Record<string, unknown>);
    for (const c of cats) await enqueue('category', c as unknown as Record<string, unknown>);
    for (const a of accountRows) await enqueue('account', a as unknown as Record<string, unknown>);
  });
  return ledgerId;
}

export async function getActiveLedgerId(): Promise<string> {
  const v = (await db.meta.get('active_ledger'))?.value;
  if (typeof v === 'string' && v) return v;
  const first = await db.ledgers.orderBy('id').first();
  return first?.id ?? '';
}
