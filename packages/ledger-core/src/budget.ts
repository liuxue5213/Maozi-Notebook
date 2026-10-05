import {
  addAmount, carryover, computeBudgetProgress,
  type BudgetItemRow, type BudgetProgress, type BudgetRow, type CategoryRow, type TransactionRow,
} from '@ledgerone/domain';

/**
 * 预算模型的输入:全部为已取好的数组,由调用方(Web 的 Dexie / App 的 SQLite)按各自方式查得。
 * 本包不含任何 IO,保证两端口径一致且可在 Node 环境单测。
 */
export interface BudgetModelInput {
  /** 未过滤的预算表数据;内部按 ledger_id / period_type / 软删过滤 */
  budgets: BudgetRow[];
  budgetItems: BudgetItemRow[];
  transactions: TransactionRow[];
  categories: CategoryRow[];
  ledgerId: string;
  /** 本期区间 [periodStart, periodEnd) */
  periodStart: number;
  periodEnd: number;
  /** 上一期起点(用于结转);无上月预算时传 null 即可跳过结转 */
  prevPeriodStart: number | null;
}

export interface BudgetModel {
  budget: BudgetRow | undefined;
  items: BudgetItemRow[];
  /** 结转额:开启结转且上月有预算时,总/分类各自动结转正剩余 */
  carryTotal: string;
  carryByCat: Map<string, string>;
  progress: BudgetProgress | null;
  /** 叠加结转后的「实际可用」视图 */
  adjusted: BudgetProgress | null;
}

/**
 * 构建预算执行模型(M04-F01/F02/F04 编排逻辑)。
 *
 * 原实现位于 `apps/web/src/budget.tsx` 的 `loadBudgetModel`,与 Dexie 查询耦合导致 App 端无法复用。
 * 此处下沉为纯函数:取数由两端各自完成,编排口径只有这一份。
 *
 * 语义(与迁移前严格一致,避免行为漂移):
 * - 预算取当前账本下 `period_type === 'monthly'` 且未软删、`period_start` 最大的一条;
 * - 结转仅在 `budget.rollover` 为真且存在上月预算(`period_start === prevPeriodStart`)时计算;
 * - 结转为正才结转,超支不倒扣(由 domain 的 `carryover` 保证);
 * - `adjusted` 为「总额 + 结转」「分类额度 + 分类结转」后重新计算的进度视图。
 */
export function buildBudgetModel(input: BudgetModelInput): BudgetModel {
  const { budgets, budgetItems, transactions, categories, ledgerId, periodStart, periodEnd, prevPeriodStart } = input;

  // 同月双行 tie-break(预算恢复 bug ③):双端离线各自建账本月预算会产生两条同月记录,
  // 仅按 period_start 排序时并列顺序取决于输入数组序(两端不同 → 各选各的,表现为「改了又被恢复」)。
  // 规则:period_start 降序 → created_at 降序 → id 降序,两端确定性选中同一条。
  const all = budgets
    .filter((b) => !b.is_deleted && b.ledger_id === ledgerId && b.period_type === 'monthly')
    .sort((a, b) =>
      (b.period_start - a.period_start)
      || ((b.created_at ?? 0) - (a.created_at ?? 0))
      || (String(b.id).localeCompare(String(a.id))));
  const budget = all[0];

  const catMap = new Map<string, CategoryRow>(categories.map((c) => [c.id, c]));

  // ---- 上月预算与执行 → 结转(M04-F02) ----
  const prev = prevPeriodStart == null ? undefined : all.find((b) => b.period_start === prevPeriodStart);
  const prevUsed =
    budget?.rollover && prev && prevPeriodStart != null
      ? (computeBudgetProgress(prev, [], transactions, catMap, prevPeriodStart, periodStart)?.used ?? '0')
      : null;
  const carryTotal =
    budget?.rollover && prev && prevUsed != null ? carryover(prev.total_amount, prevUsed) : '0';

  const carryByCat = new Map<string, string>();
  if (budget?.rollover && prev && prevPeriodStart != null) {
    const prevItems = budgetItems.filter((i) => !i.is_deleted && i.budget_id === prev.id);
    const prevProg = computeBudgetProgress(prev, prevItems, transactions, catMap, prevPeriodStart, periodStart);
    for (const it of prevProg?.items ?? []) {
      const base = prevItems.find((x) => x.category_id === it.categoryId);
      if (base) carryByCat.set(it.categoryId, carryover(base.amount, it.used));
    }
  }

  // ---- 本期执行 ----
  const items = budget ? budgetItems.filter((i) => !i.is_deleted && i.budget_id === budget.id) : [];
  const progress = computeBudgetProgress(budget ?? null, items, transactions, catMap, periodStart, periodEnd);

  const adjustedBudget: Pick<BudgetRow, 'total_amount'> | null = budget
    ? { total_amount: carryTotal === '0' ? budget.total_amount : addAmount(budget.total_amount, carryTotal) }
    : null;
  const adjustedItems: BudgetItemRow[] = items.map((it) => {
    const c = carryByCat.get(it.category_id);
    return c && c !== '0' ? { ...it, amount: addAmount(it.amount, c) } : it;
  });
  const adjusted = computeBudgetProgress(adjustedBudget, adjustedItems, transactions, catMap, periodStart, periodEnd);

  return { budget, items, carryTotal, carryByCat, progress, adjusted };
}
