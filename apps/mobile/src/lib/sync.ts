import type { SyncTransport } from '@ledgerone/domain';
import { SyncEngine, startAutoSync, type SyncEngineSnapshot } from '@ledgerone/sync';
import { addDeadLetter, createChangeQueue, createRowSink, saveLocal, type AnyRow } from '@ledgerone/sqlite-sync';
import { newId, type ChangeOp, type TransactionRow } from '@ledgerone/domain';
import { AppState } from 'react-native';
import { db } from './db';
import { getAccessToken, makeTransport } from './api';

let cachedTransport: SyncTransport | null = null;
async function transport(): Promise<SyncTransport> {
  cachedTransport ??= await makeTransport();
  return cachedTransport;
}

/** 关键字段冲突 → 生成「冲突副本」双版本并存(PRD 5.5);第 19 轮 P0-1:仅流水实体,其余不自动副本 */
async function onPushConflict(op: ChangeOp, conflicts?: Array<{ field: string }>): Promise<void> {
  if (op.entity !== 'transaction') {
    await addDeadLetter(db, op, `关键字段冲突: ${conflicts?.map((c) => c.field).join(', ') ?? '未知字段'}`);
    console.warn('[sync] 非流水实体冲突已保存到同步诊断:', op.entity, conflicts);
    return;
  }
  const orig = op.payload as Partial<TransactionRow>;
  const now = Date.now();
  const copy: AnyRow = {
    ...orig,
    id: op.seq === undefined ? newId() : `conflict_${op.entityId}_${op.seq}`,
    note: `${orig.note ?? ''} [冲突副本]`.slice(0, 500),
    client_version: 1,
    server_version: null,
    is_deleted: false,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
  const queued = await db.getAllAsync<{ seq: number }>('SELECT seq FROM outbox WHERE entity_id = ? LIMIT 1', [String(copy.id)]);
  if (!queued.length) await saveLocal(db, 'transaction', copy);
}

export const engine = new SyncEngine({
  transport: {
    push: (changes) => transport().then((t) => t.push(changes)),
    pull: (cursor, limit) => transport().then((t) => t.pull(cursor, limit)),
  },
  queue: createChangeQueue(db),
  sink: createRowSink(db),
  onPushConflict,
  // 服务端 rejected 的 op:落死信表(B5/N1,与 Web 端对齐),不再重试也不再静默丢弃
  onDeadLetter: async (op, reason) => {
    await addDeadLetter(db, op, reason);
    console.warn('[sync] 变更被服务端拒绝,已移入死信:', op.entityId, reason);
  },
});

export function snapshot(): SyncEngineSnapshot {
  return engine.getSnapshot();
}

/** 未登录不发起同步(纯本地) */
async function hasToken(): Promise<boolean> {
  return !!(await getAccessToken());
}

/** P0-2(第 27 轮):真去抖 —— 修复前每次新建 setTimeout,连续记 5 笔会并发 5 次同步 */
let syncTimer: ReturnType<typeof setTimeout> | undefined;

export function scheduleSync(delayMs = 2000): void {
  void (async () => {
    if (!(await hasToken())) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      void engine.syncOnce();
    }, delayMs);
  })();
}

/**
 * P0-2(第 27 轮):定时兜底(5 分钟)+ 进前台立即补同步(AppState)。
 * 与 Web 的 visibilitychange/online 监听对齐;网络状态由同步失败重试自然兜底(离线优先)。
 */
let cachedToken = false;
export function refreshLoginCache(): void {
  void hasToken().then((t) => (cachedToken = t));
}
export function startMobileAutoSync(): void {
  startAutoSync(engine, { isOnline: () => cachedToken });
  const sub = AppState.addEventListener('change', (state) => {
    refreshLoginCache();
    if (state === 'active' && cachedToken) void engine.syncOnce();
  });
  void sub; // RN AppState subscription;应用生命周期内常驻
}
