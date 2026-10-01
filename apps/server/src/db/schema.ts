import { mysqlTable, varchar, text, int, bigint, boolean, decimal, json, index, uniqueIndex } from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';

/**
 * 字段命名与客户端/PRD 5.2 保持 snake_case 一致,同步层无需再做键名映射。
 * 时间一律 UTC 毫秒(PRD 7.2),金额一律 decimal 定点字符串(PRD 5.2)。
 */
const timeMs = (name: string) => bigint(name, { mode: 'number' });

const syncCols = {
  client_version: int('client_version').notNull().default(1),
  server_version: bigint('server_version', { mode: 'number' }),
  is_deleted: boolean('is_deleted').notNull().default(false),
  deleted_at: timeMs('deleted_at'),
  created_at: timeMs('created_at').notNull(),
  updated_at: timeMs('updated_at').notNull(),
};

export const users = mysqlTable('users', {
  id: varchar('id', { length: 128 }).primaryKey(),
  email: varchar('email', { length: 191 }).unique(),
  phone: varchar('phone', { length: 191 }).unique(),
  password_hash: text('password_hash'),
  nickname: varchar('nickname', { length: 191 }).notNull().default(''),
  avatar_url: text('avatar_url'),
  base_currency: varchar('base_currency', { length: 191 }).notNull().default('CNY'),
  /** 同步游标源:全局单调递增,下行按 server_version > cursor 增量拉取 */
  version_seq: bigint('version_seq', { mode: 'number' }).notNull().default(0),
  status: varchar('status', { length: 191 }).notNull().default('active'),
  created_at: timeMs('created_at').notNull(),
  updated_at: timeMs('updated_at').notNull(),
});

export const ledgers = mysqlTable('ledgers', {
  id: varchar('id', { length: 128 }).primaryKey(),
  owner_user_id: varchar('owner_user_id', { length: 128 }).notNull(),
  name: varchar('name', { length: 191 }).notNull(),
  type: varchar('type', { length: 191 }).notNull().default('personal'),
  icon: varchar('icon', { length: 191 }),
  sort: int('sort').notNull().default(0),
  ...syncCols,
}, (t) => [index('ledger_lv_idx').on(t.server_version)]);

export const ledger_members = mysqlTable(
  'ledger_members',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    ledger_id: varchar('ledger_id', { length: 128 }).notNull(),
    user_id: varchar('user_id', { length: 128 }).notNull(),
    role: varchar('role', { length: 191 }).notNull().default('viewer'),
    nickname_in_ledger: varchar('nickname_in_ledger', { length: 191 }),
    joined_at: timeMs('joined_at').notNull(),
    active_key: int('active_key').generatedAlwaysAs(sql`case when is_deleted = 0 then 1 else null end`),
    ...syncCols,
  },
  (t) => [uniqueIndex('member_ledger_user_uq').on(t.ledger_id, t.user_id, t.active_key), index('member_user_idx').on(t.user_id, t.is_deleted)],
);

export const accounts = mysqlTable(
  'accounts',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    ledger_id: varchar('ledger_id', { length: 128 }).notNull(),
    name: varchar('name', { length: 191 }).notNull(),
    type: varchar('type', { length: 191 }).notNull().default('cash'),
    initial_balance: decimal('initial_balance', { precision: 18, scale: 4 }).notNull().default('0'),
    initial_date: timeMs('initial_date').notNull(),
    currency: varchar('currency', { length: 191 }).notNull().default('CNY'),
    include_in_net: boolean('include_in_net').notNull().default(true),
    is_archived: boolean('is_archived').notNull().default(false),
    sort: int('sort').notNull().default(0),
    credit_bill_day: int('credit_bill_day'),
    credit_due_day: int('credit_due_day'),
    credit_limit: decimal('credit_limit', { precision: 18, scale: 4 }),
    balance_cached: decimal('balance_cached', { precision: 18, scale: 4 }),
    ...syncCols,
  },
  (t) => [index('account_ledger_idx').on(t.ledger_id), index('account_lv_idx').on(t.ledger_id, t.server_version)],
);

export const categories = mysqlTable(
  'categories',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    ledger_id: varchar('ledger_id', { length: 128 }).notNull(),
    parent_id: varchar('parent_id', { length: 128 }),
    name: varchar('name', { length: 191 }).notNull(),
    kind: varchar('kind', { length: 191 }).notNull().default('expense'),
    icon: varchar('icon', { length: 191 }).notNull().default('📦'),
    color: varchar('color', { length: 191 }),
    sort: int('sort').notNull().default(0),
    is_hidden: boolean('is_hidden').notNull().default(false),
    is_preset: boolean('is_preset').notNull().default(false),
    ...syncCols,
  },
  (t) => [index('category_ledger_idx').on(t.ledger_id), index('category_lv_idx').on(t.ledger_id, t.server_version)],
);

export const tags = mysqlTable(
  'tags',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    ledger_id: varchar('ledger_id', { length: 128 }).notNull(),
    name: varchar('name', { length: 191 }).notNull(),
    color: varchar('color', { length: 191 }),
    ...syncCols,
  },
  (t) => [index('tag_ledger_idx').on(t.ledger_id), index('tag_lv_idx').on(t.ledger_id, t.server_version)],
);

export const transactions = mysqlTable(
  'transactions',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    ledger_id: varchar('ledger_id', { length: 128 }).notNull(),
    user_id: varchar('user_id', { length: 128 }).notNull(),
    member_id: varchar('member_id', { length: 128 }),
    type: varchar('type', { length: 191 }).notNull(),
    /** 一律存正数,方向由 type 决定 */
    amount: decimal('amount', { precision: 18, scale: 4 }).notNull(),
    currency: varchar('currency', { length: 191 }).notNull().default('CNY'),
    amount_base: decimal('amount_base', { precision: 18, scale: 4 }).notNull(),
    exchange_rate: decimal('exchange_rate', { precision: 18, scale: 8 }),
    category_id: varchar('category_id', { length: 128 }),
    account_id: varchar('account_id', { length: 128 }).notNull(),
    to_account_id: varchar('to_account_id', { length: 128 }),
    happened_at: timeMs('happened_at').notNull(),
    note: text('note'),
    is_refunded: boolean('is_refunded').notNull().default(false),
    refund_of_id: varchar('refund_of_id', { length: 128 }),
    reimburse_status: varchar('reimburse_status', { length: 191 }),
    exclude_from_budget: boolean('exclude_from_budget').notNull().default(false),
    attachment_count: int('attachment_count').notNull().default(0),
    source: varchar('source', { length: 191 }).notNull().default('manual'),
    ...syncCols,
  },
  (t) => [
    // PRD 5.6 必备索引
    index('tx_ledger_happened_idx').on(t.ledger_id, t.happened_at),
    index('tx_category_happened_idx').on(t.category_id, t.happened_at),
    index('tx_account_idx').on(t.account_id),
    index('tx_lv_idx').on(t.ledger_id, t.server_version),
  ],
);

export const transaction_tags = mysqlTable(
  'transaction_tags',
  {
    transaction_id: varchar('transaction_id', { length: 128 }).notNull(),
    tag_id: varchar('tag_id', { length: 128 }).notNull(),
  },
  (t) => [uniqueIndex('tx_tag_uq').on(t.transaction_id, t.tag_id)],
);

export const budgets = mysqlTable(
  'budgets',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    ledger_id: varchar('ledger_id', { length: 128 }).notNull(),
    period_type: varchar('period_type', { length: 191 }).notNull().default('monthly'),
    period_start: timeMs('period_start').notNull(),
    total_amount: decimal('total_amount', { precision: 18, scale: 4 }).notNull(),
    currency: varchar('currency', { length: 191 }).notNull().default('CNY'),
    rollover: boolean('rollover').notNull().default(false),
    ...syncCols,
  },
  (t) => [index('budget_ledger_idx').on(t.ledger_id), index('budget_lv_idx').on(t.ledger_id, t.server_version)],
);

export const budget_items = mysqlTable(
  'budget_items',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    budget_id: varchar('budget_id', { length: 128 }).notNull(),
    category_id: varchar('category_id', { length: 128 }).notNull(),
    amount: decimal('amount', { precision: 18, scale: 4 }).notNull(),
    used_cached: decimal('used_cached', { precision: 18, scale: 4 }),
    active_key: int('active_key').generatedAlwaysAs(sql`case when is_deleted = 0 then 1 else null end`),
    ...syncCols,
  },
  (t) => [uniqueIndex('budget_item_uq').on(t.budget_id, t.category_id, t.active_key)],
);

export const recurring_rules = mysqlTable(
  'recurring_rules',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    ledger_id: varchar('ledger_id', { length: 128 }).notNull(),
    amount: decimal('amount', { precision: 18, scale: 4 }).notNull(),
    category_id: varchar('category_id', { length: 128 }),
    account_id: varchar('account_id', { length: 128 }).notNull(),
    note: text('note'),
    frequency: varchar('frequency', { length: 191 }).notNull().default('monthly'),
    interval: int('interval').notNull().default(1),
    next_run_at: timeMs('next_run_at').notNull(),
    paused: boolean('paused').notNull().default(false),
    last_run_at: timeMs('last_run_at'),
    ...syncCols,
  },
  (t) => [index('recurring_ledger_idx').on(t.ledger_id), index('recurring_lv_idx').on(t.ledger_id, t.server_version)],
);

export const attachments = mysqlTable(
  'attachments',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    transaction_id: varchar('transaction_id', { length: 128 }).notNull(),
    file_key: text('file_key').notNull(),
    width: int('width'),
    height: int('height'),
    size: int('size'),
    sha256: varchar('sha256', { length: 191 }),
    upload_status: varchar('upload_status', { length: 191 }).notNull().default('local'),
    ...syncCols,
  },
  (t) => [index('attachment_tx_idx').on(t.transaction_id)],
);

export const pending_transactions = mysqlTable(
  'pending_transactions',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    ledger_id: varchar('ledger_id', { length: 128 }).notNull(),
    source_type: varchar('source_type', { length: 191 }).notNull().default('import'),
    raw: text('raw'),
    parsed: json('parsed'),
    confidence: decimal('confidence', { precision: 4, scale: 3 }),
    dedupe_hash: varchar('dedupe_hash', { length: 191 }),
    status: varchar('status', { length: 191 }).notNull().default('pending'),
    active_key: int('active_key').generatedAlwaysAs(sql`case when is_deleted = 0 then 1 else null end`),
    ...syncCols,
  },
  (t) => [
    uniqueIndex('pending_dedupe_uq').on(t.ledger_id, t.dedupe_hash, t.active_key),
    index('pending_ledger_idx').on(t.ledger_id), index('pending_lv_idx').on(t.ledger_id, t.server_version),
  ],
);

export const debts = mysqlTable(
  'debts',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    ledger_id: varchar('ledger_id', { length: 128 }).notNull(),
    direction: varchar('direction', { length: 191 }).notNull(),
    counterparty: varchar('counterparty', { length: 191 }).notNull(),
    principal: decimal('principal', { precision: 18, scale: 4 }).notNull(),
    repaid: decimal('repaid', { precision: 18, scale: 4 }).notNull().default('0'),
    due_at: timeMs('due_at'),
    transaction_id: varchar('transaction_id', { length: 128 }),
    ...syncCols,
  },
  (t) => [index('debt_ledger_idx').on(t.ledger_id), index('debt_lv_idx').on(t.ledger_id, t.server_version)],
);

export const reimbursements = mysqlTable(
  'reimbursements',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    ledger_id: varchar('ledger_id', { length: 128 }).notNull(),
    title: varchar('title', { length: 191 }).notNull(),
    status: varchar('status', { length: 191 }).notNull().default('pending'),
    total_amount: decimal('total_amount', { precision: 18, scale: 4 }).notNull(),
    transaction_ids: json('transaction_ids').notNull(),
    ...syncCols,
  },
  (t) => [index('reimbursement_ledger_idx').on(t.ledger_id), index('reimbursement_lv_idx').on(t.ledger_id, t.server_version)],
);

/** 同步变更日志(PRD 5.1 sync_change):增量同步与冲突排查 */
export const sync_changes = mysqlTable(
  'sync_changes',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    user_id: varchar('user_id', { length: 128 }).notNull(),
    entity: varchar('entity', { length: 191 }).notNull(),
    entity_id: varchar('entity_id', { length: 128 }).notNull(),
    op: varchar('op', { length: 191 }).notNull(),
    client_version: int('client_version').notNull(),
    server_version: bigint('server_version', { mode: 'number' }).notNull(),
    conflict: boolean('conflict').notNull().default(false),
    payload: json('payload'),
    created_at: timeMs('created_at').notNull(),
  },
  (t) => [index('sync_change_user_idx').on(t.user_id, t.server_version)],
);

/**
 * 审计日志(PRD 6.3 共享账本审计 + 上线全检安全审计):
 * - 账本类事件(成员变更/越权尝试)填 ledger_id + actor_user_id;
 * - 鉴权类事件(登录失败/锁定/refresh 轮换)无账本维度,两者可空,标识脱敏后入 summary/target_entity。
 */
export const audit_logs = mysqlTable(
  'audit_logs',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    ledger_id: varchar('ledger_id', { length: 128 }),
    actor_user_id: varchar('actor_user_id', { length: 128 }),
    action: varchar('action', { length: 191 }).notNull(),
    target_entity: varchar('target_entity', { length: 191 }),
    summary: json('summary'),
    created_at: timeMs('created_at').notNull(),
  },
  (t) => [index('audit_ledger_idx').on(t.ledger_id, t.created_at), index('audit_action_idx').on(t.action, t.created_at)],
);

export const refresh_tokens = mysqlTable(
  'refresh_tokens',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    user_id: varchar('user_id', { length: 128 }).notNull(),
    token_hash: varchar('token_hash', { length: 191 }).notNull().unique(),
    expires_at: timeMs('expires_at').notNull(),
    revoked_at: timeMs('revoked_at'),
    created_at: timeMs('created_at').notNull(),
  },
  (t) => [index('refresh_user_idx').on(t.user_id)],
);

export const phone_codes = mysqlTable('phone_codes', {
  phone: varchar('phone', { length: 191 }).primaryKey(),
  /** 只存 HMAC 摘要,不存明文(F-06) */
  code_hash: varchar('code_hash', { length: 191 }).notNull(),
  /** 验证失败次数(达到 CODE_MAX_ATTEMPTS 即写入 locked_until) */
  attempts: int('attempts').notNull().default(0),
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

/**
 * 邮箱密码登录按账号失败锁定(P1-11,Review):与验证码锁定(F-06)同语义 ——
 * 5 次失败锁 15 分钟。全局限流按 IP,挡不住针对单一账号的多 IP 分布式撞库。
 */
export const login_locks = mysqlTable('login_locks', {
  /** 归一化邮箱(小写)作主键 */
  email: varchar('email', { length: 191 }).primaryKey(),
  /** 连续失败次数(成功登录即删行清零) */
  attempts: int('attempts').notNull().default(0),
  locked_until: timeMs('locked_until').notNull().default(0),
  updated_at: timeMs('updated_at').notNull(),
});

/**
 * 全局同步序号(P0-4 修复)。
 *
 * 原实现:`server_version` 由「每用户一行计数器」`users.version_seq` 分配,
 * 而 pull 用**单一游标**跨共享账本成员消费所有成员写入的行 —— 两个成员的计数器彼此独立,
 * 后加入成员的行号必然小于先加入者已推进的游标,导致**其数据永不下发**(第 20 轮 it.fails 固化)。
 *
 * 改为单行全局计数器后,所有行共享同一单调命名空间,单游标即可正确消费;
 * `PullResponse` 协议不变,三端零改造。
 */
export const sync_seq = mysqlTable('sync_seq', {
  /** 固定单值 'global':单行表,作为全库唯一的序号源 */
  id: varchar('id', { length: 128 }).primaryKey(),
  /** 已分配到的最大序号;reserveSeq 以 `seq = seq + n` 原子递增 */
  seq: bigint('seq', { mode: 'number' }).notNull().default(0),
});

/**
 * 存钱计划(需求 V1.1-a,第 32 轮):与预算正交 —— 预算管支出上限,存钱管结余下限。
 * 禁止复用 budgets 表(语义打架,详见需求分析 3.3 方案对比)。
 */
export const savings_plans = mysqlTable(
  'savings_plans',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    ledger_id: varchar('ledger_id', { length: 128 }).notNull(),
    name: varchar('name', { length: 191 }).notNull(),
    /** 目标金额 decimal(18,4) */
    goal_amount: decimal('goal_amount', { precision: 18, scale: 4 }).notNull(),
    /** 年度/月度 */
    period_type: varchar('period_type', { length: 191 }).notNull().default('yearly'),
    /** 区间左闭右开(UTC 毫秒) */
    period_start: timeMs('period_start').notNull(),
    period_end: timeMs('period_end').notNull(),
    /** 手动月收入兜底(无 income 流水时强制引导填写,禁止按 0 计算) */
    expected_income: decimal('expected_income', { precision: 18, scale: 4 }),
    /** 基线取样月数(默认 6,最小 3) */
    baseline_months: int('baseline_months').notNull().default(6),
    /** 分解策略:even=纯均分;promo=均分+促销月缓冲 */
    allocation: varchar('allocation', { length: 191 }).notNull().default('even'),
    /** 促销月数组 json(如 [6,11],默认 618/双11) */
    promo_months: json('promo_months'),
    /** 促销月支出倍数(默认 1.75,范围 1.0–3.0,越界拒绝保存) */
    promo_multiplier: decimal('promo_multiplier', { precision: 4, scale: 2 }),
    /** 剔除一次性大额(默认 false;如刷漆 926.43 占当月 43% 场景) */
    exclude_oneoff: boolean('exclude_oneoff').notNull().default(false),
    /** 关联储蓄账户(本期不启用,仅占位 —— 口径 2 由 PM 决策不做) */
    linked_account_id: varchar('linked_account_id', { length: 128 }),
    status: varchar('status', { length: 191 }).notNull().default('active'),
    ...syncCols,
  },
  (t) => [index('savings_ledger_idx').on(t.ledger_id), index('savings_lv_idx').on(t.ledger_id, t.server_version)],
);
