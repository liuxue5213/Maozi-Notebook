import { newId, type ChangeOp, type EntityKind } from '@ledgerone/domain';
import { SyncEngine } from '@ledgerone/sync';
import { db, TABLE_BY_ENTITY } from '../db/db';
import { createDebouncer } from '@ledgerone/sync-client';
import type { SyncEngineDeps } from '@ledgerone/sync';
import { getAccessToken, getUserId, makeTransport } from './api';

const DEVICE_KEY = 'lo_device';

function getDeviceId(): string {
  let d = localStorage.getItem(DEVICE_KEY);
  if (!d) {
    d = newId();
    localStorage.setItem(DEVICE_KEY, d);
  }
  return d;
}

/** 入队必须可等待,调用方可将它与业务写入放在同一 Dexie 事务中。 */
export async function enqueue(
  entity: EntityKind,
  row: Record<string, unknown>,
  op: 'upsert' | 'delete' = 'upsert',
  base?: Record<string, unknown> | null,
): Promise<void> {
  await db.outbox.add({
    entity,
    entityId: String(row.id),
    op,
    payload: row,
    // 客户端编辑基线:版本号 + 整行快照(base)。三方合并(第 13 轮)用 base 逐字段对比,
    // 修复「陈旧非关键字段静默覆盖较新修改」;缺省 base 时服务端退化为整载荷 LWW(兼容旧客户端)。
    baseVersion: row.server_version == null ? null : Number(row.server_version),
    base: base ?? null,
    clientVersion: Number(row.client_version ?? 1),
    occurredAt: Date.now(),
    deviceId: getDeviceId(),
  } as ChangeOp & { seq?: number });
  scheduleSync();
}

/** O4 写入失败可见化:全局订阅(WriteErrorToast 消费)。3s 窗口同签名去重,防批量写入刷屏 */
export interface WriteError { entity: string; message: string; at: number; }
const writeErrListeners = new Set<(e: WriteError) => void>();
let lastErrSig = '';
let lastErrAt = 0;

export function subscribeWriteErrors(fn: (e: WriteError) => void): () => void {
  writeErrListeners.add(fn);
  return () => { writeErrListeners.delete(fn); };
}

function reportWriteError(entity: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const now = Date.now();
  const sig = `${entity}:${message}`;
  if (sig === lastErrSig && now - lastErrAt < 3000) return;
  lastErrSig = sig;
  lastErrAt = now;
  const evt: WriteError = { entity, message, at: now };
  writeErrListeners.forEach((fn) => { try { fn(evt); } catch { /* 监听器异常不传染 */ } });
}

/** 单条业务写入与 outbox 原子提交。失败统一上报全局 Toast(O4:原先 void 调用方静默失败)后原样上抛,
 *  有 catch 的调用方(设置/待确认池等)自身提示不受影响。 */
export async function saveLocal(
  entity: EntityKind,
  row: Record<string, unknown>,
  op: 'upsert' | 'delete' = 'upsert',
  base?: Record<string, unknown> | null,
): Promise<void> {
  const table = TABLE_BY_ENTITY[entity];
  if (!table) throw new Error(`不支持本地写入实体: ${entity}`);
  try {
    await db.transaction('rw', table, db.outbox, async () => {
      await table.put(row as never);
      await enqueue(entity, row, op, base);
    });
  } catch (err) {
    reportWriteError(entity, err);
    throw err;
  }
}

async function applyServerRow(entity: EntityKind, row: Record<string, unknown>): Promise<boolean> {
  // 本地存在待推送版本时不覆盖,待上行 ack 后由下次 pull 收敛
  const pending = await db.outbox.where('entityId').equals(String(row.id)).first();
  if (pending) return false;
  const table = TABLE_BY_ENTITY[entity];
  if (table) await table.put(row as never);
  return true;
}

export const engine = new SyncEngine({
  transport: makeTransport() as SyncEngineDeps['transport'],
  queue: {
    take: async (n) => db.outbox.orderBy('seq').limit(n).toArray(),
    ack: async (seqs) => {
      await db.outbox.bulkDelete(seqs);
    },
    count: async () => db.outbox.count(),
  },
  sink: {
    applyServerRow,
    getCursor: async () => ((await db.meta.get('sync_cursor'))?.value as number) ?? 0,
    setCursor: async (c) => {
      await db.meta.put({ key: 'sync_cursor', value: c });
    },
  },
  onPushConflict: async (op, conflicts) => {
    // PRD 5.5 双版本并存:客户端版本转存为「冲突副本」重新上行,服务端版本随后经 pull 落地。
    // 第 19 轮 P0-1 修复:按 op.entity 分发 —— 修复前无条件写 transactions 表,非流水实体
    // (recurring_rule/account 等含同名字段 amount/type)冲突时整行塞进流水表触发白屏。
    if (op.entity !== 'transaction') {
      await db.deadletter.add({
        entity: op.entity, entityId: op.entityId, op: op.op, payload: op.payload,
        reason: `关键字段冲突: ${conflicts?.map((c) => c.field).join(', ') ?? '未知字段'}`,
        at: Date.now(),
      });
      console.warn('[sync] 非流水实体冲突已保存到同步诊断:', op.entity, op.entityId, conflicts);
      return;
    }
    const orig = op.payload;
    const copy = {
      ...orig,
      id: op.seq === undefined ? newId() : `conflict_${op.entityId}_${op.seq}`,
      note: `${(orig.note as string) ?? ''} [冲突副本]`.slice(0, 500),
      client_version: 1,
      server_version: null,
      is_deleted: false,
      deleted_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    await db.transaction('rw', db.transactions, db.outbox, async () => {
      if (await db.outbox.where('entityId').equals(String(copy.id)).first()) return;
      await db.transactions.put(copy as never);
      await enqueue('transaction', copy);
    });
    console.warn('[sync] 关键字段冲突,已生成冲突副本:', op.entityId, conflicts);
  },
  onDeadLetter: async (op, reason) => {
    // 服务端拒绝的变更:死信隔离,不再重试(可在设置页导出排查)
    await db.deadletter.add({
      entity: op.entity,
      entityId: op.entityId,
      op: op.op,
      payload: op.payload,
      reason,
      at: Date.now(),
    });
    console.warn('[sync] 变更被服务端拒绝,已移入死信:', op.entityId, reason);
  },
});

/** 去抖器已上提共享包(P1-2):窗口内多次 schedule 合并为一次 syncOnce */
const debouncer = createDebouncer(() => void engine.syncOnce(), 2000);

export function scheduleSync(delayMs = 2000): void {
  if (!getAccessToken()) return; // 未登录:纯本地模式(PRD M07-F06 的 Web 近似形态,见 README 边界说明)
  debouncer.schedule(delayMs);
}

async function wipeLocal(): Promise<void> {
  // P1-21(Review):保留 local_seeded —— 清库后若丢此标记,下次刷新 ensureLocalSeed 会
  // 再播种一个新「我的账本」并上行到**当前(新)账号**,成为幽灵账本。换号场景服务端
  // 数据随 pull 到位,不需要本地再播种;本地播种标记应跨清库存活。
  const seeded = (await db.meta.get('local_seeded'))?.value;
  await Promise.all([
    db.ledgers.clear(), db.members.clear(), db.accounts.clear(), db.categories.clear(),
    db.tags.clear(), db.transactions.clear(), db.budgets.clear(), db.budget_items.clear(),
    db.recurring_rules.clear(), db.attachments.clear(), db.pending_transactions.clear(),
    db.debts.clear(), db.reimbursements.clear(), db.outbox.clear(), db.deadletter.clear(), db.meta.clear(),
  ]);
  await db.meta.put({ key: 'sync_cursor', value: 0 });
  if (seeded) await db.meta.put({ key: 'local_seeded', value: seeded });
}

/** 登录后:换账号清空本地;空库时清掉本地播种,直接以服务端全量为准 */
export async function prepareAfterLogin(): Promise<void> {
  const uid = getUserId();
  const last = (await db.meta.get('last_user'))?.value as string | undefined;
  if (uid && last && last !== uid) {
    await wipeLocal(); // 明确换号:旧账号本地数据全部清空
  } else if (uid && !last) {
    // last_user 缺失(第 5 轮 E2E 发现):须区分两种情形 ——
    // 纯本地离线数据(从未登录:游标 0 且无任何服务端行)→ 保留并在本账号名下上行(离线优先,PRD M07);
    // 旧账号残留(有过同步:游标 > 0 或存在服务端行)→ 清库,否则跨账号可见且遗留游标会吃掉新账号下行。
    const cursor = ((await db.meta.get('sync_cursor'))?.value as number) ?? 0;
    const hasServerRows = (await db.ledgers.filter((l) => l.server_version != null).count()) > 0;
    if (cursor > 0 || hasServerRows) await wipeLocal();
  }
  if (uid) await db.meta.put({ key: 'last_user', value: uid });
  const txCount = await db.transactions.count();
  const outCount = await db.outbox.count();
  if (txCount === 0 && outCount === 0) {
    await wipeLocal();
  }
  // 幽灵账本工厂关闭(2026-10-09):全新安装后本地游标为 0 时改「先拉后推」,
  // 推送前丢弃从未上行的空种子账本(有真实流水的离线账本不受影响)
  const freshInstall = Number(((await db.meta.get('sync_cursor'))?.value as number) ?? 0) === 0;
  const dropUnsyncedSeed = async (): Promise<void> => {
    const unsynced = await db.ledgers.filter((l) => l.server_version == null).toArray();
    const hasServer = await db.ledgers.filter((l) => l.server_version != null && !l.is_deleted).count();
    if (!unsynced.length || !hasServer) return;
    for (const l of unsynced) {
      const hasTx = await db.transactions.where('ledger_id').equals(l.id).count();
      if (hasTx > 0) continue; // 有流水的离线账本是真实数据,保留
      await db.transaction('rw', [db.ledgers, db.transactions, db.categories, db.accounts, db.budgets, db.budget_items, db.recurring_rules, db.savings_plans], async () => {
        await db.transactions.where('ledger_id').equals(l.id).delete();
        await db.categories.where('ledger_id').equals(l.id).delete();
        await db.accounts.where('ledger_id').equals(l.id).delete();
        await db.budgets.where('ledger_id').equals(l.id).delete();
        await db.budget_items.where('ledger_id').equals(l.id).delete();
        await db.recurring_rules.where('ledger_id').equals(l.id).delete();
        await db.savings_plans.where('ledger_id').equals(l.id).delete();
        await db.ledgers.delete(l.id);
      });
    }
    await db.meta.put({ key: 'active_ledger', value: '' }); // 触发兜底重选最早有效账本
  };
  await engine.syncOnce({ pullFirst: freshInstall, beforePush: dropUnsyncedSeed });
  // T-35 首登对齐(与移动端同口径):登录同步完成后,当前账本对齐到该账号「最早创建的已同步账本」。
  // 否则 Web 本地播种的新账本(以及换设备后各自新建的账本)会把两端各锁在各自的账本里——
  // 双端各自 push/pull 正常、徽章显示「同步完成」,内容却完全不同(数据不同步的典型根因)。
  const candidates = await db.ledgers.filter((l) => l.server_version != null && !l.is_deleted).toArray();
  const earliest = candidates.sort((a, b) => a.created_at - b.created_at)[0];
  if (earliest) {
    const activeId = ((await db.meta.get('active_ledger'))?.value as string) ?? '';
    const activeRow = activeId ? await db.ledgers.get(activeId) : undefined;
    if (earliest.id !== activeId && (!activeRow || Number(activeRow.created_at) > Number(earliest.created_at))) {
      await db.meta.put({ key: 'active_ledger', value: earliest.id });
      console.log('[auth] 账本对齐到最早服务器账本:', earliest.id);
    }
  }
}
