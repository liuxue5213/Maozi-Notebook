import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ChangeOp, SyncTransport } from '@ledgerone/domain';
import { SyncEngine } from '@ledgerone/sync';
import {
  createChangeQueue, createRowSink, decodeRow, initSchema, metaGet, metaSet, recentTransactions,
  saveLocal, type SQLiteLike,
} from '../src/index';

function makeDb(): { db: SQLiteLike; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  const db: SQLiteLike = {
    execAsync: (sql) => raw.exec(sql),
    runAsync: (sql, params) => {
      raw.prepare(sql).run(...(params ?? []));
    },
    getAllAsync: (sql, params) => raw.prepare(sql).all(...(params ?? [])) as Record<string, unknown>[],
  };
  return { db, raw };
}

const NOW = Date.now();

function sampleTx(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    ledger_id: 'l1', user_id: 'u1', member_id: null, type: 'expense', amount: '26.00',
    currency: 'CNY', amount_base: '26.00', exchange_rate: null, category_id: null,
    account_id: 'a1', to_account_id: null, happened_at: NOW, note: '', is_refunded: false,
    refund_of_id: null, reimburse_status: null, exclude_from_budget: false, attachment_count: 0,
    source: 'manual', client_version: 1, server_version: null, is_deleted: false,
    deleted_at: null, created_at: NOW, updated_at: NOW, ...overrides,
  };
}

describe('sqlite-sync 建表', () => {
  it('DDL 幂等(跑两次不报错)且表齐全', async () => {
    const { db } = makeDb();
    await initSchema(db);
    await initSchema(db);
    const tables = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    const names = tables.map((t) => t.name);
    for (const t of ['ledgers', 'transactions', 'categories', 'accounts', 'budgets', 'budget_items', 'recurring_rules', 'pending_transactions', 'outbox', 'meta']) {
      expect(names).toContain(t);
    }
  });
});

describe('变更队列', () => {
  it('saveLocal 写行并入队,take/ack/count 正常', async () => {
    const { db } = makeDb();
    await initSchema(db);
    await saveLocal(db, 'transaction', sampleTx('t1'));
    expect(await (await createChangeQueue(db)).count()).toBe(1);
    const batch = await (await createChangeQueue(db)).take(10);
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ entity: 'transaction', entityId: 't1', op: 'upsert', clientVersion: 1 });
    expect(batch[0].payload.amount).toBe('26.00');
    await (await createChangeQueue(db)).ack([batch[0].seq!]);
    expect(await (await createChangeQueue(db)).count()).toBe(0);
  });

  it('软删除入队 op=delete', async () => {
    const { db } = makeDb();
    await initSchema(db);
    await saveLocal(db, 'transaction', sampleTx('t2', { is_deleted: true, deleted_at: NOW, client_version: 2 }), { op: 'delete' });
    const batch = await (await createChangeQueue(db)).take(10);
    expect(batch[0].op).toBe('delete');
  });
});

describe('RowSink 下行落地', () => {
  it('布尔/JSON 规范化入库,decodeRow 还原', async () => {
    const { db } = makeDb();
    await initSchema(db);
    const sink = createRowSink(db);
    await sink.applyServerRow('transaction', sampleTx('srv1', { is_refunded: true, server_version: 5 }));
    const rows = await recentTransactions(db, 'l1');
    expect(rows).toHaveLength(1);
    expect(rows[0].is_refunded).toBe(true); // 1 → true 还原
    expect(rows[0].server_version).toBe(5);

    await sink.applyServerRow('pending_transaction', {
      id: 'p1', ledger_id: 'l1', source_type: 'import', raw: null,
      parsed: { amount: '10', merchant: '星巴克' }, confidence: 0.8, dedupe_hash: 'h1',
      status: 'pending', client_version: 1, server_version: 6, is_deleted: false,
      deleted_at: null, created_at: NOW, updated_at: NOW,
    });
    const p = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM pending_transactions WHERE id = ?', ['p1']);
    expect(typeof p[0].parsed).toBe('string'); // 库里是 JSON 字符串
    expect((decodeRow('pending_transaction', p[0]).parsed as { merchant: string }).merchant).toBe('星巴克');
  });

  it('本地有待推送版本时跳过服务端覆盖', async () => {
    const { db } = makeDb();
    await initSchema(db);
    await saveLocal(db, 'transaction', sampleTx('t3', { note: 'local-edit', client_version: 3 }));
    const sink = createRowSink(db);
    await sink.applyServerRow('transaction', sampleTx('t3', { note: 'server-wins', server_version: 9 }));
    const rows = await recentTransactions(db, 'l1');
    expect(rows[0].note).toBe('local-edit');
  });

  it('游标持久化', async () => {
    const { db } = makeDb();
    await initSchema(db);
    const sink = createRowSink(db);
    await sink.setCursor(123);
    expect(await sink.getCursor()).toBe(123);
    expect(await metaGet(db, 'nothing')).toBeNull();
  });
});

describe('SyncEngine 全链路(真实 SQL)', () => {
  it('上行清空 outbox + 下行落库 + 游标推进', async () => {
    const { db } = makeDb();
    await initSchema(db);
    await metaSet(db, 'sync_cursor', 0);
    await saveLocal(db, 'transaction', sampleTx('t1'));
    await saveLocal(db, 'transaction', sampleTx('t2', { amount: '12.00', amount_base: '12.00', client_version: 1 }));

    const pushed: ChangeOp[][] = [];
    const serverRows = [
      { entity: 'transaction' as const, row: sampleTx('srv1', { server_version: 10 }) },
      { entity: 'category' as const, row: { id: 'c1', ledger_id: 'l1', parent_id: null, name: '餐饮', kind: 'expense', icon: '🍜', color: null, sort: 0, is_hidden: false, is_preset: true, client_version: 1, server_version: 11, is_deleted: false, deleted_at: null, created_at: NOW, updated_at: NOW } },
    ];
    const transport: SyncTransport = {
      push: async (changes) => {
        pushed.push(changes);
        return { results: changes.map((c) => ({ entityId: c.entityId, status: 'applied' as const, serverVersion: 20 })) };
      },
      pull: async () => ({ cursor: 11, hasMore: false, rows: serverRows }),
    };
    const engine = new SyncEngine({ transport, queue: createChangeQueue(db), sink: createRowSink(db) });
    await engine.syncOnce();

    expect(pushed).toHaveLength(1);
    expect(pushed[0].map((c) => c.entityId)).toEqual(['t1', 't2']);
    expect(await (await createChangeQueue(db)).count()).toBe(0);
    expect(await (await createChangeQueue(db) as { count(): Promise<number> }).count()).toBe(0);
    expect(await recentTransactions(db, 'l1')).toHaveLength(3); // t1/t2 + srv1
    expect(await createRowSink(db).getCursor()).toBe(11);
    expect(engine.getSnapshot().state).toBe('idle');
  });
});
