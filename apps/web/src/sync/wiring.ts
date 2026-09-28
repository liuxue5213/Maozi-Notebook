import { newId, type ChangeOp, type EntityKind } from '@ledgerone/domain';
import { SyncEngine } from '@ledgerone/sync';
import { db, TABLE_BY_ENTITY } from '../db/db';
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

/** 本地写入后入队:所有写操作先落本地库,再异步同步(PRD 5.4 本地为第一写入口) */
export function enqueue(entity: EntityKind, row: Record<string, unknown>, op: 'upsert' | 'delete' = 'upsert'): void {
  void db.outbox.add({
    entity,
    entityId: String(row.id),
    op,
    payload: row,
    // 客户端编辑基线(协议预留字段):记录编辑时所见的该行服务端版本号(纯本地未同步行为 null)。
    // 当前服务端裁决不依赖它(并发安全由「载荷等效 + 字段级合并」保证),仅作排查线索保留。
    baseVersion: row.server_version == null ? null : Number(row.server_version),
    clientVersion: Number(row.client_version ?? 1),
    occurredAt: Date.now(),
    deviceId: getDeviceId(),
  } as ChangeOp & { seq?: number });
  scheduleSync();
}

async function applyServerRow(entity: EntityKind, row: Record<string, unknown>): Promise<void> {
  // 本地存在待推送版本时不覆盖,待上行 ack 后由下次 pull 收敛
  const pending = await db.outbox.where('entityId').equals(String(row.id)).first();
  if (pending) return;
  const table = TABLE_BY_ENTITY[entity];
  if (table) await table.put(row as never);
}

export const engine = new SyncEngine({
  transport: makeTransport(),
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
    // PRD 5.5 双版本并存:客户端版本转存为「冲突副本」重新上行,服务端版本随后经 pull 落地
    const orig = op.payload;
    const copy = {
      ...orig,
      id: newId(),
      note: `${(orig.note as string) ?? ''} [冲突副本]`.slice(0, 500),
      client_version: 1,
      server_version: null,
      is_deleted: false,
      deleted_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    await db.transactions.put(copy as never);
    enqueue('transaction', copy);
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

let syncTimer: number | undefined;

export function scheduleSync(delayMs = 2000): void {
  if (!getAccessToken()) return; // 未登录:纯本地模式(PRD M07-F06 的 Web 近似形态,见 README 边界说明)
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => void engine.syncOnce(), delayMs);
}

async function wipeLocal(): Promise<void> {
  await Promise.all([
    db.ledgers.clear(), db.members.clear(), db.accounts.clear(), db.categories.clear(),
    db.tags.clear(), db.transactions.clear(), db.budgets.clear(), db.budget_items.clear(),
    db.recurring_rules.clear(), db.attachments.clear(), db.pending_transactions.clear(),
    db.debts.clear(), db.reimbursements.clear(), db.outbox.clear(), db.meta.clear(),
  ]);
  await db.meta.put({ key: 'sync_cursor', value: 0 });
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
  await engine.syncOnce();
}
