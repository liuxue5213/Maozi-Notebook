/**
 * 明细窗口加载守护(P0-3 修复,Review 实证缺陷):
 * 修复前先 limit(300) 再筛选 —— 第 301 条起的老流水永久不可见、关键词搜不到。
 * 用 600 行验证:限外关键词可命中、计数不失真、渲染截断 + truncated 标记、日期下推正确。
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TransactionRow } from '@ledgerone/domain';

const lsStore = new Map<string, string>();
beforeAll(() => {
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (lsStore.get(k) ?? null),
    setItem: (k: string, v: string) => void lsStore.set(k, String(v)),
    removeItem: (k: string) => void lsStore.delete(k),
    clear: () => void lsStore.clear(),
  };
});

const N = 600;
const BASE = Date.UTC(2026, 0, 1);

function tx(i: number): TransactionRow {
  return {
    id: `t${i}`, ledger_id: 'l1', user_id: 'u1', member_id: null, type: 'expense',
    amount: `${(i % 90) + 1}.00`, currency: 'CNY', amount_base: `${(i % 90) + 1}.00`,
    exchange_rate: null, category_id: null, account_id: 'a1', to_account_id: null,
    happened_at: BASE + i * 86_400_000, note: `bulk-${String(i).padStart(4, "0")}`, is_refunded: false, refund_of_id: null,
    reimburse_status: null, exclude_from_budget: false, attachment_count: 0, source: 'manual',
    client_version: 1, server_version: null, is_deleted: false, deleted_at: null,
    created_at: BASE, updated_at: BASE,
  };
}

async function seed(): Promise<void> {
  const { db } = await import('../src/db/db');
  await db.transactions.clear();
  await db.transactions.bulkPut(Array.from({ length: N }, (_, i) => tx(i)));
}

const EMPTY = { keyword: '', min: '', max: '', categoryId: '', accountId: '', from: '', to: '' };

describe('P0-3:明细窗口加载(utils/tx-list)', () => {
  it('600 行:无筛选时渲染截断为 500 + truncated,matchedTotal/totalActive 不失真', async () => {
    await seed();
    const { db } = await import('../src/db/db');
    const { loadTxWindow, TX_DISPLAY_CAP } = await import('../src/utils/tx-list');
    const w = await loadTxWindow(db.transactions, EMPTY, new Map());
    expect(TX_DISPLAY_CAP).toBe(500);
    expect(w.rows).toHaveLength(500);
    expect(w.matchedTotal).toBe(N);
    expect(w.totalActive).toBe(N);
    expect(w.truncated).toBe(true);
    // 倒序:最新(happened_at 最大 = bulk-599)在最前
    expect(w.rows[0].id).toBe('t599');
  });

  it('修复核心:显示上限之外的关键词(第 10 条,老流水)必须能命中(修复前 limit(300) 后搜不到)', async () => {
    const { db } = await import('../src/db/db');
    const { loadTxWindow } = await import('../src/utils/tx-list');
    const w = await loadTxWindow(db.transactions, { ...EMPTY, keyword: 'bulk-0010' }, new Map());
    expect(w.matchedTotal).toBe(1);
    expect(w.rows[0].id).toBe('t10'); // 唯一命中:补零命名避免 bulk-100 子串误匹配
    expect(w.truncated).toBe(false);
  });

  it('日期筛选走范围扫描:仅返回区间内行且计数正确', async () => {
    const { db } = await import('../src/db/db');
    const { loadTxWindow } = await import('../src/utils/tx-list');
    // 按天铺开后,日期区间 [day100 起, day201 起) → i ∈ 100..200 共 101 行(天粒度闭开区间)
    const D = 86_400_000;
    const from = new Date(BASE + 100 * D).toISOString().slice(0, 10);
    const to = new Date(BASE + 200 * D).toISOString().slice(0, 10);
    const w = await loadTxWindow(db.transactions, { ...EMPTY, from, to }, new Map());
    expect(w.matchedTotal).toBe(101);
    expect(w.rows.every((r) => r.happened_at >= BASE + 100 * D)).toBe(true);
    expect(w.rows.every((r) => r.happened_at < BASE + 201 * D)).toBe(true);
    // totalActive 为「扫描窗口(日期范围)内未删除数」:与 matchedTotal 同分母,作诚实命中率分母
    expect(w.totalActive).toBe(101);
  });

  it('软删行不计入任何计数', async () => {
    const { db } = await import('../src/db/db');
    const { loadTxWindow } = await import('../src/utils/tx-list');
    await db.transactions.update('t0', { is_deleted: true, deleted_at: Date.now() });
    const w = await loadTxWindow(db.transactions, EMPTY, new Map());
    expect(w.totalActive).toBe(N - 1);
    expect(w.rows.some((r) => r.id === 't0')).toBe(false);
  });
});
