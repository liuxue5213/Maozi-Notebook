import type { EntityKind } from '@ledgerone/domain';
import type { AnyRow } from './types';

export type ColType = 'TEXT' | 'INTEGER' | 'REAL';

const SYNC_COLS: Array<[string, ColType]> = [
  ['client_version', 'INTEGER'],
  ['server_version', 'INTEGER'],
  ['is_deleted', 'INTEGER'],
  ['deleted_at', 'INTEGER'],
  ['created_at', 'INTEGER'],
  ['updated_at', 'INTEGER'],
];

function def(cols: Array<[string, ColType]>): Array<[string, ColType]> {
  return [...cols, ...SYNC_COLS];
}

/** 实体 → 表名 / 列定义(与 apps/server schema.ts 的字段保持一致,snake_case 零映射) */
export const TABLES: Record<EntityKind, { table: string; cols: Array<[string, ColType]>; jsonCols?: string[] }> = {
  ledger: { table: 'ledgers', cols: def([['id', 'TEXT'], ['owner_user_id', 'TEXT'], ['name', 'TEXT'], ['type', 'TEXT'], ['icon', 'TEXT'], ['sort', 'INTEGER']]) },
  ledger_member: { table: 'ledger_members', cols: def([['id', 'TEXT'], ['ledger_id', 'TEXT'], ['user_id', 'TEXT'], ['role', 'TEXT'], ['nickname_in_ledger', 'TEXT'], ['joined_at', 'INTEGER']]) },
  account: { table: 'accounts', cols: def([['id', 'TEXT'], ['ledger_id', 'TEXT'], ['name', 'TEXT'], ['type', 'TEXT'], ['initial_balance', 'TEXT'], ['initial_date', 'INTEGER'], ['currency', 'TEXT'], ['include_in_net', 'INTEGER'], ['is_archived', 'INTEGER'], ['sort', 'INTEGER'], ['credit_bill_day', 'INTEGER'], ['credit_due_day', 'INTEGER'], ['credit_limit', 'TEXT'], ['balance_cached', 'TEXT']]) },
  category: { table: 'categories', cols: def([['id', 'TEXT'], ['ledger_id', 'TEXT'], ['parent_id', 'TEXT'], ['name', 'TEXT'], ['kind', 'TEXT'], ['icon', 'TEXT'], ['color', 'TEXT'], ['sort', 'INTEGER'], ['is_hidden', 'INTEGER'], ['is_preset', 'INTEGER']]) },
  tag: { table: 'tags', cols: def([['id', 'TEXT'], ['ledger_id', 'TEXT'], ['name', 'TEXT'], ['color', 'TEXT']]) },
  transaction: { table: 'transactions', cols: def([['id', 'TEXT'], ['ledger_id', 'TEXT'], ['user_id', 'TEXT'], ['member_id', 'TEXT'], ['type', 'TEXT'], ['amount', 'TEXT'], ['currency', 'TEXT'], ['amount_base', 'TEXT'], ['exchange_rate', 'TEXT'], ['category_id', 'TEXT'], ['account_id', 'TEXT'], ['to_account_id', 'TEXT'], ['happened_at', 'INTEGER'], ['note', 'TEXT'], ['is_refunded', 'INTEGER'], ['refund_of_id', 'TEXT'], ['reimburse_status', 'TEXT'], ['exclude_from_budget', 'INTEGER'], ['attachment_count', 'INTEGER'], ['source', 'TEXT']]) },
  budget: { table: 'budgets', cols: def([['id', 'TEXT'], ['ledger_id', 'TEXT'], ['period_type', 'TEXT'], ['period_start', 'INTEGER'], ['total_amount', 'TEXT'], ['currency', 'TEXT'], ['rollover', 'INTEGER']]) },
  savings_plan: { table: 'savings_plans', cols: def([['id', 'TEXT'], ['ledger_id', 'TEXT'], ['name', 'TEXT'], ['goal_amount', 'TEXT'], ['period_type', 'TEXT'], ['period_start', 'INTEGER'], ['period_end', 'INTEGER'], ['expected_income', 'TEXT'], ['baseline_months', 'INTEGER'], ['allocation', 'TEXT'], ['promo_months', 'TEXT'], ['promo_multiplier', 'TEXT'], ['exclude_oneoff', 'INTEGER'], ['linked_account_id', 'TEXT'], ['status', 'TEXT']]) },
  budget_item: { table: 'budget_items', cols: def([['id', 'TEXT'], ['budget_id', 'TEXT'], ['category_id', 'TEXT'], ['amount', 'TEXT'], ['used_cached', 'TEXT']]) },
  recurring_rule: { table: 'recurring_rules', cols: def([['id', 'TEXT'], ['ledger_id', 'TEXT'], ['amount', 'TEXT'], ['category_id', 'TEXT'], ['account_id', 'TEXT'], ['note', 'TEXT'], ['frequency', 'TEXT'], ['interval', 'INTEGER'], ['next_run_at', 'INTEGER'], ['paused', 'INTEGER'], ['last_run_at', 'INTEGER']]) },
  attachment: { table: 'attachments', cols: def([['id', 'TEXT'], ['transaction_id', 'TEXT'], ['file_key', 'TEXT'], ['width', 'INTEGER'], ['height', 'INTEGER'], ['size', 'INTEGER'], ['sha256', 'TEXT'], ['upload_status', 'TEXT']]) },
  pending_transaction: { table: 'pending_transactions', cols: def([['id', 'TEXT'], ['ledger_id', 'TEXT'], ['source_type', 'TEXT'], ['raw', 'TEXT'], ['parsed', 'TEXT'], ['confidence', 'REAL'], ['dedupe_hash', 'TEXT'], ['status', 'TEXT']]), jsonCols: ['parsed'] },
  debt: { table: 'debts', cols: def([['id', 'TEXT'], ['ledger_id', 'TEXT'], ['direction', 'TEXT'], ['counterparty', 'TEXT'], ['principal', 'TEXT'], ['repaid', 'TEXT'], ['due_at', 'INTEGER'], ['transaction_id', 'TEXT']]) },
  reimbursement: { table: 'reimbursements', cols: def([['id', 'TEXT'], ['ledger_id', 'TEXT'], ['title', 'TEXT'], ['status', 'TEXT'], ['total_amount', 'TEXT'], ['transaction_ids', 'TEXT']]), jsonCols: ['transaction_ids'] },
};

export function ddlFor(kind: EntityKind): string {
  const t = TABLES[kind];
  const cols = t.cols.map(([n, ty]) => `${n === 'interval' ? '"interval"' : n} ${ty}`).join(', ');
  return `CREATE TABLE IF NOT EXISTS ${t.table} (${cols});`;
}

export function initSchemaSql(): string {
  const entityDdl = (Object.keys(TABLES) as EntityKind[]).map(ddlFor).join('\n');
  return `${entityDdl}
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT NOT NULL,
  client_version INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  device_id TEXT,
  base TEXT
);
-- 服务端 rejected 的变更死信隔离(上线前全检 B5/N1:与 apps/web Dexie deadletter 表同构)
CREATE TABLE IF NOT EXISTS deadletter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT NOT NULL,
  reason TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_entity_id_idx ON outbox (entity_id);
CREATE INDEX IF NOT EXISTS tx_happened_idx ON transactions (ledger_id, happened_at DESC);
CREATE INDEX IF NOT EXISTS category_ledger_idx ON categories (ledger_id);`;
}

/** 布尔 → 0/1,对象/数组 → JSON 字符串,undefined → null */
export function normalizeValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return v;
}

export function upsertSql(kind: EntityKind, row: AnyRow): { sql: string; params: unknown[] } {
  const t = TABLES[kind];
  const colSet = new Set(t.cols.map(([n]) => n));
  const cols = Object.keys(row).filter((k) => colSet.has(k));
  const sql = `INSERT OR REPLACE INTO ${t.table} (${cols.map((c) => (c === 'interval' ? '"interval"' : c)).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return { sql, params: cols.map((c) => normalizeValue(row[c])) };
}

/** 读出的行 → 应用层形状:JSON 列反解,布尔列还原 */
export function decodeRow(kind: EntityKind, row: AnyRow): AnyRow {
  const t = TABLES[kind];
  const out: AnyRow = { ...row };
  for (const jc of t.jsonCols ?? []) {
    if (typeof out[jc] === 'string') {
      try {
        out[jc] = JSON.parse(out[jc] as string);
      } catch {
        /* keep raw */
      }
    }
  }
  for (const [n, ty] of t.cols) {
    if (ty === 'INTEGER' && typeof out[n] === 'number' && (n === 'is_deleted' || n === 'paused' || n === 'rollover' || n === 'is_hidden' || n === 'is_preset' || n === 'is_archived' || n === 'include_in_net' || n === 'is_refunded' || n === 'exclude_from_budget')) {
      out[n] = out[n] === 1;
    }
  }
  return out;
}
