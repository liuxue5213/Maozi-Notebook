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
  const ledgerRow = { id: ledgerId, owner_user_id: 'local', name: '我的账本', type: 'personal' as const, icon: '📒', sort: 0, ...stamp() };
  const accountRows = [
    { id: newId(), ledger_id: ledgerId, name: '现金', type: 'cash' as const, initial_balance: '0', initial_date: now, currency: DEFAULT_CURRENCY, include_in_net: true, is_archived: false, sort: 0, credit_bill_day: null, credit_due_day: null, credit_limit: null, balance_cached: null, ...stamp() },
    { id: newId(), ledger_id: ledgerId, name: '储蓄卡', type: 'debit_card' as const, initial_balance: '0', initial_date: now, currency: DEFAULT_CURRENCY, include_in_net: true, is_archived: false, sort: 1, credit_bill_day: null, credit_due_day: null, credit_limit: null, balance_cached: null, ...stamp() },
  ];
  await db.transaction('rw', db.ledgers, db.categories, db.accounts, db.meta, async () => {
    await db.ledgers.put(ledgerRow);
    await db.categories.bulkPut(cats);
    await db.accounts.bulkPut(accountRows);
    await db.meta.bulkPut([
      { key: 'local_seeded', value: true },
      { key: 'active_ledger', value: ledgerId },
    ]);
  });
  // 播种即入队:登录后账本/分类/账户随流水一起上行,服务端自动建立 owner 成员关系
  // (否则「离线记账 → 登录」路径下,本地流水引用的账本在服务端不存在,会被 403 拒收)
  enqueue('ledger', ledgerRow as unknown as Record<string, unknown>);
  for (const c of cats) enqueue('category', c as unknown as Record<string, unknown>);
  for (const a of accountRows) enqueue('account', a as unknown as Record<string, unknown>);
}

export async function getActiveLedgerId(): Promise<string> {
  const v = (await db.meta.get('active_ledger'))?.value;
  if (typeof v === 'string' && v) return v;
  const first = await db.ledgers.orderBy('id').first();
  return first?.id ?? '';
}
