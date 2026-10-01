/**
 * App 端测试骨架(第 27 轮 P0-3):换号三态策略 + outbox base_version 往返。
 * node:sqlite 内存库按 sqlite-sync 的 SQLiteLike 接口包装(与 packages/sqlite-sync 测试同法)。
 */
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { initSchema, metaGet, metaSet, prepareAfterLogin, saveLocal, createChangeQueue, type SQLiteLike } from '@ledgerone/sqlite-sync';

function makeDb(): SQLiteLike {
  const raw = new DatabaseSync(':memory:');
  return {
    execAsync: (sql) => raw.exec(sql),
    runAsync: (sql, params) => {
      raw.prepare(sql).run(...(params ?? []));
    },
    getAllAsync: <T>(sql, params) => raw.prepare(sql).all(...(params ?? [])) as T[],
  };
}

const NOW = Date.now();

function tx(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, ledger_id: 'l1', user_id: 'u1', member_id: null, type: 'expense', amount: '10.00',
    currency: 'CNY', amount_base: '10.00', exchange_rate: null, category_id: null,
    account_id: 'a1', to_account_id: null, happened_at: NOW, note: '', is_refunded: false,
    refund_of_id: null, reimburse_status: null, exclude_from_budget: false, attachment_count: 0,
    source: 'manual', client_version: 1, server_version: null, is_deleted: false,
    deleted_at: null, created_at: NOW, updated_at: NOW, ...over,
  };
}

beforeAll(async () => {
  // module-level init is lazy via initSchema call in each test
});

describe('P0-1 换号三态策略(prepareAfterLogin)', () => {
  it('明确换号(last_user 存在且不同)→ 清库:流水清空、游标归零、local_seeded 保留', async () => {
    const db = makeDb();
    await initSchema(db);
    await metaSet(db, 'local_seeded', true);
    await metaSet(db, 'last_user', 'user-A');
    await metaSet(db, 'sync_cursor', 500);
    await saveLocal(db, 'transaction', tx('t-A') as never);
    const action = await prepareAfterLogin(db, 'user-B');
    expect(action).toBe('wiped');
    expect(Number((await db.getAllAsync('SELECT COUNT(*) AS n FROM transactions'))[0].n)).toBe(0);
    expect(Number(await metaGet(db, 'sync_cursor'))).toBe(0);
    expect(await metaGet(db, 'local_seeded')).toBe(true); // 幽灵账本防线(P1-21)
    expect(await metaGet(db, 'last_user')).toBe('user-B');
  });

  it('纯本地离线数据(无 last_user、游标 0、无服务端行)→ 保留并上行', async () => {
    const db = makeDb();
    await initSchema(db);
    await saveLocal(db, 'transaction', tx('t-offline') as never);
    const action = await prepareAfterLogin(db, 'user-C');
    expect(action).toBe('kept');
    expect(Number((await db.getAllAsync('SELECT COUNT(*) AS n FROM transactions'))[0].n)).toBe(1);
  });

  it('旧账号残留(last_user 缺失但游标 > 0)→ 清库防跨账号可见', async () => {
    const db = makeDb();
    await initSchema(db);
    await metaSet(db, 'sync_cursor', 300); // 有过同步
    const action = await prepareAfterLogin(db, 'user-D');
    expect(action).toBe('wiped');
  });

  it('同账号重登 → 保留本地数据', async () => {
    const db = makeDb();
    await initSchema(db);
    await metaSet(db, 'last_user', 'user-E');
    await saveLocal(db, 'transaction', tx('t-e') as never);
    const action = await prepareAfterLogin(db, 'user-E');
    expect(action).toBe('kept');
    expect(Number((await db.getAllAsync('SELECT COUNT(*) AS n FROM transactions'))[0].n)).toBe(1);
  });
});

describe('P0-2 outbox base_version 往返', () => {
  it('saveLocal 携服务端行 → take 反解 baseVersion;纯本地行 → null', async () => {
    const db = makeDb();
    await initSchema(db);
    // 已同步行(带 server_version)编辑后再入队:base_version = 之前的版本号
    await saveLocal(db, 'transaction', tx('t-sv', { server_version: 42, note: '编辑后' }) as never, {
      base: tx('t-sv', { server_version: 42, note: '编辑前' }) as never,
    });
    await saveLocal(db, 'transaction', tx('t-fresh') as never);
    const ops = await createChangeQueue(db).take(10);
    const withV = ops.find((o) => o.entityId === 't-sv');
    const fresh = ops.find((o) => o.entityId === 't-fresh');
    expect(withV?.baseVersion).toBe(42);
    expect(withV?.base).toMatchObject({ note: '编辑前' });
    expect(fresh?.baseVersion ?? null).toBeNull();
  });
});
