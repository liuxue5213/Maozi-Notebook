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

/**
 * 启动:打开加密库(SQLCipher)→ 建表 + 本地播种(离线开箱可用,登录后与服务端收敛)。
 * P0-7:失败时清空 ready 缓存并上抛 —— 修复前 rejected promise 被永久缓存导致白屏不可恢复。
 */
/** 供「重置本地数据」清掉 initDb 的完成缓存,否则重置后 initDb 直接返回旧句柄 */
export function resetInitCache(): void {
  ready = null;
}

export function initDb(): Promise<void> {
  ready ??= (async () => {
    try {
      await initEncryptedDb();
      console.log('[boot] encrypted-db:ok');
      await initSchema(db);
      console.log('[boot] schema:ok');
      await ensureSeed();
      console.log('[boot] seed:ok');
    } catch (e) {
      console.log('[boot] initDb failed:', e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
      ready = null;
      throw e;
    }
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

/** 新建账本并播种默认分类/账户(T-03:修复 LedgerManager 只切 active 不播种的缺陷) */
export async function createLedgerWithSeed(name: string, icon = '📒'): Promise<string> {
  const ledgerId = newId();
  const now = Date.now();
  const stamp = () => ({ client_version: 1, server_version: null, is_deleted: false, deleted_at: null, created_at: now, updated_at: now });
  const ledger = { id: ledgerId, owner_user_id: 'local', name, type: 'personal', icon, sort: 0, ...stamp() };
  await saveLocal(db, 'ledger', ledger as never);
  const defs = [
    ...PRESET_EXPENSE_CATEGORIES.map((d) => ({ ...d, kind: 'expense' as const })),
    ...PRESET_INCOME_CATEGORIES.map((d) => ({ ...d, kind: 'income' as const })),
  ];
  let sort = 0;
  for (const d of defs) {
    const topId = newId();
    await saveLocal(db, 'category', { id: topId, ledger_id: ledgerId, parent_id: null, name: d.name, kind: d.kind, icon: d.icon, color: null, sort: sort++, is_hidden: false, is_preset: true, ...stamp() } as never);
    for (const child of d.children) {
      await saveLocal(db, 'category', { id: newId(), ledger_id: ledgerId, parent_id: topId, name: child, kind: d.kind, icon: d.icon, color: null, sort: sort++, is_hidden: false, is_preset: true, ...stamp() } as never);
    }
  }
  const accounts = [
    { name: '现金', type: 'cash' },
    { name: '储蓄卡', type: 'debit_card' },
  ];
  for (let i = 0; i < accounts.length; i++) {
    await saveLocal(db, 'account', { id: newId(), ledger_id: ledgerId, name: accounts[i].name, type: accounts[i].type,
      initial_balance: '0', initial_date: now, currency: DEFAULT_CURRENCY, include_in_net: true, is_archived: false, sort: i,
      credit_bill_day: null, credit_due_day: null, credit_limit: null, balance_cached: null, ...stamp() } as never);
  }
  return ledgerId;
}

async function ensureSeed(): Promise<void> {
  console.log('[boot] seed:meta-get:start');
  if (await metaGet(db, 'seeded')) { console.log('[boot] seed:already'); return; }
  console.log('[boot] seed:meta-get:ok');
  const ledgerId = newId();
  console.log('[boot] seed:newId:ok');
  const ledger = { id: ledgerId, owner_user_id: 'local', name: '我的账本', type: 'personal', icon: '📒', sort: 0, ...stamp() };
  await saveLocal(db, 'ledger', ledger as AnyRow);
  console.log('[boot] seed:ledger:ok');

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
  console.log('[boot] seed:cats+accounts:ok');
  await metaSet(db, 'active_ledger', ledgerId);
  await metaSet(db, 'seeded', true);
  console.log('[boot] seed:meta-set:ok');
}

export async function getActiveLedgerId(): Promise<string> {
  const active = ((await metaGet(db, 'active_ledger')) as string) ?? '';
  if (active) {
    const row = await db.getAllAsync<{ is_deleted: number }>('SELECT is_deleted FROM ledgers WHERE id = ?', [active]);
    if (row[0] && !row[0].is_deleted) return active; // 指向有效账本
  }
  // 兜底与 T-35 对齐口径一致:最早创建且未软删(防止重装/清库后随机落到空壳账本)
  const earliest = await db.getAllAsync<{ id: string }>(
    'SELECT id FROM ledgers WHERE is_deleted = 0 ORDER BY created_at ASC, id ASC LIMIT 1');
  const fallback = earliest[0]?.id ?? '';
  if (fallback && fallback !== active) await metaSet(db, 'active_ledger', fallback);
  return fallback;
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
