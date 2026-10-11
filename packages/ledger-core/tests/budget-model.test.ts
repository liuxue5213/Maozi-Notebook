import { describe, expect, it } from 'vitest';
import { buildBudgetModel } from '../src/budget';
import type { BudgetItemRow, BudgetRow, CategoryRow, TransactionRow } from '@ledgerone/domain';

const L = 'ledger-1';
const PREV_START = 1_700_000_000_000;
const START = 1_800_000_000_000;
const END = 1_900_000_000_000;
const IN_PERIOD = 1_850_000_000_000;
const IN_PREV = 1_750_000_000_000;

const now = 1_800_000_000_000;

function budget(p: Partial<BudgetRow> & { id: string; period_start: number }): BudgetRow {
  return {
    ledger_id: L,
    period_type: 'monthly',
    total_amount: '3000',
    currency: 'CNY',
    rollover: false,
    client_version: 1,
    is_deleted: false,
    created_at: now,
    updated_at: now,
    ...p,
  };
}

function item(p: Partial<BudgetItemRow> & { id: string; budget_id: string; category_id: string }): BudgetItemRow {
  return {
    amount: '500',
    client_version: 1,
    is_deleted: false,
    created_at: now,
    updated_at: now,
    ...p,
  };
}

function tx(p: Partial<TransactionRow> & { id: string; amount: string }): TransactionRow {
  return {
    ledger_id: L,
    user_id: 'u1',
    type: 'expense',
    currency: 'CNY',
    amount_base: p.amount,
    account_id: 'acc-1',
    happened_at: IN_PERIOD,
    is_refunded: false,
    exclude_from_budget: false,
    attachment_count: 0,
    source: 'manual',
    client_version: 1,
    is_deleted: false,
    created_at: now,
    updated_at: now,
    ...p,
  };
}

function cat(p: Partial<CategoryRow> & { id: string }): CategoryRow {
  return {
    ledger_id: L,
    parent_id: null,
    name: p.id,
    kind: 'expense',
    icon: '📦',
    sort: 0,
    is_hidden: false,
    is_preset: true,
    client_version: 1,
    is_deleted: false,
    created_at: now,
    updated_at: now,
    ...p,
  };
}

const baseInput = {
  budgets: [] as BudgetRow[],
  budgetItems: [] as BudgetItemRow[],
  transactions: [] as TransactionRow[],
  categories: [] as CategoryRow[],
  ledgerId: L,
  periodStart: START,
  periodEnd: END,
  prevPeriodStart: PREV_START as number | null,
};

describe('buildBudgetModel(端无关预算编排)', () => {
  it('无预算时返回空模型,不抛错', () => {
    const m = buildBudgetModel({ ...baseInput, transactions: [tx({ id: 't1', amount: '100' })] });
    expect(m.budget).toBeUndefined();
    expect(m.items).toEqual([]);
    expect(m.progress).toBeNull();
    expect(m.adjusted).toBeNull();
    expect(m.carryTotal).toBe('0');
  });

  it('基础进度:总预算 3000 / 支出 4430 → 147.7% 超支(README 实测口径)', () => {
    const m = buildBudgetModel({
      ...baseInput,
      budgets: [budget({ id: 'b1', period_start: START, total_amount: '3000' })],
      transactions: [tx({ id: 't1', amount: '4430' })],
    });
    expect(m.progress?.used).toBe('4430');
    expect(m.progress?.total).toBe('3000');
    expect(m.progress?.pct).toBe(147.7);
    expect(m.progress?.level).toBe('over');
    expect(m.progress?.remaining).toBe('-1430');
  });

  it('结转上月剩余:上月 6000 / 支出 5993.29 → 结转 6.71,可用额度叠加', () => {
    const m = buildBudgetModel({
      ...baseInput,
      budgets: [
        budget({ id: 'b-prev', period_start: PREV_START, total_amount: '6000' }),
        budget({ id: 'b-cur', period_start: START, total_amount: '3000', rollover: true }),
      ],
      transactions: [tx({ id: 't-prev', amount: '5993.29', happened_at: IN_PREV })],
    });
    expect(m.budget?.id).toBe('b-cur');
    expect(m.carryTotal).toBe('6.71');
    // 结转后「实际可用」视图:3000 + 6.71
    expect(m.adjusted?.total).toBe('3006.71');
    expect(m.progress?.total).toBe('3000');
  });

  it('未开启结转(rollover=false):结转恒为 0,可用额度等于原额度', () => {
    const m = buildBudgetModel({
      ...baseInput,
      budgets: [
        budget({ id: 'b-prev', period_start: PREV_START, total_amount: '6000' }),
        budget({ id: 'b-cur', period_start: START, total_amount: '3000', rollover: false }),
      ],
      transactions: [tx({ id: 't-prev', amount: '5993.29', happened_at: IN_PREV })],
    });
    expect(m.carryTotal).toBe('0');
    expect(m.adjusted?.total).toBe('3000');
  });

  it('上月超支不倒扣:结转为 0 而非负数', () => {
    const m = buildBudgetModel({
      ...baseInput,
      budgets: [
        budget({ id: 'b-prev', period_start: PREV_START, total_amount: '100' }),
        budget({ id: 'b-cur', period_start: START, total_amount: '3000', rollover: true }),
      ],
      transactions: [tx({ id: 't-prev', amount: '500', happened_at: IN_PREV })],
    });
    expect(m.carryTotal).toBe('0');
    expect(m.adjusted?.total).toBe('3000');
  });

  it('无上月预算(prevPeriodStart=null)时不结转', () => {
    const m = buildBudgetModel({
      ...baseInput,
      budgets: [budget({ id: 'b-cur', period_start: START, total_amount: '3000', rollover: true })],
      prevPeriodStart: null,
    });
    expect(m.carryTotal).toBe('0');
  });

  it('分类预算按一级口径归集:流水挂在二级分类时归到父分类', () => {
    const m = buildBudgetModel({
      ...baseInput,
      budgets: [budget({ id: 'b1', period_start: START, total_amount: '3000' })],
      budgetItems: [item({ id: 'i1', budget_id: 'b1', category_id: 'c-food', amount: '500' })],
      categories: [cat({ id: 'c-food' }), cat({ id: 'c-lunch', parent_id: 'c-food' })],
      transactions: [
        tx({ id: 't1', amount: '200', category_id: 'c-lunch' }),
        tx({ id: 't2', amount: '50', category_id: 'c-food' }),
      ],
    });
    expect(m.progress?.items).toHaveLength(1);
    expect(m.progress?.items[0].categoryId).toBe('c-food');
    expect(m.progress?.items[0].used).toBe('250');
    expect(m.progress?.items[0].pct).toBe(50);
    expect(m.progress?.items[0].level).toBe('ok');
  });

  it('软删 / 转账 / 不计预算 / 区间外 一律不计入', () => {
    const m = buildBudgetModel({
      ...baseInput,
      budgets: [budget({ id: 'b1', period_start: START, total_amount: '3000' })],
      transactions: [
        tx({ id: 't1', amount: '100' }), // 计入
        tx({ id: 't2', amount: '999', is_deleted: true }),
        tx({ id: 't3', amount: '999', type: 'transfer' }),
        tx({ id: 't4', amount: '999', exclude_from_budget: true }),
        tx({ id: 't5', amount: '999', type: 'income' }),
        tx({ id: 't6', amount: '999', happened_at: END + 1 }), // 区间外
        tx({ id: 't7', amount: '999', happened_at: START - 1 }), // 区间外
      ],
    });
    expect(m.progress?.used).toBe('100');
  });

  it('账本隔离:其他账本的预算与流水不参与', () => {
    const m = buildBudgetModel({
      ...baseInput,
      budgets: [budget({ id: 'b-other', period_start: START, ledger_id: 'ledger-2' })],
      transactions: [tx({ id: 't1', amount: '100' })],
    });
    expect(m.budget).toBeUndefined();
    expect(m.progress).toBeNull();
  });

  it('取 period_start 最大的一条月度预算(年度预算被过滤)', () => {
    const m = buildBudgetModel({
      ...baseInput,
      budgets: [
        budget({ id: 'b-old', period_start: PREV_START, total_amount: '1000' }),
        budget({ id: 'b-year', period_start: START, period_type: 'yearly', total_amount: '99999' }),
        budget({ id: 'b-new', period_start: START + 1, total_amount: '3000' }),
      ],
      transactions: [],
    });
    expect(m.budget?.id).toBe('b-new');
    expect(m.progress?.total).toBe('3000');
  });

  it('同月双行并列时 tie-break 确定性选择(created_at 新者胜,与输入数组顺序无关)', () => {
    const input = (order: BudgetRow[]) => buildBudgetModel({
      ...baseInput,
      budgets: order,
      transactions: [],
    });
    const older = budget({ id: 'b-a', period_start: START, total_amount: '2000', created_at: now });
    const newer = budget({ id: 'b-b', period_start: START, total_amount: '5000', created_at: now + 5_000 });
    // 两种输入顺序都必须选中同一条(created_at 较新的 b-b)
    expect(input([older, newer]).budget?.id).toBe('b-b');
    expect(input([newer, older]).budget?.id).toBe('b-b');
    // created_at 也并列时按 id 降序稳定裁决
    const twinA = budget({ id: 'a-twin', period_start: START, total_amount: '1', created_at: now });
    const twinB = budget({ id: 'b-twin', period_start: START, total_amount: '2', created_at: now });
    expect(input([twinA, twinB]).budget?.id).toBe('b-twin');
    expect(input([twinB, twinA]).budget?.id).toBe('b-twin');
  });

  it('N1 多周期:按 periodType 过滤选取,互不串扰', () => {
    const run = (periodType: 'weekly' | 'monthly' | 'quarterly' | 'yearly') => buildBudgetModel({
      ...baseInput,
      periodType,
      budgets: [
        budget({ id: 'b-week', period_type: 'weekly', period_start: START, total_amount: '100' }),
        budget({ id: 'b-month', period_type: 'monthly', period_start: START, total_amount: '200' }),
        budget({ id: 'b-quarter', period_type: 'quarterly', period_start: START, total_amount: '400' }),
        budget({ id: 'b-year', period_type: 'yearly', period_start: START, total_amount: '800' }),
      ],
      transactions: [],
    });
    expect(run('weekly').budget?.total_amount).toBe('100');
    expect(run('monthly').budget?.total_amount).toBe('200');
    expect(run('quarterly').budget?.total_amount).toBe('400');
    expect(run('yearly').budget?.total_amount).toBe('800');
  });

  it('N1 多周期:不传 periodType 默认 monthly(向后兼容既有调用)', () => {
    const m = buildBudgetModel({
      ...baseInput,
      budgets: [
        budget({ id: 'b-week', period_type: 'weekly', period_start: START, total_amount: '100' }),
        budget({ id: 'b-month', period_type: 'monthly', period_start: START, total_amount: '200' }),
      ],
      transactions: [],
    });
    expect(m.budget?.id).toBe('b-month');
  });
});
