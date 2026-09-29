import {
  DEFAULT_CURRENCY, newId,
  PRESET_EXPENSE_CATEGORIES, PRESET_INCOME_CATEGORIES,
  type CategoryRow,
} from '@ledgerone/domain';
import {
  initSchema, metaGet, metaSet, recentTransactions, saveLocal, type AnyRow, type SQLiteLike,
} from '@ledgerone/sqlite-sync';
import { db, initEncryptedDb } from './db';

let ready: Promise<void> | null = null;

/** 启动:打开加密库(SQLCipher)→ 建表 + 本地播种(离线开箱可用,登录后与服务端收敛) */
export function initDb(): Promise<void> {
  ready ??= (async () => {
    await initEncryptedDb();
    await initSchema(db);
    await ensureSeed();
  })();
  return ready;
}

interface Stamp {
  client_version: number;
  server_version: null;
  is_deleted: false;
  deleted_at: null;
  created_at: number;
  updated_at: number;
}

function stamp(): Stamp {
  const now = Date.now();
  return { client_version: 1, server_version: null, is_deleted: false, deleted_at: null, created_at: now, updated_at: now };
}

async function ensureSeed(): Promise<void> {
  if (await metaGet(db, 'seeded')) return;
  const ledgerId = newId();
  const ledger = { id: ledgerId, owner_user_id: 'local', name: '我的账本', type: 'personal', icon: '📒', sort: 0, ...stamp() };
  await saveLocal(db, 'ledger', ledger as AnyRow);

  const defs = [
    ...PRESET_EXPENSE_CATEGORIES.map((d) => ({ ...d, kind: 'expense' as const })),
    ...PRESET_INCOME_CATEGORIES.map((d) => ({ ...d, kind: 'income' as const })),
  ];
  let sort = 0;
  for (const d of defs) {
    const cat: CategoryRow = {
      id: newId(), ledger_id: ledgerId, parent_id: null, name: d.name, kind: d.kind,
      icon: d.icon, color: null, sort: sort++, is_hidden: false, is_preset: true,
      client_version: 1, server_version: null, is_deleted: false, deleted_at: null,
      created_at: Date.now(), updated_at: Date.now(),
    };
    await saveLocal(db, 'category', cat as unknown as AnyRow);
  }
  const accounts = [
    { name: '现金', type: 'cash' },
    { name: '储蓄卡', type: 'debit_card' },
  ];
  for (let i = 0; i < accounts.length; i++) {
    const a = {
      id: newId(), ledger_id: ledgerId, name: accounts[i].name, type: accounts[i].type,
      initial_balance: '0', initial_date: Date.now(), currency: DEFAULT_CURRENCY,
      include_in_net: true, is_archived: false, sort: i, credit_bill_day: null,
      credit_due_day: null, credit_limit: null, balance_cached: null, ...stamp(),
    };
    await saveLocal(db, 'account', a as AnyRow);
  }
  await metaSet(db, 'active_ledger', ledgerId);
  await metaSet(db, 'seeded', true);
}

export async function getActiveLedgerId(): Promise<string> {
  return ((await metaGet(db, 'active_ledger')) as string) ?? '';
}

export async function saveTx(row: AnyRow, base?: AnyRow | null): Promise<void> {
  // base = 编辑时所见的行快照:三方合并(第 13 轮协议)公共祖先;新增流水无 base(走 LWW 路径)
  await saveLocal(db, 'transaction', row, { base: base ?? null });
}

export async function listRecent(limit = 50): Promise<AnyRow[]> {
  return recentTransactions(db, await getActiveLedgerId(), limit);
}

export async function topCategories(kind: 'expense' | 'income', limit = 12): Promise<AnyRow[]> {
  const ledgerId = await getActiveLedgerId();
  return db.getAllAsync(
    'SELECT * FROM categories WHERE ledger_id = ? AND parent_id IS NULL AND kind = ? AND is_deleted = 0 AND is_hidden = 0 ORDER BY sort LIMIT ?',
    [ledgerId, kind, limit],
  );
}

export { db, metaGet, metaSet };
export type { SQLiteLike };
