import { describe, expect, it } from 'vitest';
import { accountBalance, computeNetWorth, isLiability } from '../src/utils/balance';
import type { AccountRow, TransactionRow } from '../src/types';

function tx(partial: Partial<TransactionRow>): TransactionRow {
  return {
    id: partial.id ?? 'x', ledger_id: 'l1', user_id: 'u1', type: 'expense', amount: '10',
    currency: 'CNY', amount_base: '10', account_id: 'a1', happened_at: 1000,
    is_refunded: false, exclude_from_budget: false, attachment_count: 0, source: 'manual',
    client_version: 1, is_deleted: false, created_at: 1, updated_at: 1, ...partial,
  } as TransactionRow;
}

describe('账户余额推导', () => {
  it('收入加、支出减、软删除忽略', () => {
    const txs = [
      tx({ id: '1', type: 'income', amount: '100', amount_base: '100' }),
      tx({ id: '2', type: 'expense', amount: '26.5', amount_base: '26.5' }),
      tx({ id: '3', type: 'expense', is_deleted: true }),
    ];
    expect(accountBalance('50', 'a1', txs)).toBe('123.5');
  });

  it('转账双边生效:转出方减、转入方加', () => {
    const t = tx({ id: 't', type: 'transfer', amount: '500', amount_base: '500', account_id: 'cash', to_account_id: 'bank' });
    expect(accountBalance('1000', 'cash', [t])).toBe('500');
    expect(accountBalance('0', 'bank', [t])).toBe('500');
  });

  it('净值 = 资产 − 负债,归档与不计入净值的账户不进汇总', () => {
    const acc = (id: string, type: AccountRow['type'], extra: Partial<AccountRow> = {}): AccountRow =>
      ({ id, ledger_id: 'l1', name: id, type, initial_balance: '0', initial_date: 1, currency: 'CNY', include_in_net: true, is_archived: false, sort: 0, client_version: 1, is_deleted: false, created_at: 1, updated_at: 1, ...extra }) as AccountRow;
    const accounts = [
      acc('cash', 'cash'),                       // 收 100 → 资产 100
      acc('credit', 'credit_card'),              // 支 40 → 负债 -40? 负债账户余额为负表示欠款
      acc('old', 'debit_card', { is_archived: true }), // 归档不进汇总
    ];
    const txs = [
      tx({ id: '1', type: 'income', account_id: 'cash', amount: '100', amount_base: '100' }),
      tx({ id: '2', type: 'expense', account_id: 'credit', amount: '40', amount_base: '40' }),
    ];
    const summary = computeNetWorth(accounts, txs);
    expect(summary.balances.get('cash')).toBe('100');
    expect(summary.balances.get('credit')).toBe('-40');
    expect(summary.assets).toBe('100');
    expect(summary.liabilities).toBe('40'); // 负债取正值口径
    expect(summary.net).toBe('60'); // 100 − 40
  });

  it('信用卡与应付是负债类型', () => {
    expect(isLiability('credit_card')).toBe(true);
    expect(isLiability('payable')).toBe(true);
    expect(isLiability('cash')).toBe(false);
  });
});
