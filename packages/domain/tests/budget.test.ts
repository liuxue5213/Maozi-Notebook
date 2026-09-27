import { describe, expect, it } from 'vitest';
import { budgetLevel, computeBudgetProgress, sumExpense } from '../src/utils/budget';
import type { BudgetItemRow, CategoryRow, TransactionRow } from '../src/types';

function tx(partial: Partial<TransactionRow>): TransactionRow {
  return {
    id: partial.id ?? 'x', ledger_id: 'l1', user_id: 'u1', type: 'expense', amount: '10',
    currency: 'CNY', amount_base: '10', account_id: 'a1', happened_at: 5_000,
    is_refunded: false, exclude_from_budget: false, attachment_count: 0, source: 'manual',
    client_version: 1, is_deleted: false, created_at: 1, updated_at: 1, ...partial,
  } as TransactionRow;
}

const catMap = new Map<string, Pick<CategoryRow, 'id' | 'parent_id'>>([
  ['dining', { id: 'dining', parent_id: null }],
  ['lunch', { id: 'lunch', parent_id: 'dining' }],
]);

const T0 = 0;
const T1 = 10_000;

describe('预算进度(M04-F01/F04)', () => {
  it('无预算返回 null', () => {
    expect(computeBudgetProgress(null, [], [], catMap, T0, T1)).toBeNull();
  });

  it('支出合计排除:软删除 / 转账 / 不计入预算 / 周期外 / 收入', () => {
    const txs = [
      tx({ amount: '100', amount_base: '100' }),
      tx({ id: 'del', amount: '100', amount_base: '100', is_deleted: true }),
      tx({ id: 'tr', type: 'transfer', amount: '100', amount_base: '100' }),
      tx({ id: 'ex', amount: '100', amount_base: '100', exclude_from_budget: true }),
      tx({ id: 'out', amount: '100', amount_base: '100', happened_at: 20_000 }),
      tx({ id: 'inc', type: 'income', amount: '100', amount_base: '100' }),
    ];
    expect(sumExpense(txs, T0, T1)).toBe('100');
  });

  it('二级分类支出归集到一级分类条目', () => {
    const budget = { total_amount: '1000' };
    const items: BudgetItemRow[] = [{ id: 'i1', budget_id: 'b', category_id: 'dining', amount: '300', client_version: 1, is_deleted: false, created_at: 1, updated_at: 1 }];
    const txs = [tx({ amount: '25', amount_base: '25', category_id: 'lunch' })];
    const p = computeBudgetProgress(budget, items, txs, catMap, T0, T1)!;
    expect(p.used).toBe('25');
    expect(p.pct).toBe(2.5);
    expect(p.level).toBe('ok');
    expect(p.items[0].used).toBe('25');
    expect(p.items[0].pct).toBe(8.3);
  });

  it('预警级别:80% 橙、100% 红', () => {
    expect(budgetLevel(79.9)).toBe('ok');
    expect(budgetLevel(80)).toBe('warn');
    expect(budgetLevel(99.9)).toBe('warn');
    expect(budgetLevel(100)).toBe('over');
    const mk = (total: string, spent: string) =>
      computeBudgetProgress({ total_amount: total }, [], [tx({ amount: spent, amount_base: spent })], catMap, T0, T1)!.level;
    expect(mk('1000', '850')).toBe('warn');
    expect(mk('1000', '1000')).toBe('over');
    expect(mk('1000', '1050')).toBe('over');
  });

  it('剩余 = 总额 − 已用(可为负)', () => {
    const p = computeBudgetProgress({ total_amount: '100' }, [], [tx({ amount: '120', amount_base: '120' })], catMap, T0, T1)!;
    expect(p.remaining).toBe('-20');
  });
});
