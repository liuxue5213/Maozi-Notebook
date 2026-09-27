import type { SyncTransport } from '@ledgerone/domain';
import { SyncEngine, type SyncEngineSnapshot } from '@ledgerone/sync';
import { createChangeQueue, createRowSink, saveLocal, type AnyRow } from '@ledgerone/sqlite-sync';
import { newId, type TransactionRow } from '@ledgerone/domain';
import { db } from './db';
import { getAccessToken, makeTransport } from './api';

let cachedTransport: SyncTransport | null = null;
async function transport(): Promise<SyncTransport> {
  cachedTransport ??= await makeTransport();
  return cachedTransport;
}

/** 关键字段冲突 → 生成「冲突副本」双版本并存(PRD 5.5) */
async function onPushConflict(op: { payload: Record<string, unknown> }): Promise<void> {
  const orig = op.payload as Partial<TransactionRow>;
  const now = Date.now();
  const copy: AnyRow = {
    ...orig,
    id: newId(),
    note: `${orig.note ?? ''} [冲突副本]`.slice(0, 500),
    client_version: 1,
    server_version: null,
    is_deleted: false,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
  await saveLocal(db, 'transaction', copy);
}

export const engine = new SyncEngine({
  transport: {
    push: (changes) => transport().then((t) => t.push(changes)),
    pull: (cursor, limit) => transport().then((t) => t.pull(cursor, limit)),
  },
  queue: createChangeQueue(db),
  sink: createRowSink(db),
  onPushConflict: onPushConflict as never,
});

export function snapshot(): SyncEngineSnapshot {
  return engine.getSnapshot();
}

/** 未登录不发起同步(纯本地);登录后 2s 去抖批量上行 */
export function scheduleSync(delayMs = 2000): void {
  void getAccessToken().then((token) => {
    if (!token) return;
    setTimeout(() => {
      void engine.syncOnce();
    }, delayMs);
  });
}
