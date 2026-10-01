/**
 * 同步接线与周期引擎守护网(第 19 轮,Review 阶段 0.5):
 * fake-indexeddb 跑真实 Dexie,锁住两个 P0 修复 ——
 * P0-1:非流水实体冲突不得写入 transactions 表(修复前白屏)
 * P0-2:周期生成确定性 id,重复触发不产生重复流水(修复前多标签页双流水)
 */
import 'fake-indexeddb/auto';
import { describe, beforeAll, it, expect, vi } from 'vitest';

const lsStore = new Map<string, string>();
beforeAll(() => {
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
    setItem: (k: string, v: string) => void lsStore.set(k, String(v)),
    removeItem: (k: string) => void lsStore.delete(k),
    clear: () => void lsStore.clear(),
  };
});

type ConflictHandler = (op: { entity: string; entityId: string; payload: Record<string, unknown> }, conflicts: Array<{ field: string }>) => Promise<void>;

async function conflictHandler(): Promise<ConflictHandler> {
  const { engine } = await import('../src/sync/wiring');
  const h = (engine as unknown as { deps?: { onPushConflict?: ConflictHandler } }).deps?.onPushConflict;
  if (!h) throw new Error('onPushConflict not registered');
  return h;
}

describe('P0-1:onPushConflict 按 entity 分发', () => {
  it('非流水实体(recurring_rule)冲突 → 不写 transactions 表(修复前整行塞入触发白屏)', async () => {
    const { db } = await import('../src/db/db');
    const handler = await conflictHandler();
    const before = await db.transactions.count();
    await handler(
      { entity: 'recurring_rule', entityId: 'r1', payload: { id: 'r1', ledger_id: 'l1', amount: '30', account_id: 'a1', frequency: 'monthly', interval: 1, next_run_at: 1, paused: false, note: null, client_version: 2 } },
      [{ field: 'amount' }],
    );
    expect(await db.transactions.count()).toBe(before); // 流水表零写入
    const dead = await db.deadletter.where('entityId').equals('r1').first();
    expect(dead?.reason).toContain('amount');
  });

  it('流水实体冲突 → 仍生成冲突副本(行为不回归)', async () => {
    const { db } = await import('../src/db/db');
    const handler = await conflictHandler();
    await handler(
      {
        entity: 'transaction', entityId: 'tx-c1',
        payload: { id: 'tx-c1', ledger_id: 'l1', user_id: 'u1', type: 'expense', amount: '30', currency: 'CNY', amount_base: '30', account_id: 'a1', happened_at: 1, note: '', is_refunded: false, exclude_from_budget: false, attachment_count: 0, source: 'manual', client_version: 2, is_deleted: false, deleted_at: null, created_at: 1, updated_at: 1 },
      },
      [{ field: 'amount' }],
    );
    const rows = await db.transactions.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toContain('冲突副本');
    expect(rows[0].id).not.toBe('tx-c1');
  });
});

describe('本地写入与同步队列', () => {
  it('入队失败会回滚业务行', async () => {
    const { db } = await import('../src/db/db');
    const { saveLocal } = await import('../src/sync/wiring');
    const add = vi.spyOn(db.outbox, 'add').mockRejectedValueOnce(new Error('outbox failed'));
    try {
      await expect(saveLocal('transaction', { id: 'atomic-t1', ledger_id: 'l1' })).rejects.toThrow('outbox failed');
      expect(await db.transactions.get('atomic-t1')).toBeUndefined();
    } finally {
      add.mockRestore();
    }
  });
});

describe('P0-2:周期记账幂等', () => {
  it('同一规则同一期重复触发 → 确定性 id(rc_<ruleId>_<at>)覆盖同一行,不产生重复流水', async () => {
    const { db } = await import('../src/db/db');
    const { runDueRecurring } = await import('../src/recurring-engine');
    await Promise.all([db.transactions.clear(), db.recurring_rules.clear(), db.outbox.clear()]); // 与上一 describe 隔离
    const at = Date.now() - 5 * 24 * 60 * 60 * 1000; // 5 天前到期:月频下仅一期待补(下期在未来)
    const rule = {
      id: 'rule-1', ledger_id: 'l1', amount: '100.00', category_id: null, account_id: 'a1',
      note: '房租', frequency: 'monthly' as const, interval: 1, next_run_at: at, paused: false,
      last_run_at: null, client_version: 1, server_version: null, is_deleted: false, deleted_at: null,
      created_at: at, updated_at: at,
    };
    await db.recurring_rules.put(rule as never);

    expect(await runDueRecurring()).toBe(1);
    const ids = (await db.transactions.toArray()).map((t) => t.id);
    expect(ids).toEqual([`rc_rule-1_${at}`]);

    // 模拟多标签页/重启后同一期再次被扫描:重置到期时间再跑,确定性 id 覆盖同一行
    await db.recurring_rules.put({ ...rule } as never);
    await db.recurring_rules.update('rule-1', { next_run_at: at, last_run_at: null });
    expect(await runDueRecurring()).toBe(1);
    const after = await db.transactions.toArray();
    expect(after).toHaveLength(1); // 修复前 newId() 随机 → 这里会是 2
    expect(after[0].id).toBe(`rc_rule-1_${at}`);
  });
});
