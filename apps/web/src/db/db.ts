import Dexie, { type Table } from 'dexie';
import { installFieldEncryption } from '../crypto/secure-fields';
import { bindSweepTables } from '../crypto/keyring';
import type {
  AccountRow, AttachmentRow, BudgetItemRow, BudgetRow, CategoryRow, ChangeOp, DebtRow, SavingsPlanRow,
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
  savings_plans!: Table<SavingsPlanRow, string>;
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
    // v3(P0-4,第 28 轮):明细双下推复合索引 [ledger_id+happened_at] —— 切账本 + 日期范围均走索引
    this.version(3).stores({
      transactions: 'id, ledger_id, happened_at, type, account_id, category_id, server_version, [ledger_id+happened_at]',
    });
    // v4(第 32 轮):存钱计划(需求 V1.1-a 同步实体)
    this.version(4).stores({
      savings_plans: 'id, ledger_id, server_version',
    });
    // v5(O5 性能治理):is_deleted/deleted_at 索引 —— 回收站不再全表扫
    this.version(5).stores({
      transactions: 'id, ledger_id, happened_at, type, account_id, category_id, server_version, [ledger_id+happened_at], is_deleted, deleted_at',
    });
  }
}

export const db = new LedgerDB();

// 端侧字段级加密(F-05):敏感字段(备注/导入原文等)AES-GCM 落盘加密,
// 密钥由应用锁 PIN 派生(见 crypto/keyring.ts);未开启应用锁时字段保持明文。
installFieldEncryption(db);
bindSweepTables({
  transactions: db.transactions,
  pending_transactions: db.pending_transactions,
  outbox: db.outbox,
  deadletter: db.deadletter,
} as unknown as Record<string, { toArray: () => Promise<Record<string, unknown>[]>; bulkPut: (rows: unknown[]) => Promise<unknown> } | undefined>);

/* eslint-disable @typescript-eslint/no-explicit-any */
export const TABLE_BY_ENTITY: Record<string, Table<any, string> | undefined> = {
  ledger: db.ledgers,
  ledger_member: db.members,
  account: db.accounts,
  category: db.categories,
  tag: db.tags,
  transaction: db.transactions,
  budget: db.budgets,
  savings_plan: db.savings_plans,
  budget_item: db.budget_items,
  recurring_rule: db.recurring_rules,
  attachment: db.attachments,
  pending_transaction: db.pending_transactions,
  debt: db.debts,
  reimbursement: db.reimbursements,
};
