import type {
  AccountType, BudgetPeriodType, CategoryKind, DebtDirection, LedgerRole, LedgerType,
  PendingSource, PendingStatus, RecurringFrequency, ReimburseStatus, ReimbursementStatus,
  AttachmentUploadStatus, TransactionSource, TransactionType,
} from './enums';

/** 同步元字段:所有可同步实体共有(PRD 5.2 client_version / server_version / 软删除) */
export interface SyncMeta {
  client_version: number;
  server_version?: number | null;
  is_deleted: boolean;
  deleted_at?: number | null;
  created_at: number;
  updated_at: number;
}

export interface LedgerRow extends SyncMeta {
  id: string;
  owner_user_id: string;
  name: string;
  type: LedgerType;
  icon?: string | null;
  sort: number;
}

export interface LedgerMemberRow extends SyncMeta {
  id: string;
  ledger_id: string;
  user_id: string;
  role: LedgerRole;
  nickname_in_ledger?: string | null;
  joined_at: number;
}

export interface AccountRow extends SyncMeta {
  id: string;
  ledger_id: string;
  name: string;
  type: AccountType;
  initial_balance: string;
  initial_date: number;
  currency: string;
  include_in_net: boolean;
  is_archived: boolean;
  sort: number;
  credit_bill_day?: number | null;
  credit_due_day?: number | null;
  credit_limit?: string | null;
  balance_cached?: string | null;
}

export interface CategoryRow extends SyncMeta {
  id: string;
  ledger_id: string;
  parent_id: string | null;
  name: string;
  kind: CategoryKind;
  icon: string;
  color?: string | null;
  sort: number;
  is_hidden: boolean;
  is_preset: boolean;
}

export interface TagRow extends SyncMeta {
  id: string;
  ledger_id: string;
  name: string;
  color?: string | null;
}

export interface TransactionRow extends SyncMeta {
  id: string;
  ledger_id: string;
  user_id: string;
  member_id?: string | null;
  type: TransactionType;
  /** 一律存正数,方向由 type 决定(PRD 5.2) */
  amount: string;
  currency: string;
  /** 折算主币种金额,统计按此字段 */
  amount_base: string;
  exchange_rate?: string | null;
  category_id?: string | null;
  account_id: string;
  to_account_id?: string | null;
  /** 业务发生时间(UTC ms),统计按此字段 */
  happened_at: number;
  note?: string;
  is_refunded: boolean;
  refund_of_id?: string | null;
  reimburse_status?: ReimburseStatus | null;
  exclude_from_budget: boolean;
  attachment_count: number;
  source: TransactionSource;
}

export interface BudgetRow extends SyncMeta {
  id: string;
  ledger_id: string;
  period_type: BudgetPeriodType;
  period_start: number;
  total_amount: string;
  currency: string;
  rollover: boolean;
}

export interface BudgetItemRow extends SyncMeta {
  id: string;
  budget_id: string;
  category_id: string;
  amount: string;
  used_cached?: string | null;
}

export interface RecurringRuleRow extends SyncMeta {
  id: string;
  ledger_id: string;
  amount: string;
  category_id?: string | null;
  account_id: string;
  note?: string | null;
  frequency: RecurringFrequency;
  interval: number;
  next_run_at: number;
  paused: boolean;
  last_run_at?: number | null;
}

export interface AttachmentRow extends SyncMeta {
  id: string;
  transaction_id: string;
  file_key: string;
  width?: number | null;
  height?: number | null;
  size?: number | null;
  sha256?: string | null;
  upload_status: AttachmentUploadStatus;
}

export interface PendingTransactionRow extends SyncMeta {
  id: string;
  ledger_id: string;
  source_type: PendingSource;
  raw?: string | null;
  parsed: unknown;
  confidence?: number | null;
  /** hash(金额 + 分钟级时间 + 账户 + 商户)(PRD 5.2) */
  dedupe_hash?: string | null;
  status: PendingStatus;
}

export interface DebtRow extends SyncMeta {
  id: string;
  ledger_id: string;
  direction: DebtDirection;
  counterparty: string;
  principal: string;
  repaid: string;
  due_at?: number | null;
  transaction_id?: string | null;
}

export interface ReimbursementRow extends SyncMeta {
  id: string;
  ledger_id: string;
  title: string;
  status: ReimbursementStatus;
  total_amount: string;
  transaction_ids: string[];
}

/** 存钱计划(需求 V1.1-a,第 32 轮):与预算正交 —— 预算管支出上限,存钱管结余下限 */
export interface SavingsPlanRow extends SyncMeta {
  id: string;
  ledger_id: string;
  name: string;
  goal_amount: string;
  period_type: 'yearly' | 'monthly';
  period_start: number;
  period_end: number;
  /** 手动月收入兜底(无 income 流水时必填并标注来源) */
  expected_income?: string | null;
  baseline_months: number;
  allocation: 'even' | 'promo';
  promo_months?: number[] | null;
  promo_multiplier?: string | null;
  exclude_oneoff: boolean;
  /** 本期不启用,仅占位 */
  linked_account_id?: string | null;
  status: 'active' | 'paused' | 'achieved' | 'archived';
}
