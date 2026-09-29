import {
  newId, type ChangeOp, type EntityKind, type PullRow,
} from '@ledgerone/domain';
import type { SyncTransport } from '@ledgerone/domain';
import type { AnyRow, SQLiteLike } from './types';
import { decodeRow, initSchemaSql, TABLES, upsertSql } from './tables';

export { initSchemaSql, TABLES, decodeRow, normalizeValue, upsertSql } from './tables';
export type { SQLiteLike, AnyRow } from './types';

export async function initSchema(db: SQLiteLike): Promise<void> {
  await db.execAsync(initSchemaSql());
  // 旧库幂等迁移(第 18 轮):outbox.base 列(三方合并编辑基线快照);列已存在时静默忽略
  try {
    await db.execAsync('ALTER TABLE outbox ADD COLUMN base TEXT');
  } catch {
    /* column already exists */
  }
}

export async function metaGet(db: SQLiteLike, key: string): Promise<unknown> {
  const rows = await db.getAllAsync<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
  if (!rows.length) return null;
  try {
    return JSON.parse(rows[0].value);
  } catch {
    return rows[0].value;
  }
}

export async function metaSet(db: SQLiteLike, key: string, value: unknown): Promise<void> {
  await db.runAsync(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, JSON.stringify(value ?? null)],
  );
}

/** 本地写入 + 入队:App 端所有写操作的第一入口(PRD 5.4 本地为第一写入口) */
export async function saveLocal(
  db: SQLiteLike,
  entity: EntityKind,
  row: AnyRow,
  opts: { op?: 'upsert' | 'delete'; deviceId?: string; base?: AnyRow | null } = {},
): Promise<void> {
  const { sql, params } = upsertSql(entity, row);
  await db.runAsync(sql, params);
  await enqueueChange(db, entity, row, opts.op ?? 'upsert', opts.deviceId, opts.base);
}

export async function enqueueChange(
  db: SQLiteLike,
  entity: EntityKind,
  row: AnyRow,
  op: 'upsert' | 'delete',
  deviceId?: string,
  base?: AnyRow | null,
): Promise<void> {
  await db.runAsync(
    'INSERT INTO outbox (entity, entity_id, op, payload, client_version, occurred_at, device_id, base) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [entity, String(row.id), op, JSON.stringify(row), Number(row.client_version ?? 1), Date.now(), deviceId ?? '', base ? JSON.stringify(base) : null],
  );
}

/** 变更队列(SyncEngine.ChangeQueue):FIFO take / ack / count */
export function createChangeQueue(db: SQLiteLike) {
  return {
    async take(limit: number): Promise<ChangeOp[]> {
      const rows = await db.getAllAsync<{
        seq: number; entity: string; entity_id: string; op: string; payload: string;
        client_version: number; occurred_at: number; device_id: string; base: string | null;
      }>('SELECT * FROM outbox ORDER BY seq LIMIT ?', [limit]);
      return rows.map((r) => ({
        seq: r.seq,
        entity: r.entity as EntityKind,
        entityId: r.entity_id,
        op: r.op as 'upsert' | 'delete',
        payload: JSON.parse(r.payload) as Record<string, unknown>,
        clientVersion: r.client_version,
        base: r.base ? (JSON.parse(r.base) as Record<string, unknown>) : null,
        occurredAt: r.occurred_at,
        deviceId: r.device_id ?? '',
      }));
    },
    async ack(seqs: number[]): Promise<void> {
      for (const seq of seqs) {
        await db.runAsync('DELETE FROM outbox WHERE seq = ?', [seq]);
      }
    },
    async count(): Promise<number> {
      const rows = await db.getAllAsync<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
      return rows[0]?.n ?? 0;
    },
  };
}

/** 服务端 rejected 变更的死信隔离(B5/N1):被拒收的 op 已 ack 出队,落 deadletter 供排查/重放,不再阻塞队列 */
export async function addDeadLetter(
  db: SQLiteLike,
  op: Pick<ChangeOp, 'entity' | 'entityId' | 'op' | 'payload'>,
  reason?: string,
): Promise<void> {
  await db.runAsync(
    'INSERT INTO deadletter (entity, entity_id, op, payload, reason, at) VALUES (?, ?, ?, ?, ?, ?)',
    [op.entity, op.entityId, op.op, JSON.stringify(op.payload ?? {}), reason ?? '', Date.now()],
  );
}

export interface DeadLetterRow {
  id: number;
  entity: string;
  entity_id: string;
  op: string;
  payload: string;
  reason: string;
  at: number;
}

/** 读取死信(最近优先;payload 已反解),「我的 → 同步诊断」页可直接展示 */
export async function listDeadLetters(db: SQLiteLike, limit = 100): Promise<Array<Omit<DeadLetterRow, 'payload'> & { payload: Record<string, unknown> }>> {
  const rows = await db.getAllAsync<DeadLetterRow>(
    'SELECT * FROM deadletter ORDER BY id DESC LIMIT ?',
    [limit],
  );
  return rows.map((r) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      /* keep empty */
    }
    return { ...r, payload };
  });
}

/**
 * 下行落地(SyncEngine.RowSink):
 * - 本地同实体仍有待推送版本时跳过,待上行 ack 后由下次 pull 收敛;
 * - 布尔/JSON 规范化 + INSERT OR REPLACE 幂等。
 */
export function createRowSink(db: SQLiteLike) {
  return {
    async applyServerRow(entity: EntityKind, row: AnyRow): Promise<void> {
      const pending = await db.getAllAsync<{ seq: number }>('SELECT seq FROM outbox WHERE entity_id = ? LIMIT 1', [String(row.id)]);
      if (pending.length) return;
      const { sql, params } = upsertSql(entity, row);
      await db.runAsync(sql, params);
    },
    async getCursor(): Promise<number> {
      return Number((await metaGet(db, 'sync_cursor')) ?? 0);
    },
    async setCursor(cursor: number): Promise<void> {
      await metaSet(db, 'sync_cursor', cursor);
    },
  };
}

/** 离线读:按账本取最近流水(列表页用) */
export async function recentTransactions(db: SQLiteLike, ledgerId: string, limit = 50): Promise<AnyRow[]> {
  const rows = await db.getAllAsync<AnyRow>(
    'SELECT * FROM transactions WHERE ledger_id = ? AND is_deleted = 0 ORDER BY happened_at DESC LIMIT ?',
    [ledgerId, limit],
  );
  return rows.map((r) => decodeRow('transaction', r));
}
