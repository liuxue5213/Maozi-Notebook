import {
  newId, type ChangeOp, type EntityKind, type PullRow,
} from '@ledgerone/domain';
import type { SyncTransport } from '@ledgerone/domain';
import type { AnyRow, SQLiteLike } from './types';
import { decodeRow, initSchemaSql, TABLES, upsertSql } from './tables';

export { initSchemaSql, TABLES, decodeRow, normalizeValue, upsertSql } from './tables';
export { prepareAfterLogin, wipeAllTables } from './login-policy';
export type { SQLiteLike, AnyRow } from './types';

export async function initSchema(db: SQLiteLike): Promise<void> {
  await db.execAsync(initSchemaSql());
  // 旧库幂等迁移(第 18/27 轮):outbox.base(三方合并编辑基线整行)+ base_version(编辑时所见证号)
  for (const col of ['base TEXT', 'base_version BIGINT']) {
    try {
      await db.execAsync(`ALTER TABLE outbox ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
  // 旧版建表遗漏了 id 主键，导致 INSERT OR REPLACE 每次 pull 都追加同一实体：
  // 明细、预算和报表会随同步次数成倍增长。迁移时按 id 保留最后写入(rowid 最大)
  // 的版本，再加唯一索引；新库则由 id PRIMARY KEY 直接保证幂等。
  await db.execAsync('BEGIN IMMEDIATE');
  try {
    for (const { table } of Object.values(TABLES)) {
      await db.execAsync(
        `DELETE FROM ${table} WHERE id IS NULL OR rowid NOT IN (`
        + `SELECT MAX(rowid) FROM ${table} WHERE id IS NOT NULL GROUP BY id)`,
      );
      await db.execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${table}_id ON ${table} (id)`);
    }
    await db.execAsync('COMMIT');
  } catch (error) {
    await db.execAsync('ROLLBACK');
    throw error;
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
/** T-01:移动端(SQLite 整数)写入的布尔字段归一化为 boolean,保证 outbox payload 与 Web(Dexie boolean)一致 */
const BOOLEAN_FIELDS = new Set([
  'is_deleted', 'is_refunded', 'exclude_from_budget', 'is_hidden', 'is_preset',
  'include_in_net', 'is_archived', 'paused', 'rollover',
]);

function normalizeBooleans(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const k of Object.keys(out)) {
    if (BOOLEAN_FIELDS.has(k) && (out[k] === 0 || out[k] === 1)) out[k] = Boolean(out[k]);
  }
  return out;
}

export async function saveLocal(
  db: SQLiteLike,
  entity: EntityKind,
  row: AnyRow,
  opts: { op?: 'upsert' | 'delete'; deviceId?: string; base?: AnyRow | null } = {},
): Promise<void> {
  row = normalizeBooleans(row);
  const { sql, params } = upsertSql(entity, row);
  if (db.withExclusiveTransactionAsync) {
    await db.withExclusiveTransactionAsync(async (tx) => {
      await tx.runAsync(sql, params);
      await enqueueChange(tx, entity, row, opts.op ?? 'upsert', opts.deviceId, opts.base);
    });
    return;
  }
  // node:sqlite 测试适配与旧实现:同一连接上显式事务,失败时一起回滚。
  await db.execAsync('BEGIN IMMEDIATE');
  try {
    await db.runAsync(sql, params);
    await enqueueChange(db, entity, row, opts.op ?? 'upsert', opts.deviceId, opts.base);
    await db.execAsync('COMMIT');
  } catch (error) {
    await db.execAsync('ROLLBACK');
    throw error;
  }
}

export async function enqueueChange(
  db: SQLiteLike,
  entity: EntityKind,
  row: AnyRow,
  op: 'upsert' | 'delete',
  deviceId?: string,
  base?: AnyRow | null,
): Promise<void> {
  // 同一实体在一次同步前可能被连续编辑，甚至“编辑后立即删除”。旧实现把每次操作
  // 全部排进 outbox，服务端会依次处理陈旧版本，金额修改因此被误判为冲突并生成副本。
  // 合并成最后一次操作，同时保留第一次编辑时的服务端基线，三方合并才有共同祖先。
  const pending = await db.getAllAsync<{
    base: string | null; base_version: number | null;
  }>(
    'SELECT base, base_version FROM outbox WHERE entity = ? AND entity_id = ? ORDER BY seq LIMIT 1',
    [entity, String(row.id)],
  );
  const hasPending = pending.length > 0;
  const preservedBase = hasPending ? pending[0].base : (base ? JSON.stringify(base) : null);
  const preservedBaseVersion = hasPending
    ? pending[0].base_version
    : (row.server_version == null ? null : Number(row.server_version));
  if (hasPending) {
    await db.runAsync('DELETE FROM outbox WHERE entity = ? AND entity_id = ?', [entity, String(row.id)]);
  }
  // P0-2(第 27 轮):补 base_version —— 编辑时所见的 server_version,服务端三方合并的并发判定输入
  await db.runAsync(
    'INSERT INTO outbox (entity, entity_id, op, payload, client_version, occurred_at, device_id, base, base_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      entity, String(row.id), op, JSON.stringify(row), Number(row.client_version ?? 1), Date.now(), deviceId ?? '',
      preservedBase,
      preservedBaseVersion,
    ],
  );
}

/** 变更队列(SyncEngine.ChangeQueue):FIFO take / ack / count */
export function createChangeQueue(db: SQLiteLike) {
  return {
    async take(limit: number): Promise<ChangeOp[]> {
      const rows = await db.getAllAsync<{
        seq: number; entity: string; entity_id: string; op: string; payload: string;
        client_version: number; occurred_at: number; device_id: string; base: string | null; base_version: number | null;
      }>('SELECT * FROM outbox ORDER BY seq LIMIT ?', [limit]);
      return rows.map((r) => ({
        seq: r.seq,
        entity: r.entity as EntityKind,
        entityId: r.entity_id,
        op: r.op as 'upsert' | 'delete',
        payload: JSON.parse(r.payload) as Record<string, unknown>,
        clientVersion: r.client_version,
        base: r.base ? (JSON.parse(r.base) as Record<string, unknown>) : null,
        baseVersion: r.base_version == null ? null : Number(r.base_version),
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
    async applyServerRow(entity: EntityKind, row: AnyRow): Promise<boolean> {
      const pending = await db.getAllAsync<{ seq: number }>('SELECT seq FROM outbox WHERE entity_id = ? LIMIT 1', [String(row.id)]);
      if (pending.length) return false;
      const { sql, params } = upsertSql(entity, row);
      await db.runAsync(sql, params);
      return true;
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
