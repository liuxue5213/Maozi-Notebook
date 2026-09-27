import { addAmount, subAmount } from './money';
import type { BudgetItemRow, BudgetRow, CategoryRow, TransactionRow } from '../types';

export type BudgetLevel = 'ok' | 'warn' | 'over';

/** 预警阈值(PRD M04-F04):80% 预警、100% 超支 */
export function budgetLevel(pct: number): BudgetLevel {
  return pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok';
}

/** 结转上月剩余(M04-F02):上月剩余为正才结转,超支不倒扣本月 */
export function carryover(amount: string, used: string): string {
  const rest = subAmount(amount, used);
  return Number(rest) > 0 ? rest : '0';
}

export interface BudgetItemProgress {
  categoryId: string;
  amount: string;
  used: string;
  pct: number;
  level: BudgetLevel;
}

export interface BudgetProgress {
  total: string;
  used: string;
  remaining: string;
  pct: number;
  level: BudgetLevel;
  items: BudgetItemProgress[];
}

/** 周期内支出合计:软删除、转账、排除项(不计入预算)一律不计(PRD M01-F02 exclude_from_budget) */
export function sumExpense(txs: TransactionRow[], periodStart: number, periodEnd: number, match?: (t: TransactionRow) => boolean): string {
  let sum = '0';
  for (const t of txs) {
    if (t.is_deleted || t.type !== 'expense' || t.exclude_from_budget) continue;
    if (t.happened_at < periodStart || t.happened_at >= periodEnd) continue;
    if (match && !match(t)) continue;
    sum = addAmount(sum, t.amount_base);
  }
  return sum;
}

/**
 * 预算执行进度(PRD M04-F01):总预算 + 分类预算条目的已用/剩余/百分比/预警级别。
 * 分类条目按「一级分类口径」归集:流水挂在二级分类时归到其父分类(catMap 提供层级)。
 */
export function computeBudgetProgress(
  budget: Pick<BudgetRow, 'total_amount'> | null,
  items: BudgetItemRow[],
  txs: TransactionRow[],
  catMap: Map<string, Pick<CategoryRow, 'id' | 'parent_id'>>,
  periodStart: number,
  periodEnd: number,
): BudgetProgress | null {
  if (!budget) return null;
  const used = sumExpense(txs, periodStart, periodEnd);
  const totalPct = Number(budget.total_amount) > 0 ? (Number(used) / Number(budget.total_amount)) * 100 : 0;
  const progress: BudgetProgress = {
    total: budget.total_amount,
    used,
    remaining: subAmount(budget.total_amount, used),
    pct: Math.round(totalPct * 10) / 10,
    level: budgetLevel(totalPct),
    items: [],
  };
  for (const it of items) {
    if (it.is_deleted) continue;
    const usedItem = sumExpense(txs, periodStart, periodEnd, (t) => {
      const c = t.category_id ? catMap.get(t.category_id) : undefined;
      const top = c ? (c.parent_id ?? c.id) : t.category_id;
      return top === it.category_id;
    });
    const pct = Number(it.amount) > 0 ? (Number(usedItem) / Number(it.amount)) * 100 : 0;
    progress.items.push({
      categoryId: it.category_id,
      amount: it.amount,
      used: usedItem,
      pct: Math.round(pct * 10) / 10,
      level: budgetLevel(pct),
    });
  }
  return progress;
}
