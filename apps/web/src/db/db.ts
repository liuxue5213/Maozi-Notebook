import Dexie, { type Table } from 'dexie';
import type {
  AccountRow, AttachmentRow, BudgetItemRow, BudgetRow, CategoryRow, ChangeOp, DebtRow,
  LedgerMemberRow, LedgerRow, PendingTransactionRow, ReimbursementRow, RecurringRuleRow,
  TagRow, TransactionRow,
} from '@ledgerone/domain';

export interface MetaEntry {
  key: string;
  value: unknown;
}

export interface DeadLetterEntry {
  id?: number;
  entity: string;
  entityId: string;
  op: string;
  payload: Record<string, unknown>;
  reason?: string;
  at: number;
}

export class LedgerDB extends Dexie {
  ledgers!: Table<LedgerRow, string>;
  members!: Table<LedgerMemberRow, string>;
  accounts!: Table<AccountRow, string>;
  categories!: Table<CategoryRow, string>;
  tags!: Table<TagRow, string>;
  transactions!: Table<TransactionRow, string>;
  budgets!: Table<BudgetRow, string>;
  budget_items!: Table<BudgetItemRow, string>;
  recurring_rules!: Table<RecurringRuleRow, string>;
  attachments!: Table<AttachmentRow, string>;
  pending_transactions!: Table<PendingTransactionRow, string>;
  debts!: Table<DebtRow, string>;
  reimbursements!: Table<ReimbursementRow, string>;
  outbox!: Table<ChangeOp & { seq?: number }, number>;
  deadletter!: Table<DeadLetterEntry, number>;
  meta!: Table<MetaEntry, string>;

  constructor() {
    super('ledgerone');
    this.version(1).stores({
      ledgers: 'id, server_version',
      members: 'id, user_id, ledger_id',
      accounts: 'id, ledger_id, server_version',
      categories: 'id, ledger_id, kind, sort',
      tags: 'id, ledger_id',
      transactions: 'id, ledger_id, happened_at, type, account_id, category_id, server_version',
      budgets: 'id, ledger_id',
      budget_items: 'id, budget_id',
      recurring_rules: 'id, ledger_id, next_run_at',
      attachments: 'id, transaction_id',
      pending_transactions: 'id, ledger_id, status',
      debts: 'id, ledger_id',
      reimbursements: 'id, ledger_id',
      outbox: '++seq, entity, entityId',
      meta: 'key',
    });
    // v2:同步被服务端拒绝的死信隔离(不重试、不阻塞后续,人工排查)
    this.version(2).stores({
      deadletter: '++id, entityId, at',
    });
  }
}

export const db = new LedgerDB();

/* eslint-disable @typescript-eslint/no-explicit-any */
export const TABLE_BY_ENTITY: Record<string, Table<any, string> | undefined> = {
  ledger: db.ledgers,
  ledger_member: db.members,
  account: db.accounts,
  category: db.categories,
  tag: db.tags,
  transaction: db.transactions,
  budget: db.budgets,
  budget_item: db.budget_items,
  recurring_rule: db.recurring_rules,
  attachment: db.attachments,
  pending_transaction: db.pending_transactions,
  debt: db.debts,
  reimbursement: db.reimbursements,
};
