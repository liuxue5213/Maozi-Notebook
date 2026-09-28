import { pgTable, text, integer, bigint, boolean, numeric, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * 字段命名与客户端/PRD 5.2 保持 snake_case 一致,同步层无需再做键名映射。
 * 时间一律 UTC 毫秒(PRD 7.2),金额一律 numeric 定点字符串(PRD 5.2)。
 */
const timeMs = (name: string) => bigint(name, { mode: 'number' });

const syncCols = {
  client_version: integer('client_version').notNull().default(1),
  server_version: bigint('server_version', { mode: 'number' }),
  is_deleted: boolean('is_deleted').notNull().default(false),
  deleted_at: timeMs('deleted_at'),
  created_at: timeMs('created_at').notNull(),
  updated_at: timeMs('updated_at').notNull(),
};

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').unique(),
  phone: text('phone').unique(),
  password_hash: text('password_hash'),
  nickname: text('nickname').notNull().default(''),
  avatar_url: text('avatar_url'),
  base_currency: text('base_currency').notNull().default('CNY'),
  /** 同步游标源:全局单调递增,下行按 server_version > cursor 增量拉取 */
  version_seq: bigint('version_seq', { mode: 'number' }).notNull().default(0),
  status: text('status').notNull().default('active'),
  created_at: timeMs('created_at').notNull(),
  updated_at: timeMs('updated_at').notNull(),
});

export const ledgers = pgTable('ledgers', {
  id: text('id').primaryKey(),
  owner_user_id: text('owner_user_id').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull().default('personal'),
  icon: text('icon'),
  sort: integer('sort').notNull().default(0),
  ...syncCols,
});

export const ledger_members = pgTable(
  'ledger_members',
  {
    id: text('id').primaryKey(),
    ledger_id: text('ledger_id').notNull(),
    user_id: text('user_id').notNull(),
    role: text('role').notNull().default('viewer'),
    nickname_in_ledger: text('nickname_in_ledger'),
    joined_at: timeMs('joined_at').notNull(),
    ...syncCols,
  },
  (t) => [uniqueIndex('member_ledger_user_uq').on(t.ledger_id, t.user_id)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    ledger_id: text('ledger_id').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull().default('cash'),
    initial_balance: numeric('initial_balance', { precision: 18, scale: 4 }).notNull().default('0'),
    initial_date: timeMs('initial_date').notNull(),
    currency: text('currency').notNull().default('CNY'),
    include_in_net: boolean('include_in_net').notNull().default(true),
    is_archived: boolean('is_archived').notNull().default(false),
    sort: integer('sort').notNull().default(0),
    credit_bill_day: integer('credit_bill_day'),
    credit_due_day: integer('credit_due_day'),
    credit_limit: numeric('credit_limit', { precision: 18, scale: 4 }),
    balance_cached: numeric('balance_cached', { precision: 18, scale: 4 }),
    ...syncCols,
  },
  (t) => [index('account_ledger_idx').on(t.ledger_id)],
);

export const categories = pgTable(
  'categories',
  {
    id: text('id').primaryKey(),
    ledger_id: text('ledger_id').notNull(),
    parent_id: text('parent_id'),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('expense'),
    icon: text('icon').notNull().default('📦'),
    color: text('color'),
    sort: integer('sort').notNull().default(0),
    is_hidden: boolean('is_hidden').notNull().default(false),
    is_preset: boolean('is_preset').notNull().default(false),
    ...syncCols,
  },
  (t) => [index('category_ledger_idx').on(t.ledger_id)],
);

export const tags = pgTable(
  'tags',
  {
    id: text('id').primaryKey(),
    ledger_id: text('ledger_id').notNull(),
    name: text('name').notNull(),
    color: text('color'),
    ...syncCols,
  },
  (t) => [index('tag_ledger_idx').on(t.ledger_id)],
);

export const transactions = pgTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    ledger_id: text('ledger_id').notNull(),
    user_id: text('user_id').notNull(),
    member_id: text('member_id'),
    type: text('type').notNull(),
    /** 一律存正数,方向由 type 决定 */
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    currency: text('currency').notNull().default('CNY'),
    amount_base: numeric('amount_base', { precision: 18, scale: 4 }).notNull(),
    exchange_rate: numeric('exchange_rate', { precision: 18, scale: 8 }),
    category_id: text('category_id'),
    account_id: text('account_id').notNull(),
    to_account_id: text('to_account_id'),
    happened_at: timeMs('happened_at').notNull(),
    note: text('note'),
    is_refunded: boolean('is_refunded').notNull().default(false),
    refund_of_id: text('refund_of_id'),
    reimburse_status: text('reimburse_status'),
    exclude_from_budget: boolean('exclude_from_budget').notNull().default(false),
    attachment_count: integer('attachment_count').notNull().default(0),
    source: text('source').notNull().default('manual'),
    ...syncCols,
  },
  (t) => [
    // PRD 5.6 必备索引
    index('tx_ledger_happened_idx').on(t.ledger_id, t.happened_at),
    index('tx_category_happened_idx').on(t.category_id, t.happened_at),
    index('tx_account_idx').on(t.account_id),
  ],
);

export const transaction_tags = pgTable(
  'transaction_tags',
  {
    transaction_id: text('transaction_id').notNull(),
    tag_id: text('tag_id').notNull(),
  },
  (t) => [uniqueIndex('tx_tag_uq').on(t.transaction_id, t.tag_id)],
);

export const budgets = pgTable(
  'budgets',
  {
    id: text('id').primaryKey(),
    ledger_id: text('ledger_id').notNull(),
    period_type: text('period_type').notNull().default('monthly'),
    period_start: timeMs('period_start').notNull(),
    total_amount: numeric('total_amount', { precision: 18, scale: 4 }).notNull(),
    currency: text('currency').notNull().default('CNY'),
    rollover: boolean('rollover').notNull().default(false),
    ...syncCols,
  },
  (t) => [index('budget_ledger_idx').on(t.ledger_id)],
);

export const budget_items = pgTable(
  'budget_items',
  {
    id: text('id').primaryKey(),
    budget_id: text('budget_id').notNull(),
    category_id: text('category_id').notNull(),
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    used_cached: numeric('used_cached', { precision: 18, scale: 4 }),
    ...syncCols,
  },
  (t) => [uniqueIndex('budget_item_uq').on(t.budget_id, t.category_id)],
);

export const recurring_rules = pgTable(
  'recurring_rules',
  {
    id: text('id').primaryKey(),
    ledger_id: text('ledger_id').notNull(),
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    category_id: text('category_id'),
    account_id: text('account_id').notNull(),
    note: text('note'),
    frequency: text('frequency').notNull().default('monthly'),
    interval: integer('interval').notNull().default(1),
    next_run_at: timeMs('next_run_at').notNull(),
    paused: boolean('paused').notNull().default(false),
    last_run_at: timeMs('last_run_at'),
    ...syncCols,
  },
  (t) => [index('recurring_ledger_idx').on(t.ledger_id)],
);

export const attachments = pgTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    transaction_id: text('transaction_id').notNull(),
    file_key: text('file_key').notNull(),
    width: integer('width'),
    height: integer('height'),
    size: integer('size'),
    sha256: text('sha256'),
    upload_status: text('upload_status').notNull().default('local'),
    ...syncCols,
  },
  (t) => [index('attachment_tx_idx').on(t.transaction_id)],
);

export const pending_transactions = pgTable(
  'pending_transactions',
  {
    id: text('id').primaryKey(),
    ledger_id: text('ledger_id').notNull(),
    source_type: text('source_type').notNull().default('import'),
    raw: text('raw'),
    parsed: jsonb('parsed'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    dedupe_hash: text('dedupe_hash'),
    status: text('status').notNull().default('pending'),
    ...syncCols,
  },
  (t) => [
    uniqueIndex('pending_dedupe_uq').on(t.ledger_id, t.dedupe_hash),
    index('pending_ledger_idx').on(t.ledger_id),
  ],
);

export const debts = pgTable(
  'debts',
  {
    id: text('id').primaryKey(),
    ledger_id: text('ledger_id').notNull(),
    direction: text('direction').notNull(),
    counterparty: text('counterparty').notNull(),
    principal: numeric('principal', { precision: 18, scale: 4 }).notNull(),
    repaid: numeric('repaid', { precision: 18, scale: 4 }).notNull().default('0'),
    due_at: timeMs('due_at'),
    transaction_id: text('transaction_id'),
    ...syncCols,
  },
  (t) => [index('debt_ledger_idx').on(t.ledger_id)],
);

export const reimbursements = pgTable(
  'reimbursements',
  {
    id: text('id').primaryKey(),
    ledger_id: text('ledger_id').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull().default('pending'),
    total_amount: numeric('total_amount', { precision: 18, scale: 4 }).notNull(),
    transaction_ids: jsonb('transaction_ids').notNull().default([]),
    ...syncCols,
  },
  (t) => [index('reimbursement_ledger_idx').on(t.ledger_id)],
);

/** 同步变更日志(PRD 5.1 sync_change):增量同步与冲突排查 */
export const sync_changes = pgTable(
  'sync_changes',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    entity: text('entity').notNull(),
    entity_id: text('entity_id').notNull(),
    op: text('op').notNull(),
    client_version: integer('client_version').notNull(),
    server_version: bigint('server_version', { mode: 'number' }).notNull(),
    conflict: boolean('conflict').notNull().default(false),
    payload: jsonb('payload'),
    created_at: timeMs('created_at').notNull(),
  },
  (t) => [index('sync_change_user_idx').on(t.user_id, t.server_version)],
);

/** 共享账本审计(PRD 6.3) */
export const audit_logs = pgTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    ledger_id: text('ledger_id').notNull(),
    actor_user_id: text('actor_user_id').notNull(),
    action: text('action').notNull(),
    target_entity: text('target_entity'),
    summary: jsonb('summary'),
    created_at: timeMs('created_at').notNull(),
  },
  (t) => [index('audit_ledger_idx').on(t.ledger_id, t.created_at)],
);

export const refresh_tokens = pgTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    token_hash: text('token_hash').notNull().unique(),
    expires_at: timeMs('expires_at').notNull(),
    revoked_at: timeMs('revoked_at'),
    created_at: timeMs('created_at').notNull(),
  },
  (t) => [index('refresh_user_idx').on(t.user_id)],
);

export const phone_codes = pgTable('phone_codes', {
  phone: text('phone').primaryKey(),
  /** 只存 HMAC 摘要,不存明文(F-06) */
  code_hash: text('code_hash').notNull(),
  /** 验证失败次数(达到 CODE_MAX_ATTEMPTS 即写入 locked_until) */
  attempts: integer('attempts').notNull().default(0),
  /**
   * 锁定截止时间戳(F-06):连续失败 5 次后锁定 15 分钟。
   * 锁定期间既拒绝校验也拒绝重发 —— 否则攻击者等 60s 重发即可绕过锁定,
   * 使「5 次锁定」退化成「60 秒锁定」。解锁只能靠时间到期或成功重发(锁定外)。
   */
  locked_until: timeMs('locked_until').notNull().default(0),
  /** 冷却:60s 内不允许重发(F-07) */
  last_sent_at: timeMs('last_sent_at').notNull().default(0),
  expires_at: timeMs('expires_at').notNull(),
  used: boolean('used').notNull().default(false),
  created_at: timeMs('created_at').notNull(),
});
