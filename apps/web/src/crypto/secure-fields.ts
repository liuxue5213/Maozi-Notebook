/**
 * 端侧字段级加密(F-05,D03):对 IndexedDB(Dexie)中的敏感自由文本字段做 AES-GCM-256 加密落盘。
 *
 * 设计要点:
 * - 覆盖字段:transactions.note(备注)、pending_transactions.raw/parsed(导入账单原文/解析结果),
 *   以及 outbox/deadletter.payload 内嵌的同名字段(否则本地待同步队列仍是明文,加密形同虚设)。
 * - 密钥:随机 256 位 DEK,由「PIN 派生的 KEK」加密后存 localStorage(F-05 与应用锁 F-04 绑定:
 *   未开启应用锁则无密钥源,字段保持明文 —— 见 SecurityPanel 的用户提示)。DEK 只驻留内存,
 *   锁定/刷新页面即清除,解锁时由 PIN 重新解包。
 * - 密文自描述:enc1:<ivB64>:<ctB64> 前缀,enc 幂等(已加密值跳过),dec 对非密文原样返回,
 *   因此「服务端明文 → 本地加密存储」「新旧数据混存」「锁定态读回密文」都安全。
 * - AAD 绑定 表名:字段:行主键,防止密文跨行调包(备注密文复制到另一条流水上无法通过解密校验)。
 * - Dexie dbcore 中间件:写路径(add/put)加密后存「克隆」(不污染调用方对象);读路径
 *   (get/getMany/query)异步解密;openCursor 因回调是同步契约,先按底层游标原样排干成数组、
 *   逐行解密后以内存游标回放,语义(方向/limit/range)由底层游标保证。
 * - 服务器收到的是上行载荷(经 outbox 解密后的明文):本特性是「端侧静态加密」,传输与
 *   服务端存储依赖 TLS 与服务端安全(与 PRD/技术选型 D03 的范围一致)。
 */
import type {
  DBCore, DBCoreCursor, DBCoreMutateRequest, DBCoreTable, Middleware,
} from 'dexie';

export const CIPHER_PREFIX = 'enc1:';

/* ---------------- 基础加解密原语 ---------------- */

function b64(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const te = new TextEncoder();
const td = new TextDecoder();

export async function aesGcmEncrypt(key: CryptoKey, aad: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(aad) },
    key,
    te.encode(plaintext),
  );
  return `${CIPHER_PREFIX}${b64(iv)}:${b64(ct)}`;
}

export async function aesGcmDecrypt(key: CryptoKey, aad: string, stored: string): Promise<string> {
  const [tag, ivB64, ctB64] = stored.split(':');
  if (tag !== CIPHER_PREFIX.slice(0, -1) || !ivB64 || !ctB64) throw new Error('bad cipher format');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(ivB64), additionalData: te.encode(aad) },
    key,
    unb64(ctB64),
  );
  return td.decode(pt);
}

/* ---------------- 字段规格 ---------------- */

export interface FieldSpec {
  field: string;
  /** 值为对象/可空对象时,序列化为 JSON 字符串后整体加密(解密侧还原对象) */
  json?: boolean;
}

export interface TableSpec {
  kind: 'direct';
  fields: Array<FieldSpec | string>;
  /** AAD 绑定的行主键字段 */
  idField: string;
}

export interface NestedTableSpec {
  kind: 'nested';
  /** 内嵌载荷字段名(outbox/deadletter 的 payload) */
  container: string;
  /** 载荷里区分实体类型的字段 */
  entityKey: string;
  /** 实体类型 → 载荷内需加密字段 */
  map: Record<string, Array<FieldSpec | string>>;
  /** AAD 绑定字段(外层行上的稳定 id) */
  idField: string;
}

export type AnyTableSpec = TableSpec | NestedTableSpec;

export const TABLE_SPECS: Record<string, AnyTableSpec> = {
  transactions: { kind: 'direct', fields: ['note'], idField: 'id' },
  pending_transactions: { kind: 'direct', fields: ['raw', { field: 'parsed', json: true }], idField: 'id' },
  outbox: {
    kind: 'nested',
    container: 'payload',
    entityKey: 'entity',
    idField: 'entityId',
    map: {
      transaction: ['note'],
      pending_transaction: ['raw', { field: 'parsed', json: true }],
    },
  },
  deadletter: {
    kind: 'nested',
    container: 'payload',
    entityKey: 'entity',
    idField: 'entityId',
    map: {
      transaction: ['note'],
      pending_transaction: ['raw', { field: 'parsed', json: true }],
    },
  },
};

/* ---------------- DEK 装载状态 ---------------- */

let dek: CryptoKey | null = null;
let suspended = false; // 关闭端侧加密的落盘清扫期间:读照常解密,写不再加密

/** 仅供 keyring 模块管理 DEK 生命周期 */
export function setDek(key: CryptoKey | null): void {
  dek = key;
}
export function hasDek(): boolean {
  return dek !== null;
}
export function setSuspended(v: boolean): void {
  suspended = v;
}

/* ---------------- 行级加解密 ---------------- */

function fieldList(spec: Array<FieldSpec | string>): FieldSpec[] {
  return spec.map((f) => (typeof f === 'string' ? { field: f } : f));
}

function normValue(v: unknown, json?: boolean): string | null {
  if (v == null) return null;
  if (json) return JSON.stringify(v ?? null);
  if (typeof v !== 'string' || v === '') return null;
  return v;
}

/** 加密一行(返回浅克隆;调用方对象不被改动)。密钥未就绪或已加密的值原样保留。 */
export async function encryptRow(table: string, spec: AnyTableSpec, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!dek || suspended) return row;
  const clone = { ...row };
  const touch = async (obj: Record<string, unknown>, f: FieldSpec, aadId: unknown): Promise<void> => {
    if (typeof obj[f.field] === 'string' && String(obj[f.field]).startsWith(CIPHER_PREFIX)) return; // 幂等
    const plain = normValue(obj[f.field], f.json);
    if (plain == null) return;
    const aad = `${table}:${f.field}:${String(aadId)}`;
    obj[f.field] = await aesGcmEncrypt(dek!, aad, plain);
  };
  if (spec.kind === 'direct') {
    for (const f of fieldList(spec.fields)) await touch(clone, f, row[spec.idField]);
  } else {
    // entity 类型在外层行(ChangeOp.entity),需加密字段在 payload 内
    const payload = clone[spec.container] as Record<string, unknown> | undefined;
    const fields = spec.map[String(row[spec.entityKey] ?? '')];
    if (payload && fields) {
      const pClone = { ...payload };
      for (const f of fieldList(fields)) await touch(pClone, f, row[spec.idField]);
      clone[spec.container] = pClone;
    }
  }
  return clone;
}

/** 解密一行(原地改写;行对象来自 IndexedDB,可安全变更)。锁定态/明文/解密失败时原样返回。 */
export async function decryptRow(table: string, spec: AnyTableSpec, row: Record<string, unknown> | undefined): Promise<void> {
  if (!row) return;
  const undo = async (obj: Record<string, unknown>, f: FieldSpec, aadId: unknown): Promise<void> => {
    const v = obj[f.field];
    if (typeof v !== 'string' || !v.startsWith(CIPHER_PREFIX)) return;
    const aad = `${table}:${f.field}:${String(aadId)}`;
    try {
      if (!dek) return; // 锁定态:保留密文(UI 被 LockGate 遮蔽,不会展示)
      const plain = await aesGcmDecrypt(dek, aad, v);
      obj[f.field] = f.json ? (JSON.parse(plain) as unknown) : plain;
    } catch (e) {
      // AAD 不匹配/数据损坏:保留原文,避免整页崩溃;留痕排查
      console.warn(`[fenc] 解密失败(${table}.${f.field})`, e);
    }
  };
  if (spec.kind === 'direct') {
    for (const f of fieldList(spec.fields)) await undo(row, f, row[spec.idField]);
  } else {
    const payload = row[spec.container] as Record<string, unknown> | undefined;
    const fields = spec.map[String(row[spec.entityKey] ?? '')];
    if (payload && fields) {
      for (const f of fieldList(fields)) await undo(payload, f, row[spec.idField]);
    }
  }
}

/* ---------------- 中间件 ---------------- */

function wrapTable(tableName: string, core: DBCoreTable): DBCoreTable {
  const spec = TABLE_SPECS[tableName];
  if (!spec) return core;
  const pkPath = core.schema.primaryKey.keyPath;
  const idOf = (row: Record<string, unknown>): unknown =>
    typeof pkPath === 'string' ? row[pkPath] : row[spec.idField];
  const keyOf = (row: Record<string, unknown>): unknown =>
    typeof pkPath === 'string' ? row[pkPath] : undefined;

  return {
    ...core,
    async mutate(req: DBCoreMutateRequest) {
      if (req.type === 'add' || req.type === 'put') {
        // 克隆后加密:调用方持有的行对象保持明文,避免「put 后读对象变密文」
        const values = await Promise.all(req.values.map((v) => encryptRow(tableName, spec, v as Record<string, unknown>)));
        return core.mutate({ ...req, values } as typeof req);
      }
      return core.mutate(req);
    },
    async get(req) {
      const row = await core.get(req);
      await decryptRow(tableName, spec, row);
      return row;
    },
    async getMany(req) {
      const rows = await core.getMany(req);
      await Promise.all(rows.map((r) => decryptRow(tableName, spec, r)));
      return rows;
    },
    async query(req) {
      const res = await core.query(req);
      if (req.values) await Promise.all(res.result.map((r) => decryptRow(tableName, spec, r)));
      return res;
    },
    async openCursor(req) {
      const native = await core.openCursor(req);
      if (!native || !req.values) return native;
      // 底层游标保证 range/direction/limit/unique 语义;这里只负责把值逐行解密后回放
      const rows: Record<string, unknown>[] = [];
      const trans = native.trans;
      await native.start(() => {
        if (native.value != null) rows.push(native.value as Record<string, unknown>);
        native.continue();
      });
      await Promise.all(rows.map((r) => decryptRow(tableName, spec, r)));
      return replayCursor(rows, req, trans, keyOf, idOf);
    },
  };
}

/** 内存回放游标:复刻 openCursor 的同步消费契约(start/onNext + continue/advance/stop/fail) */
function replayCursor(
  rows: Record<string, unknown>[],
  req: { reverse?: boolean; query: { index: { keyPath: string | string[] | null } } },
  trans: DBCoreCursor['trans'],
  keyOf: (row: Record<string, unknown>) => unknown,
  idOf: (row: Record<string, unknown>) => unknown,
): DBCoreCursor {
  const order = req.reverse ? [...rows].reverse() : rows;
  const reverse = !!req.reverse;
  let fired = -1; // 最近一次 onNext 的下标(-1 = 尚未开始)
  let nextIdx = -1; // 下一次 onNext 应发射的下标
  let stopped = false;
  let resolveStart: (v?: unknown) => void = () => undefined;
  let rejectStart: (e: Error) => void = () => undefined;
  let stepFn: () => void = () => undefined;

  const outOfRange = (i: number): boolean => i < 0 || i >= order.length;

  function step(): void {
    if (stopped) return;
    fired = nextIdx;
    if (outOfRange(nextIdx)) {
      stopped = true;
      resolveStart();
      return;
    }
    stepFn();
  }

  const cursor: DBCoreCursor = {
    trans,
    get key() {
      const r = order[fired];
      return r == null ? undefined : keyOf(r);
    },
    get primaryKey() {
      const r = order[fired];
      return r == null ? undefined : idOf(r);
    },
    get value() {
      return order[fired];
    },
    get done() {
      return stopped || outOfRange(nextIdx);
    },
    continue(key?: unknown) {
      if (stopped) return;
      if (key === undefined) {
        nextIdx = reverse ? nextIdx - 1 : nextIdx + 1;
      } else {
        // IDB continue(key):定位到键 ≥ key(反向 ≤)的下一位置
        let i = nextIdx;
        for (;;) {
          i = reverse ? i - 1 : i + 1;
          if (outOfRange(i)) break;
          const c = cmp(keyOf(order[i]), key);
          if (reverse ? c <= 0 : c >= 0) break;
        }
        nextIdx = i;
      }
      queueMicrotask(step);
    },
    continuePrimaryKey(key: unknown, primaryKey: unknown) {
      if (stopped) return;
      let i = nextIdx;
      for (;;) {
        i = reverse ? i - 1 : i + 1;
        if (outOfRange(i)) break;
        if (cmp(keyOf(order[i]), key) === 0 && cmp(idOf(order[i]), primaryKey) >= 0) break;
      }
      nextIdx = i;
      queueMicrotask(step);
    },
    advance(count: number) {
      if (stopped) return;
      nextIdx += reverse ? -count : count;
      queueMicrotask(step);
    },
    start(onNext: () => void): Promise<any> {
      return new Promise((resolve, reject) => {
        resolveStart = resolve;
        rejectStart = reject;
        stepFn = onNext;
        nextIdx = reverse ? order.length - 1 : 0; // 从首条(按方向)开始
        queueMicrotask(step);
      });
    },
    stop(value?: unknown) {
      stopped = true;
      resolveStart(value);
    },
    next(): Promise<DBCoreCursor> {
      nextIdx = reverse ? nextIdx - 1 : nextIdx + 1;
      fired = nextIdx;
      return Promise.resolve(cursor);
    },
    fail(error: Error) {
      stopped = true;
      rejectStart(error);
    },
  };
  return cursor;
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** 挂载字段加密中间件(必须在任何表访问前调用一次) */
export function installFieldEncryption(db: { use: (m: Middleware<DBCore>) => void }): void {
  db.use({
    stack: 'dbcore',
    name: 'field-encryption',
    create: (down) => ({
      ...down,
      table: (tableName: string) => wrapTable(tableName, down.table(tableName)),
    }),
  });
}
