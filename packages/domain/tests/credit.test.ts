import { describe, expect, it } from 'vitest';
import { billingCycleRange, daysUntilDue } from '../src/utils/credit';
import { carryover } from '../src/utils/budget';

describe('结转上月剩余(M04-F02)', () => {
  it('剩余为正才结转', () => {
    expect(carryover('1000', '700')).toBe('300');
    expect(carryover('1000', '1000')).toBe('0');
    expect(carryover('1000', '1200')).toBe('0'); // 超支不倒扣
  });
});

describe('信用卡账单周期(M02-F05)', () => {
  it('账单日 10、今天 9/26 → 周期 9/10 ~ 10/10', () => {
    const { start, end } = billingCycleRange(10, new Date(2026, 8, 26, 15, 30));
    expect(new Date(start).getDate()).toBe(10);
    expect(new Date(start).getMonth()).toBe(8);
    expect(new Date(end).getMonth()).toBe(9);
    expect(new Date(end).getDate()).toBe(10);
  });

  it('今天恰为账单日 → 新周期从今天起', () => {
    const { start, end } = billingCycleRange(26, new Date(2026, 8, 26));
    expect(new Date(start).getDate()).toBe(26);
    expect(new Date(end).getMonth()).toBe(9);
  });

  it('账单日超过当月天数取月末兜底(2 月无 31 日)', () => {
    const { start } = billingCycleRange(31, new Date(2026, 1, 15)); // 2026-02-15
    expect(new Date(start).getMonth()).toBe(0); // 1 月
    expect(new Date(start).getDate()).toBe(31);
  });

  it('距还款日:本月未到算本月,已过算下月', () => {
    expect(daysUntilDue(28, new Date(2026, 8, 26))).toBe(2);
    expect(daysUntilDue(25, new Date(2026, 8, 26))).toBe(29); // 9/25 已过 → 10/25
    expect(daysUntilDue(26, new Date(2026, 8, 26))).toBe(0);
  });
});
