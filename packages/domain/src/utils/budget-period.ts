/**
 * 预算周期区间(N1 预算多周期):双端唯一口径。
 * weekly=周一始 / monthly=自然月 / quarterly=自然季 / yearly=自然年;
 * custom 为调用方自带区间的占位类型(不在此计算)。
 */
import type { BudgetPeriodType } from '../enums';

export interface BudgetPeriodRange {
  start: number;
  end: number;
  /** 上一周期起点(结转用;weekly/monthly/quarterly/yearly 均有) */
  prevStart: number;
}

const DAY_MS = 86_400_000;

function startOfDay(d: Date): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s;
}

export function budgetPeriodRange(periodType: BudgetPeriodType, now: Date = new Date()): BudgetPeriodRange {
  const s = startOfDay(now);
  switch (periodType) {
    case 'weekly': {
      const offset = (s.getDay() + 6) % 7; // 周一=0
      const start = s.getTime() - offset * DAY_MS;
      return { start, end: start + 7 * DAY_MS, prevStart: start - 7 * DAY_MS };
    }
    case 'monthly': {
      s.setDate(1);
      const start = s.getTime();
      const end = new Date(s).setMonth(s.getMonth() + 1);
      const prev = new Date(s).setMonth(s.getMonth() - 1);
      return { start, end, prevStart: prev };
    }
    case 'quarterly': {
      const qMonth = Math.floor(s.getMonth() / 3) * 3;
      s.setMonth(qMonth, 1);
      const start = s.getTime();
      const end = new Date(s).setMonth(s.getMonth() + 3);
      const prev = new Date(s).setMonth(s.getMonth() - 3);
      return { start, end, prevStart: prev };
    }
    case 'yearly': {
      s.setMonth(0, 1);
      const start = s.getTime();
      const end = new Date(s).setFullYear(s.getFullYear() + 1);
      const prev = new Date(s).setFullYear(s.getFullYear() - 1);
      return { start, end, prevStart: prev };
    }
    default:
      // custom:退化为月度区间(不破坏调用方;真实区间由调用方自带)
      return budgetPeriodRange('monthly', now);
  }
}
