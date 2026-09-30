import type { Table } from 'dexie';
import type { CategoryRow, TransactionRow } from '@ledgerone/domain';

/** 明细列表单页显示上限(P0-3:数据量大时截断展示但筛选/计数不截断,并给出显式提示) */
export const TX_DISPLAY_CAP = 500;

export interface TxFilterInput {
  keyword: string;
  min: string;
  max: string;
  categoryId: string;
  accountId: string;
  from: string;
  to: string;
}

export interface TxWindowResult {
  /** 命中筛选的全部行(倒序)中,取前 TX_DISPLAY_CAP 条用于渲染 */
  rows: TransactionRow[];
  /** 命中筛选的总数(全量统计,不受显示上限影响) */
  matchedTotal: number;
  /** 未删除流水总数(不含任何筛选) */
  totalActive: number;
  truncated: boolean;
}

/**
 * 明细窗口加载(P0-3 修复,Review 实证缺陷):
 * 修复前 `orderBy('happened_at').reverse().limit(300)` **先截断再筛选** —— 数据量 >300 后
 * 老流水永久不可见、关键词搜不到却无任何提示。现改为:
 * 1) 日期筛选下推到 happened_at 索引(`where.between`),无日期时全表倒序扫描;
 * 2) 其余条件(关键词/金额/分类/账户)在**全量**行上过滤 —— 命中数与匹配结果不再因上限失真;
 * 3) 仅渲染层截断前 TX_DISPLAY_CAP 条,并以 truncated 提示「已显示 N/共 M,请缩小范围」。
 */
export async function loadTxWindow(
  table: Table<TransactionRow, string>,
  filter: TxFilterInput,
  catMap: Map<string, CategoryRow>,
  cap = TX_DISPLAY_CAP,
  /** 账本作用域(P1-4):多账本下明细只看当前账本;缺省不过滤(兼容) */
  ledgerId?: string,
): Promise<TxWindowResult> {
  const fromTs = filter.from ? new Date(`${filter.from}T00:00:00`).getTime() : null;
  const toTs = filter.to ? new Date(`${filter.to}T00:00:00`).getTime() + 86_400_000 : null;
  const kw = filter.keyword.trim();

  let matched: TransactionRow[] = [];
  let totalActive = 0;
  // 日期范围命中索引;其余条件内存过滤(与既有 applyFilter 语义一致)
  const scan =
    fromTs !== null || toTs !== null
      ? table.where('happened_at').between(fromTs ?? -Infinity, toTs ?? Infinity, true, false).reverse()
      : table.orderBy('happened_at').reverse();
  await scan.each((r) => {
    if (r.is_deleted) return;
    if (ledgerId && r.ledger_id !== ledgerId) return; // 账本作用域(P1-4):跨账本数据不串入
    totalActive++;
    if (kw) {
      const cat = r.category_id ? catMap.get(r.category_id)?.name ?? '' : '';
      if (!`${r.note ?? ''} ${cat}`.includes(kw)) return;
    }
    const amt = Number(r.amount);
    if (filter.min !== '' && amt < Number(filter.min)) return;
    if (filter.max !== '' && amt > Number(filter.max)) return;
    if (filter.categoryId) {
      const c = r.category_id ? catMap.get(r.category_id) : undefined;
      if (!c || (c.id !== filter.categoryId && c.parent_id !== filter.categoryId)) return;
    }
    if (filter.accountId && r.account_id !== filter.accountId && r.to_account_id !== filter.accountId) return;
    if (fromTs !== null && r.happened_at < fromTs) return;
    if (toTs !== null && r.happened_at >= toTs) return;
    matched.push(r);
  });

  return {
    rows: matched.slice(0, cap),
    matchedTotal: matched.length,
    totalActive,
    truncated: matched.length > cap,
  };
}
