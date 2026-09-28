/**
 * 端侧字段加密(F-05)单元测试:不依赖 IndexedDB —— 用内存 dbcore 伪造底层表,
 * 走真实中间件与密钥生命周期(真实 WebCrypto),覆盖:落盘密文、读取明文、
 * 幂等、AAD 绑定、锁定态、游标路径、outbox 内嵌载荷、开关迁移清扫、错误 PIN。
 */
import { describe, beforeAll, it, expect } from 'vitest';
import type { DBCore, DBCoreCursor, DBCoreTable } from 'dexie';
import { installFieldEncryption, CIPHER_PREFIX } from '../src/crypto/secure-fields';
import {
  enableFieldEncryption, disableFieldEncryption, unlockFieldEncryption, lockFieldEncryption,
  fieldEncryptionConfigured, bindSweepTables, fieldEncryptionUnlocked,
} from '../src/crypto/keyring';

/* ---------------- localStorage 桩(Node 测试环境无 DOM) ---------------- */
const lsStore = new Map<string, string>();
beforeAll(() => {
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
    setItem: (k: string, v: string) => void lsStore.set(k, String(v)),
    removeItem: (k: string) => void lsStore.delete(k),
    clear: () => void lsStore.clear(),
  };
});

/* ---------------- 内存 dbcore 伪造 ---------------- */
interface Store {
  tables: Map<string, Map<string, Record<string, unknown>>>;
  outboxSeq: number;
}

function makeEnv() {
  const store: Store = {
    tables: new Map([['transactions', new Map()], ['pending_transactions', new Map()], ['outbox', new Map()]]),
    outboxSeq: 0,
  };

  // 清扫目标注入:直接读写内存 Map(绕过中间件,与浏览器里「bulkPut 走中间件但值已带密文前缀」效果一致)
  bindSweepTables(Object.fromEntries(
    [...store.tables.keys()].map((name) => [
      name,
      {
        toArray: async () => [...store.tables.get(name)!.values()].map((r) => structuredClone(r)),
        bulkPut: async (rows: unknown[]) => {
          for (const r of rows as Record<string, unknown>[]) {
            const key = r['id'] ?? r['entityId'] ?? ++store.outboxSeq;
            store.tables.get(name)!.set(String(key), r);
          }
        },
      },
    ]),
  ));

  const nativeCursor = (rows: Record<string, unknown>[], values: boolean): DBCoreCursor => {
    let pos = -1;
    let started = false;
    let stopped = false;
    let stepFn: () => void = () => undefined;
    let resolveStart: (v?: unknown) => void = () => undefined;
    const step = () => {
      if (stopped) return;
      if (!started) {
        started = true;
        pos++; // 首步:从 -1 推进到 0(continue 已自行推进,不重复)
      }
      if (pos >= rows.length) {
        stopped = true;
        resolveStart();
        return;
      }
      stepFn();
    };
    return {
      trans: {} as never,
      get key() {
        return rows[pos]?.['id'];
      },
      get primaryKey() {
        return rows[pos]?.['id'];
      },
      get value() {
        return values ? rows[pos] : undefined;
      },
      get done() {
        return stopped || pos >= rows.length;
      },
      continue() {
        if (stopped) return;
        pos++;
        queueMicrotask(step);
      },
      continuePrimaryKey() {
        throw new Error('not implemented in fake');
      },
      advance() {
        throw new Error('not implemented in fake');
      },
      start(onNext: () => void) {
        return new Promise((resolve) => {
          resolveStart = resolve;
          stepFn = onNext;
          queueMicrotask(step);
        });
      },
      stop(value?: unknown) {
        stopped = true;
        resolveStart(value);
      },
      next() {
        pos++;
        return Promise.resolve({ ...this, done: pos >= rows.length } as DBCoreCursor);
      },
      fail(e: Error) {
        stopped = true;
        resolveStart();
        throw e;
      },
    };
  };

  const makeTable = (name: string): DBCoreTable => {
    const map = store.tables.get(name)!;
    return {
      name,
      schema: {
        name,
        primaryKey: { name: name === "outbox" ? "seq" : "id", keyPath: name === "outbox" ? "seq" : "id", isPrimaryKey: true, outbound: true, unique: true, extractKey: (() => undefined) as never },
        indexes: [],
        getIndexByKeyPath: () => undefined,
      },
      async mutate(req: { type: string; values?: Record<string, unknown>[]; keys?: unknown[] }) {
        if (req.type === 'add' || req.type === 'put') {
          const results: unknown[] = [];
          (req.values ?? []).forEach((v, i) => {
            let key = req.keys?.[i] ?? v['id'] ?? v['seq'];
            if (key === undefined) key = ++store.outboxSeq;
            if (name === 'outbox' && typeof key === 'number') v['seq'] = key; // Dexie 自增主键回写(inbound pk)
            map.set(String(key), v);
            results.push(key);
          });
          return { numFailures: 0, failures: {}, lastResult: results[results.length - 1], results };
        }
        map.clear();
        return { numFailures: 0, failures: {}, lastResult: null };
      },
      async get(req: { key: unknown }) {
        const hit = map.get(String(req.key));
        return hit ? structuredClone(hit) : undefined; // IDB 语义:读取返回副本
      },
      async getMany(req: { keys: unknown[] }) {
        return req.keys.map((k) => { const hit = map.get(String(k)); return hit ? structuredClone(hit) : undefined; });
      },
      async query(req: { values?: boolean }) {
        const rows = [...map.values()].map((r) => structuredClone(r));
        return { result: req.values === false ? rows.map((r) => r['id']) : rows };
      },
      async openCursor(req: { values?: boolean }) {
        return nativeCursor([...map.values()].map((r) => structuredClone(r)), req.values !== false);
      },
      async count() {
        return map.size;
      },
    } as unknown as DBCoreTable;
  };

  const down = {
    schema: { name: "ledgerone", tables: [] },
    table: (name: string) => makeTable(name),
  } as unknown as DBCore;

  let core: DBCore | undefined;
  installFieldEncryption({ use: (m) => void (core = m.create(down) as DBCore) });
  if (!core) throw new Error('middleware create failed');

  // 清扫目标:走包裹后的 core(与浏览器中「Dexie 表 = 经中间件」一致:读得明文、写经加密)
  bindSweepTables(Object.fromEntries(
    [...store.tables.keys()].map((name) => {
      const t = core!.table(name);
      return [
        name,
        {
          toArray: async () => {
            const res = await t.query({ trans: {} as never, values: true, limit: undefined, query: { index: t.schema.primaryKey, range: undefined as never } });
            return res.result as Record<string, unknown>[];
          },
          bulkPut: async (rows: unknown[]) => {
            await t.mutate({ type: 'put', trans: {} as never, values: rows as Record<string, unknown>[] });
          },
        },
      ];
    }),
  ));
  return { store, core };
}

const env = makeEnv();
const txCore = () => env.core.table('transactions');
const pendCore = () => env.core.table('pending_transactions');
const outboxCore = () => env.core.table('outbox');

/** 消费回放游标,收集全部 value */
async function drain(core: DBCoreTable): Promise<Record<string, unknown>[]> {
  const cursor = await core.openCursor({ trans: {} as never, values: true, query: { index: { keyPath: "id", name: null, isPrimaryKey: true, unique: false, extractKey: () => undefined as never }, range: undefined as never } });
  if (!cursor) return [];
  const out: Record<string, unknown>[] = [];
  await cursor.start(() => {
    out.push(cursor.value as Record<string, unknown>);
    cursor.continue();
  });
  return out;
}

/* ---------------- 用例 ---------------- */

describe('F-05 端侧字段加密', () => {
  it('未开启应用锁:字段保持明文', async () => {
    await txCore().mutate({ type: 'put', trans: {} as never, values: [{ id: 't1', note: 'hello', amount: '1' }] });
    const row = (await txCore().get({ trans: {} as never, key: 't1' })) as Record<string, unknown>;
    expect(row.note).toBe('hello');
    expect(fieldEncryptionConfigured()).toBe(false);
    expect(fieldEncryptionUnlocked()).toBe(false);
  });

  it('开启应用锁:落盘密文、读取明文;调用方对象不被改动', async () => {
    await enableFieldEncryption('123456');
    expect(fieldEncryptionUnlocked()).toBe(true);
    const input = { id: 't2', note: '工资 8000', amount: '2' };
    await txCore().mutate({ type: 'put', trans: {} as never, values: [input] });
    expect(input.note).toBe('工资 8000'); // 克隆加密,原对象不动
    const stored = env.store.tables.get('transactions')!.get('t2')!;
    expect(String(stored.note)).toMatch(/^enc1:/); // 落盘是密文
    const read = (await txCore().get({ trans: {} as never, key: 't2' })) as Record<string, unknown>;
    expect(read.note).toBe('工资 8000'); // 读取透明解密
  });

  it('开启时存量明文自动重加密(迁移清扫)', async () => {
    const stored = env.store.tables.get('transactions')!.get('t1')!;
    expect(String(stored.note)).toMatch(/^enc1:/);
  });

  it('parsed(对象字段)JSON 序列化加密、raw 直接加密', async () => {
    await pendCore().mutate({
      type: 'put', trans: {} as never,
      values: [{ id: 'p1', raw: '早餐 12 元', parsed: { merchant: '早点铺', note: '豆浆' } }],
    });
    const stored = env.store.tables.get('pending_transactions')!.get('p1')!;
    expect(String(stored.raw)).toMatch(/^enc1:/);
    expect(String(stored.parsed)).toMatch(/^enc1:/);
    const read = (await pendCore().get({ trans: {} as never, key: 'p1' })) as Record<string, unknown>;
    expect(read.raw).toBe('早餐 12 元');
    expect(read.parsed).toEqual({ merchant: '早点铺', note: '豆浆' });
  });

  it('outbox 内嵌 payload 同样加密(防止待同步队列明文残留)', async () => {
    await outboxCore().mutate({
      type: 'add', trans: {} as never,
      values: [{ entity: 'transaction', entityId: 't2', payload: { id: 't2', note: '工资 8000' } }],
    });
    const rows = await drain(outboxCore());
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as Record<string, unknown>).note).toBe('工资 8000');
    const stored = [...env.store.tables.get('outbox')!.values()][0];
    expect(String((stored.payload as Record<string, unknown>).note)).toMatch(/^enc1:/);
  });

  it('空字符串/空值不加密,put 幂等跳过已加密值(pull 回写不双重加密)', async () => {
    await txCore().mutate({ type: 'put', trans: {} as never, values: [{ id: 't3', note: '', amount: '3' }] });
    const stored = env.store.tables.get('transactions')!.get('t3')!;
    expect(stored.note).toBe('');
    // 服务端明文 pull 落地 → 中间件加密;再 put 一次(模拟重复 pull)→ 不二次加密
    await txCore().mutate({ type: 'put', trans: {} as never, values: [{ id: 't4', note: 'repeat', amount: '4' }] });
    const first = env.store.tables.get('transactions')!.get('t4')!.note;
    await txCore().mutate({ type: 'put', trans: {} as never, values: [structuredClone(env.store.tables.get('transactions')!.get('t4'))] });
    expect(env.store.tables.get('transactions')!.get('t4')!.note).toBe(first);
  });

  it('游标路径(带 values 的 openCursor)透明解密', async () => {
    const rows = await drain(txCore());
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) {
      if (r.id === 't2') expect(r.note).toBe('工资 8000');
      if (r.id === 't3') expect(r.note).toBe('');
    }
  });

  it('锁定(内存 DEK 清除):读回密文不崩;解锁后恢复明文', async () => {
    lockFieldEncryption();
    const locked = (await txCore().get({ trans: {} as never, key: 't2' })) as Record<string, unknown>;
    expect(String(locked.note)).toMatch(/^enc1:/);
    await unlockFieldEncryption('123456');
    const read = (await txCore().get({ trans: {} as never, key: 't2' })) as Record<string, unknown>;
    expect(read.note).toBe('工资 8000');
  });

  it('错误 PIN 解锁失败,不影响后续正确 PIN 解锁', async () => {
    lockFieldEncryption();
    await expect(unlockFieldEncryption('999999')).rejects.toThrow();
    expect(fieldEncryptionUnlocked()).toBe(false);
    await unlockFieldEncryption('123456');
    expect(fieldEncryptionUnlocked()).toBe(true);
  });

  it('关闭应用锁:全量解密落盘,配置移除', async () => {
    await disableFieldEncryption('123456');
    expect(fieldEncryptionConfigured()).toBe(false);
    expect(fieldEncryptionUnlocked()).toBe(false);
    for (const [, table] of env.store.tables) {
      for (const row of table.values()) {
        const notes: unknown[] = [row.note, row.raw, row.parsed];
        if (row.payload) notes.push((row.payload as Record<string, unknown>).note);
        for (const n of notes) {
          if (typeof n === 'string') expect(n.startsWith(CIPHER_PREFIX)).toBe(false);
        }
      }
    }
    const read = (await txCore().get({ trans: {} as never, key: 't2' })) as Record<string, unknown>;
    expect(read.note).toBe('工资 8000');
  });

  it('AAD 绑定:密文跨行调包后解密失败时原样保留(不崩页)', async () => {
    await enableFieldEncryption('654321');
    await txCore().mutate({ type: 'put', trans: {} as never, values: [{ id: 'a1', note: 'AAA', amount: '1' }, { id: 'a2', note: 'BBB', amount: '2' }] });
    const s1 = env.store.tables.get('transactions')!.get('a1')!;
    const s2 = env.store.tables.get('transactions')!.get('a2')!;
    // 交换密文
    env.store.tables.get('transactions')!.set('a1', { ...s1, note: s2.note });
    const read = (await txCore().get({ trans: {} as never, key: 'a1' })) as Record<string, unknown>;
    // AAD 不匹配 → 解密失败 → 保留原密文(告警),不抛错
    expect(String(read.note)).toMatch(/^enc1:/);
    await disableFieldEncryption('654321');
  });
});
