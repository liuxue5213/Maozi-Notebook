import type { RecurringFrequency } from '../enums';

const DAY_MS = 86_400_000;

/**
 * 周期记账下一次执行时间(M01-F06):日/周/月/季/年。
 * 月/季/年按日历月推进,日超过当月天数取月末兜底;周按 7 天推进。
 */
export function nextOccurrence(frequency: RecurringFrequency, interval: number, fromTs: number): number {
  const n = Math.max(1, interval);
  const d = new Date(fromTs);
  switch (frequency) {
    case 'daily':
      return fromTs + n * DAY_MS;
    case 'weekly':
      return fromTs + n * 7 * DAY_MS;
    case 'monthly':
    case 'quarterly':
    case 'yearly': {
      const step = frequency === 'monthly' ? n : frequency === 'quarterly' ? n * 3 : n * 12;
      const target = new Date(d.getFullYear(), d.getMonth() + step, 1);
      const dayOfMonth = d.getDate();
      const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      target.setDate(Math.min(dayOfMonth, lastDay));
      // 保留原时间部分
      target.setHours(d.getHours(), d.getMinutes(), d.getSeconds(), 0);
      return target.getTime();
    }
  }
}

export interface DueRule {
  next_run_at: number;
  paused: boolean;
}

/** 到期判定:未暂停且 next_run_at ≤ now */
export function isDue(rule: DueRule, now: number): boolean {
  return !rule.paused && rule.next_run_at <= now;
}
