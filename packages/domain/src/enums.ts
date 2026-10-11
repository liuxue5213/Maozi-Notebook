export const TRANSACTION_TYPES = ['expense', 'income', 'transfer'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const LEDGER_TYPES = ['personal', 'family', 'business', 'project'] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

export const LEDGER_ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type LedgerRole = (typeof LEDGER_ROLES)[number];

export const ACCOUNT_TYPES = ['cash', 'debit_card', 'credit_card', 'wallet', 'investment', 'receivable', 'payable'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  cash: '现金',
  debit_card: '储蓄卡',
  credit_card: '信用卡',
  wallet: '储值卡/电子钱包',
  investment: '投资账户',
  receivable: '应收(借出)',
  payable: '应付(借入)',
};

export const CATEGORY_KINDS = ['expense', 'income'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const TRANSACTION_SOURCES = ['manual', 'import', 'auto', 'recurring', 'split'] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

export const REIMBURSE_STATUSES = ['none', 'pending', 'done'] as const;
export type ReimburseStatus = (typeof REIMBURSE_STATUSES)[number];

export const BUDGET_PERIOD_TYPES = ['weekly', 'monthly', 'quarterly', 'yearly', 'custom'] as const;
export type BudgetPeriodType = (typeof BUDGET_PERIOD_TYPES)[number];

export const RECURRING_FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

export const ATTACHMENT_UPLOAD_STATUSES = ['local', 'uploading', 'done', 'failed'] as const;
export type AttachmentUploadStatus = (typeof ATTACHMENT_UPLOAD_STATUSES)[number];

export const PENDING_SOURCES = ['import', 'sms', 'notification', 'email', 'ocr'] as const;
export type PendingSource = (typeof PENDING_SOURCES)[number];

export const PENDING_STATUSES = ['pending', 'confirmed', 'ignored'] as const;
export type PendingStatus = (typeof PENDING_STATUSES)[number];

export const DEBT_DIRECTIONS = ['in', 'out'] as const;
export type DebtDirection = (typeof DEBT_DIRECTIONS)[number];

export const REIMBURSEMENT_STATUSES = ['pending', 'submitted', 'received'] as const;
export type ReimbursementStatus = (typeof REIMBURSEMENT_STATUSES)[number];

export const SAVINGS_ALLOCATIONS = ['even', 'promo'] as const;
export type SavingsAllocation = (typeof SAVINGS_ALLOCATIONS)[number];
export const SAVINGS_PLAN_STATUSES = ['active', 'paused', 'achieved', 'archived'] as const;
export type SavingsPlanStatus = (typeof SAVINGS_PLAN_STATUSES)[number];
