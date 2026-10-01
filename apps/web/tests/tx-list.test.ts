/**
 * 明细窗口加载守护(P0-3/P0-4,第 22/28 轮):
 * 双下推([ledger_id+happened_at] 复合索引)+ 增量分页(limit 递增)。
 * 600 行 + 跨账本行验证:作用域、分页、hasMore、关键词限外命中、日期边界。
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { TransactionRow } from '@ledgerone/domain';

const N = 600;
const D = 86_400_000;
const BASE = Date.UTC(2026, 0, 1);

function tx(i: number, ledger = 'l1'): TransactionRow {
  const cross = ledger !== 'l1';
  return {
    id: `${cross ? "x" : "t"}${String(i).padStart(4, "0")}`, ledger_id: ledger, user_id: 'u1', member_id: null, type: 'expense',
    amount: `${(i % 90) + 1}.00`, currency: 'CNY', amount_base: `${(i % 90) + 1}.00`,
    exchange_rate: null, category_id: null, account_id: 'a1', to_account_id: null,
    happened_at: BASE + i * D, note: `bulk-${String(i).padStart(4, '0')}`, is_refunded: false, refund_of_id: null,
    reimburse_status: null, exclude_from_budget: false, attachment_count: 0, source: 'manual',
    client_version: 1, server_version: null, is_deleted: false, deleted_at: null,
    created_at: BASE, updated_at: BASE,
  };
}

async function seed(): Promise<void> {
  const { db } = await import('../src/db/db');
  await db.transactions.clear();
  await db.transactions.bulkPut([...Array.from({ length: N }, (_, i) => tx(i)), tx(5, 'l2'), tx(50, 'l2')]);
  // 注意:l2 行必须是独立主键(x 前缀),若复用 t0005/t0050 会覆盖 l1 同名行致计数少 2
  // fake-indexeddb 自动事务归并:沉降一拍,避免上一用例只读扫描事务吞并本用例写入(readonly 误报)
  await new Promise((r) => setTimeout(r, 10));
}

const EMPTY = { keyword: '', min: '', max: '', categoryId: '', accountId: '', from: '', to: '' };

describe('P0-3/P0-4:明细窗口加载(双下推 + 增量分页)', () => {
  // fake-indexeddb:上一用例的只读扫描事务在本用例首写时才提交,先沉降避免 readonly 误报
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
  it('无筛选 limit 500:rows 500、matchedTotal 600、hasMore;不含他账本行', async () => {
    await seed();
    const { db } = await import('../src/db/db');
    const { loadTxWindow, TX_PAGE_SIZE } = await import('../src/utils/tx-list');
    expect(TX_PAGE_SIZE).toBe(50);
    const w = await loadTxWindow(db.transactions, EMPTY, new Map(), 'l1', 500);
    expect(w.rows).toHaveLength(500);
    expect(w.matchedTotal).toBe(N); // 只算 l1 的 600 行
    expect(w.totalActive).toBe(N);
    expect(w.hasMore).toBe(true);
    expect(w.rows.some((r) => r.ledger_id === 'l2')).toBe(false); // l2 两行被作用域排除
    expect(w.rows[0].id).toBe('t0599'); // 倒序
  });

  it('增量加载:limit 600 → 600 行且 hasMore=false(加载更多到底)', async () => {
    await seed();
    const { db } = await import('../src/db/db');
    const { loadTxWindow } = await import('../src/utils/tx-list');
    const w = await loadTxWindow(db.transactions, EMPTY, new Map(), 'l1', 600);
    expect(w.rows).toHaveLength(N);
    expect(w.hasMore).toBe(false);
  });

  it('无日期筛选时按发生时间排序,不受主键顺序影响', async () => {
    await seed();
    const { db } = await import('../src/db/db');
    const { loadTxWindow } = await import('../src/utils/tx-list');
    await db.transactions.put({ ...tx(0), id: 'zz-old', happened_at: BASE - D });
    const w = await loadTxWindow(db.transactions, EMPTY, new Map(), 'l1', 1);
    expect(w.rows[0].id).toBe('t0599');
    expect(w.matchedTotal).toBe(N + 1);
  });

  it('修复核心:首个 50 条之外的老流水(bulk-0010,第 11 新)关键词可命中(修复前 limit 截断后搜不到)', async () => {
    await seed();
    const { db } = await import('../src/db/db');
    const { loadTxWindow } = await import('../src/utils/tx-list');
    const w = await loadTxWindow(db.transactions, { ...EMPTY, keyword: 'bulk-0010' }, new Map(), 'l1', 50);
    expect(w.matchedTotal).toBe(1);
    expect(w.rows[0].id).toBe('t0010');
    expect(w.hasMore).toBe(false);
  });

  it('日期下推走复合索引:本地日期区间 [day100, day201] 命中 102 行且边界正确', async () => {
    await seed();
    const { db } = await import('../src/db/db');
    const { loadTxWindow } = await import('../src/utils/tx-list');
    // 实现按「本地午夜」解析日期串,测试必须用本地日期(ISO 是 UTC,时区差一天会多吞一行)
    const localDate = (ms: number) => new Date(ms).toLocaleDateString('sv-SE');
    const from = localDate(BASE + 100 * D);
    const to = localDate(BASE + 201 * D);
    const w = await loadTxWindow(db.transactions, { ...EMPTY, from, to }, new Map(), 'l1', 500);
    expect(w.matchedTotal).toBe(102); // 本地日粒度:i=100..201(两端均为本地全天)
    // 本地日粒度边界:实现按本地午夜解析,行落在本地 [day100 00:00, day202 00:00) 区间
    const fromTs = new Date(from + 'T00:00:00').getTime();
    const toTs = new Date(to + 'T00:00:00').getTime() + D;
    expect(w.rows.every((r) => r.happened_at >= fromTs && r.happened_at < toTs)).toBe(true);
  });

  it('账本作用域:l2 的同名序号行不串入 l1 结果', async () => {
    await seed();
    const { db } = await import('../src/db/db');
    const { loadTxWindow } = await import('../src/utils/tx-list');
    const w = await loadTxWindow(db.transactions, { ...EMPTY, keyword: 'bulk-0005' }, new Map(), 'l2', 50);
    expect(w.matchedTotal).toBe(1);
    expect(w.rows[0].ledger_id).toBe('l2');
  });
});
