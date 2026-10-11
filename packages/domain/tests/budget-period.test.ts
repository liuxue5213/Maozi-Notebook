import { describe, expect, it } from 'vitest';
import { budgetPeriodRange } from '../src/utils/budget-period';

// 固定锚点:2026-10-08(周四) 15:30 本地时间
const NOW = new Date(2026, 9, 8, 15, 30);

describe('budgetPeriodRange(N1 预算多周期,双端唯一口径)', () => {
  it('weekly:周一始 7 天,prev=上周一', () => {
    const r = budgetPeriodRange('weekly', NOW);
    const s = new Date(r.start);
    const e = new Date(r.end);
    expect(s.getDay()).toBe(1); // 周一
    expect(e.getTime() - r.start).toBe(7 * 86_400_000);
    expect(r.prevStart).toBe(r.start - 7 * 86_400_000);
    expect(r.start).lte(NOW.getTime());
    expect(r.end).gt(NOW.getTime());
  });

  it('monthly:自然月,prev=上月', () => {
    const r = budgetPeriodRange('monthly', NOW);
    const s = new Date(r.start);
    const e = new Date(r.end);
    expect(s.getDate()).toBe(1);
    expect(s.getMonth()).toBe(9); // 10 月
    expect(e.getMonth()).toBe(10); // 11-01
    expect(new Date(r.prevStart).getMonth()).toBe(8); // 9 月
  });

  it('quarterly:自然季(10 月 → Q4:10/01-01/01),prev=上季', () => {
    const r = budgetPeriodRange('quarterly', NOW);
    const s = new Date(r.start);
    const e = new Date(r.end);
    expect(s.getDate()).toBe(1);
    expect(s.getMonth()).toBe(9); // Q4 始于 10 月
    expect(e.getMonth()).toBe(0); // 次年 1 月
    expect(new Date(r.prevStart).getMonth()).toBe(6); // Q3 始于 7 月
  });

  it('yearly:自然年,prev=去年', () => {
    const r = budgetPeriodRange('yearly', NOW);
    const s = new Date(r.start);
    expect(s.getMonth()).toBe(0);
    expect(s.getDate()).toBe(1);
    expect(s.getFullYear()).toBe(2026);
    expect(new Date(r.prevStart).getFullYear()).toBe(2025);
  });

  it('custom:退化为月度区间(占位兼容)', () => {
    const c = budgetPeriodRange('custom', NOW);
    const m = budgetPeriodRange('monthly', NOW);
    expect(c).toEqual(m);
  });
});
