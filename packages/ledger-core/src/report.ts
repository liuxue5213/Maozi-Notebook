import { addAmount, forecastMonthEnd, type CategoryRow, type TransactionRow } from '@ledgerone/domain';

/**
 * 报表编排(P1-1 垂直切片,第 30 轮):总览聚合/分类占比/趋势分桶/月底预测,
 * 端无关 —— Web 取数后调用,App 直接复用同一份口径(Review A1:A2 方向)。
 */

export type PeriodKind = 'day' | 'week' | 'month' | 'year';
const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfDay(d: Date): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/** 本地时区周期区间 [start, end);周起始日为周一(M14-F03 默认) */
export function periodRange(kind: PeriodKind, now: Date = new Date()): { start: number; end: number } {
  const start = new Date(startOfDay(now));
  switch (kind) {
    case 'day':
      return { start: start.getTime(), end: start.getTime() + DAY_MS };
    case 'week': {
      const offset = (start.getDay() + 6) % 7; // 周一=0
      const s = start.getTime() - offset * DAY_MS;
      return { start: s, end: s + 7 * DAY_MS };
    }
    case 'month': {
      start.setDate(1);
      const end = new Date(start);
      end.setMonth(end.getMonth() + 1);
      return { start: start.getTime(), end: end.getTime() };
    }
    case 'year': {
      start.setMonth(0, 1);
      const end = new Date(start);
      end.setFullYear(end.getFullYear() + 1);
      return { start: start.getTime(), end: end.getTime() };
    }
  }
}

export interface TrendBucket {
  label: string;
  start: number;
  end: number;
}

/** 迷你趋势分桶(M06-F01):日→近7天,周→本周7天,月→当月每日,年→12个月 */
export function trendBuckets(kind: PeriodKind, now: Date = new Date()): TrendBucket[] {
  switch (kind) {
    case 'day':
    case 'week': {
      const weekStart = periodRange('week', now).start;
      return Array.from({ length: 7 }, (_, i) => {
        const st = weekStart + i * DAY_MS;
        return { label: `周${'日一二三四五六'[new Date(st).getDay()]}`, start: st, end: st + DAY_MS };
      });
    }
    case 'month': {
      const { start, end } = periodRange('month', now);
      const days = Math.round((end - start) / DAY_MS);
      return Array.from({ length: days }, (_, i) => {
        const st = start + i * DAY_MS;
        return { label: String(new Date(st).getDate()), start: st, end: st + DAY_MS };
      });
    }
    case 'year': {
      const y = now.getFullYear();
      return Array.from({ length: 12 }, (_, i) => {
        const st = new Date(y, i, 1).getTime();
        return { label: `${i + 1}月`, start: st, end: new Date(y, i + 1, 1).getTime() };
      });
    }
  }
}

export interface CatAgg {
  amount: string;
  count: number;
}

export interface ReportModel {
  /** 周期内收入/支出合计(amount_base 口径) */
  income: string;
  expense: string;
  /** 一级分类聚合(kind 过滤后)与全部分类聚合(下钻用) */
  byTop: Map<string, CatAgg>;
  byCat: Map<string, CatAgg>;
  /** 支出趋势分桶(已聚合金额) */
  buckets: Array<TrendBucket & { amount: string; isCurrent: boolean }>;
  /** 命中周期的行(下钻流水明细用) */
  rows: TransactionRow[];
  /** 当月已花(预测基线)与月底预测 */
  monthUsed: string;
  forecast: ReturnType<typeof forecastMonthEnd>;
  /** 分类映射(下钻渲染图标/名称) */
  catMap: Map<string, CategoryRow>;
}

export interface ReportModelInput {
  /** 已按账本作用域 + 周期区间过滤的行(端侧取数,core 不感知 Dexie/SQLite) */
  rows: TransactionRow[];
  /** 当前账本近 3 个完整月及本月的支出(月底预测与当月已花基线) */
  allExpenses: TransactionRow[];
  cats: CategoryRow[];
  kind: 'expense' | 'income';
  period: PeriodKind;
  now: number;
}

/** 报表聚合编排:总览/占比/趋势/预测单一口径(Web 与 App 共用) */
export function buildReportModel(input: ReportModelInput): ReportModel {
  const { rows, allExpenses, cats, kind, period, now } = input;
  const catMap = new Map(cats.map((c) => [c.id, c]));
  let income = '0';
  let expense = '0';
  const byTop = new Map<string, CatAgg>();
  const byCat = new Map<string, CatAgg>();
  for (const r of rows) {
    // 软删/转账守卫(原 web 查询层过滤,下沉后内聚到 core —— 端侧漏过滤也不会串统计)
    if (r.is_deleted || r.type === 'transfer') continue;
    if (r.type === 'income') income = addAmount(income, r.amount_base);
    else expense = addAmount(expense, r.amount_base);
    if (r.type !== kind || !r.category_id) continue;
    const cat = catMap.get(r.category_id);
    if (!cat) continue;
    const topId = cat.parent_id ?? cat.id;
    const t = byTop.get(topId) ?? { amount: '0', count: 0 };
    byTop.set(topId, { amount: addAmount(t.amount, r.amount_base), count: t.count + 1 });
    const c = byCat.get(cat.id) ?? { amount: '0', count: 0 };
    byCat.set(cat.id, { amount: addAmount(c.amount, r.amount_base), count: c.count + 1 });
  }
  const buckets = trendBuckets(period, new Date(now)).map((b) => ({
    ...b,
    amount: rows
      .filter((r) => r.type === 'expense' && r.happened_at >= b.start && r.happened_at < b.end)
      .reduce((acc, r) => addAmount(acc, r.amount_base), '0'),
    isCurrent: now >= b.start && now < b.end,
  }));
  // 月底预测:近 3 个完整月历史 + 当月已花(forecastMonthEnd)
  const { start: curStart } = periodRange('month', new Date(now));
  const monthUsed = allExpenses
    .filter((r) => r.happened_at >= curStart)
    .reduce((acc, r) => addAmount(acc, r.amount_base), '0');
  const nowD = new Date(now);
  const history = [];
  for (let i = 1; i <= 3; i++) {
    const ms = new Date(nowD.getFullYear(), nowD.getMonth() - i, 1);
    const me = new Date(nowD.getFullYear(), nowD.getMonth() - i + 1, 1);
    const days = new Date(ms.getFullYear(), ms.getMonth() + 1, 0).getDate();
    const daily: number[] = new Array(days).fill(0);
    for (const r of allExpenses) {
      if (r.happened_at >= ms.getTime() && r.happened_at < me.getTime()) {
        daily[new Date(r.happened_at).getDate() - 1] += Number(r.amount_base);
      }
    }
    history.push({ year: ms.getFullYear(), month: ms.getMonth() + 1, daily });
  }
  const forecast = forecastMonthEnd(history, Number(monthUsed), nowD, curStart);
  return { income, expense, byTop, byCat, buckets, rows, monthUsed, forecast, catMap };
}

export type { CategoryRow };
