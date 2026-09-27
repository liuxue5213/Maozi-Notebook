import { describe, expect, it } from 'vitest';
import { fromLocalInputValue, periodRange, toLocalInputValue, trendBuckets } from '../src/utils/period';

describe('周期区间(本地时区)', () => {
  it('月区间:从 1 号 00:00 到下月 1 号', () => {
    const now = new Date(2026, 8, 26, 15, 30); // 2026-09-26
    const { start, end } = periodRange('month', now);
    const s = new Date(start);
    const e = new Date(end);
    expect(s.getDate()).toBe(1);
    expect(s.getHours()).toBe(0);
    expect(e.getMonth()).toBe(9); // 10 月
    expect(end - start).toBeGreaterThan(27 * 24 * 3600 * 1000);
  });

  it('周区间:起始为周一', () => {
    const now = new Date(2026, 8, 26); // 2026-09-26 是周六
    const { start } = periodRange('week', now);
    const s = new Date(start);
    expect(s.getDay()).toBe(1);
    expect(s.getDate()).toBe(21); // 该周周一
  });

  it('日区间恰为 24 小时', () => {
    const { start, end } = periodRange('day', new Date(2026, 0, 15, 9, 0));
    expect(end - start).toBe(24 * 3600 * 1000);
  });

  it('趋势分桶覆盖周期', () => {
    expect(trendBuckets('week')).toHaveLength(7);
    expect(trendBuckets('year')).toHaveLength(12);
    const month = trendBuckets('month', new Date(2026, 1, 10)); // 二月
    expect(month).toHaveLength(28);
  });

  it('datetime-local 往返不丢分钟精度', () => {
    const ms = new Date(2026, 8, 26, 23, 59).getTime();
    expect(fromLocalInputValue(toLocalInputValue(ms))).toBe(ms);
  });
});
