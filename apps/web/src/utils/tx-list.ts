import type { Table } from 'dexie';
import type { CategoryRow, TransactionRow } from '@ledgerone/domain';

/** 明细分页(P0-4,第 28 轮):每批加载条数;UI「加载更多」按批递增 */
export const TX_PAGE_SIZE = 50;

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
  /** 命中筛选的全部行(倒序)中,取前 limit 条用于渲染 */
  rows: TransactionRow[];
  /** 命中筛选的总数(全量统计,不受 limit 影响) */
  matchedTotal: number;
  /** 当前账本(或扫描范围)内未删除总数 */
  totalActive: number;
  /** 命中数超过 limit:还有更多可加载 */
  hasMore: boolean;
}

/**
 * 明细窗口加载(P0-3/P0-4,第 22/28 轮):
 * - **双下推**:账本 + 日期走 `[ledger_id+happened_at]` 复合索引(v3),无日期时走 `ledger_id`
 *   单列索引 —— 修复前无日期时全表倒序扫描且 ledger_id 在 JS 里过滤;
 * - **全量过滤**:关键词/金额/分类/账户条件在账本全量行上过滤,命中数不失真(修复 limit(300) 假象);
 * - **增量加载**:limit 由 UI「加载更多」递增(每批 TX_PAGE_SIZE),rows 返回前 limit 条,
 *   hasMore 提示还有更多 —— 语义与 Review 建议的「分页 50 + 已加载 N/总数」一致。
 */
export async function loadTxWindow(
  table: Table<TransactionRow, string>,
  filter: TxFilterInput,
  catMap: Map<string, CategoryRow>,
  ledgerId: string,
  limit = TX_PAGE_SIZE,
): Promise<TxWindowResult> {
  const fromTs = filter.from ? new Date(`${filter.from}T00:00:00`).getTime() : null;
  const toTs = filter.to ? new Date(`${filter.to}T00:00:00`).getTime() + 86_400_000 : null;
  const kw = filter.keyword.trim();

  let matched: TransactionRow[] = [];
  let totalActive = 0;
  // 双下推:账本必选;日期范围用复合索引边界(下界含、上界不含,与 applyFilter 语义一致)
  const scan =
    fromTs !== null || toTs !== null
      ? table
          .where('[ledger_id+happened_at]')
          .between([ledgerId, fromTs ?? -Infinity], [ledgerId, toTs ?? Infinity], true, false)
          .reverse()
      : table.where('ledger_id').equals(ledgerId).reverse();
  await scan.each((r) => {
    if (r.is_deleted) return;
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
    matched.push(r);
  });

  return {
    rows: matched.slice(0, limit),
    matchedTotal: matched.length,
    totalActive,
    hasMore: matched.length > limit,
  };
}
