import { subAmount } from './money';

export interface BudgetForecast {
  /** 已过天数(含今天) */
  elapsedDays: number;
  totalDays: number;
  /** 按当前消费速度线性外推的月末支出 */
  predictedSpend: string;
  /** 月末超支风险:predicted > budget */
  overRisk: boolean;
  /** 剩余每天可花额度(预算为 0 时为 0) */
  dailyAvailable: string;
}

/**
 * 预算预测(M04-F05):依据本月已消费速度预测月末超支风险,给出「日均可用额度」。
 * @param budget 总预算(可含结转)
 * @param used 本期已用
 * @param now 当前时刻
 * @param monthStart 本月 1 日 00:00(本地时区,由调用方给出)
 */
export function forecastBudget(budget: string, used: string, now: Date, monthStart: number): BudgetForecast {
  const totalDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const elapsedMs = Math.max(0, now.getTime() - monthStart);
  const elapsedDays = Math.min(totalDays, Math.max(1, Math.ceil(elapsedMs / 86_400_000)));
  const remainingDays = Math.max(1, totalDays - elapsedDays + 1);
  const perDay = elapsedDays > 0 ? Number(used) / elapsedDays : 0;
  const predicted = perDay * totalDays;
  const remainingBudget = Math.max(0, Number(subAmount(budget, used)));
  return {
    elapsedDays,
    totalDays,
    predictedSpend: predicted.toFixed(2),
    overRisk: predicted > Number(budget) && Number(budget) > 0,
    dailyAvailable: (remainingBudget / remainingDays).toFixed(2),
  };
}

/* ============ 历史参照的月底预测(参照历史开销数据 + 当月已花) ============ */

export interface HistoryMonth {
  year: number;
  month: number;
  /** 当月每日支出(下标 0 = 1 号),完整月 */
  daily: number[];
}

export interface MonthEndForecast {
  /** 参与预测的历史月份数(0 = 无历史,退化为纯节奏外推) */
  sampleMonths: number;
  elapsedDays: number;
  totalDays: number;
  /** 历史完整月均 */
  historyAvg: number | null;
  /** 历史各月「截至同一天」的平均支出 */
  samePeriodAvg: number | null;
  /** 路线 A:按本月节奏线性外推 */
  paceEnd: number;
  /** 路线 B:本月已花 + (历史月均 − 历史同期已花) */
  historyEnd: number | null;
  /** 综合预测:两路均衡(本月无花销时取历史月均) */
  predicted: number;
  /** 预测相对历史月均的百分比(正=将高于月均) */
  vsAvgPct: number | null;
}

/**
 * 月底支出预测:参照历史开销数据 + 当月已开销。
 * - 路线 A(节奏):本月已花 / 已过天数 × 当月总天数;
 * - 路线 B(历史同期):本月已花 + max(0, 历史月均 − 历史同期已花均值);
 * - 综合 = 两路平均;当月尚未花钱时直接取历史月均;无历史时退化为路线 A。
 */
export function forecastMonthEnd(
  history: HistoryMonth[],
  currentUsed: number,
  now: Date,
  monthStart: number,
): MonthEndForecast {
  void monthStart;
  const totalDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const elapsedDays = Math.min(totalDays, Math.max(1, now.getDate()));
  const paceEnd = currentUsed > 0 ? (currentUsed / elapsedDays) * totalDays : 0;

  // 全月零记录的月份(如开始记账之前)不参与平均,避免拉低历史月均
  const usable = history.filter((h) => h.daily.length > 0 && h.daily.some((d) => d > 0));
  if (!usable.length) {
    return {
      sampleMonths: 0, elapsedDays, totalDays,
      historyAvg: null, samePeriodAvg: null,
      paceEnd, historyEnd: null,
      predicted: Math.round(paceEnd), vsAvgPct: null,
    };
  }

  const totals = usable.map((h) => h.daily.reduce((a, b) => a + b, 0));
  const historyAvg = totals.reduce((a, b) => a + b, 0) / usable.length;
  const samePeriodAvg =
    usable.map((h) => h.daily.slice(0, elapsedDays).reduce((a, b) => a + b, 0)).reduce((a, b) => a + b, 0) /
    usable.length;

  const remaining = Math.max(0, historyAvg - samePeriodAvg);
  const historyEnd = currentUsed + remaining;
  const predicted = currentUsed === 0 ? Math.round(historyAvg) : Math.round((paceEnd + historyEnd) / 2);
  const vsAvgPct = historyAvg > 0 ? Math.round((predicted / historyAvg - 1) * 100) : null;

  return {
    sampleMonths: usable.length, elapsedDays, totalDays,
    historyAvg, samePeriodAvg,
    paceEnd, historyEnd, predicted, vsAvgPct,
  };
}
