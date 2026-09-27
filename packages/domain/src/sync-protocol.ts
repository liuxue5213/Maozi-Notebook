import { z } from 'zod';

/** 可参与同步的实体种类(user 自身走 /me,不在此列) */
export const ENTITY_KINDS = [
  'ledger', 'ledger_member', 'account', 'category', 'tag', 'transaction', 'budget',
  'budget_item', 'recurring_rule', 'attachment', 'pending_transaction', 'debt', 'reimbursement',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** 客户端变更操作(上行) */
export interface ChangeOp {
  seq?: number;
  entity: EntityKind;
  entityId: string;
  op: 'upsert' | 'delete';
  payload: Record<string, unknown>;
  clientVersion: number;
  /** 客户端编辑时所见的服务端版本号(编辑基线);纯本地从未同步的行(服务端 version < 0);并发判定依据 */
  baseVersion?: number | null;
  occurredAt: number;
  deviceId?: string;
}

/** 关键字段冲突:金额/日期等不自动裁决,双版本并存(PRD 5.5);响应只回字段名,不回服务端原值 */
export interface FieldConflict {
  field: string;
}

export interface PushChangeResult {
  entityId: string;
  status: 'applied' | 'noop' | 'stale' | 'conflict' | 'rejected';
  serverVersion?: number;
  conflicts?: FieldConflict[];
  /** status=rejected 时的原因(服务端拒绝,客户端应死信隔离而非重试) */
  reason?: string;
}

export interface PushResponse {
  results: PushChangeResult[];
}

export interface PullRow {
  entity: EntityKind;
  row: Record<string, unknown>;
}

export interface PullResponse {
  cursor: number;
  hasMore: boolean;
  rows: PullRow[];
}

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncTransport {
  push(changes: ChangeOp[]): Promise<PushResponse>;
  pull(cursor: number, limit?: number): Promise<PullResponse>;
}

export const changeOpSchema = z.object({
  entity: z.enum(ENTITY_KINDS),
  entityId: z.string().min(1),
  op: z.enum(['upsert', 'delete']),
  payload: z.record(z.unknown()),
  clientVersion: z.number().int().positive(),
  baseVersion: z.number().int().nonnegative().nullable().optional(),
  occurredAt: z.number().int().nonnegative(),
  deviceId: z.string().default(''),
});

export const pushBodySchema = z.object({
  /** 单次 ≤ 500 条(PRD 7.2 限流) */
  changes: z.array(changeOpSchema).max(500),
});
