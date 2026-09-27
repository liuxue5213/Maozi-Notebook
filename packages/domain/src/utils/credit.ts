/** 信用卡账单周期(M02-F05):按账单日切周期、距还款日天数 */

const DAY_MS = 86_400_000;

function atDay(year: number, month: number, day: number): number {
  // 账单日/还款日可能超过当月天数(如 31 日在 2 月),取当月最后一天兜底
  const last = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, last)).getTime();
}

/**
 * 当前账单周期 [start, end):start = 最近一次账单日 00:00,end = 下一个账单日 00:00。
 * 例:账单日 10、今天 9/26 → 周期为 9/10 ~ 10/10,本期消费汇总取 [start, now)。
 */
export function billingCycleRange(billDay: number, now: Date = new Date()): { start: number; end: number } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const todayStart = new Date(y, m, now.getDate()).getTime();
  const thisBill = atDay(y, m, billDay);
  if (todayStart >= thisBill) {
    return { start: thisBill, end: atDay(y, m + 1, billDay) };
  }
  return { start: atDay(y, m - 1, billDay), end: thisBill };
}

/** 距还款日天数:还款日为账单日后的下一个 dueDay(常见 20~50 天宽限);今天即还款日返回 0,已过返回 -1 表示逾期方向由调用方展示 */
export function daysUntilDue(dueDay: number, now: Date = new Date()): number {
  const y = now.getFullYear();
  const m = now.getMonth();
  const todayStart = new Date(y, m, now.getDate()).getTime();
  const thisDue = atDay(y, m, dueDay);
  if (todayStart <= thisDue) return Math.round((thisDue - todayStart) / DAY_MS);
  return Math.round((atDay(y, m + 1, dueDay) - todayStart) / DAY_MS);
}
