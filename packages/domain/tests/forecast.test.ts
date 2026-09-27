import { describe, expect, it } from 'vitest';
import { forecastBudget } from '../src/utils/forecast';

describe('预算预测(M04-F05)', () => {
  const monthStart = new Date(2026, 8, 1).getTime(); // 2026-09-01,30 天

  it('9/16 已花 2400 → 月末预测 4800,日均可用 (6000-2400)/15=240', () => {
    const f = forecastBudget('6000', '2400', new Date(2026, 8, 16, 12, 0), monthStart);
    expect(f.totalDays).toBe(30);
    expect(f.elapsedDays).toBe(16);
    expect(f.predictedSpend).toBe('4500.00'); // 2400/16*30
    expect(f.overRisk).toBe(false);
    expect(f.dailyAvailable).toBe('240.00'); // 3600/15
  });

  it('消费超前 → overRisk', () => {
    const f = forecastBudget('3000', '2400', new Date(2026, 8, 16, 12, 0), monthStart);
    expect(f.predictedSpend).toBe('4500.00');
    expect(f.overRisk).toBe(true);
  });

  it('月初第一天 elapsed=1,不除零', () => {
    const f = forecastBudget('3000', '100', new Date(2026, 8, 1, 0, 0, 1), monthStart);
    expect(f.elapsedDays).toBe(1);
    expect(f.predictedSpend).toBe('3000.00');
    expect(f.dailyAvailable).toBe('96.67'); // (3000-100)/30 天
  });
});

import { forecastMonthEnd, type HistoryMonth } from '../src/utils/forecast';

describe('历史参照月底预测(forecastMonthEnd)', () => {
  // 近两个月:每日 100,共 3000(30 天)/ 3000(30 天,人为构造)
  const mkMonth = (year: number, month: number, days: number, perDay: number): HistoryMonth => ({
    year, month, daily: Array.from({ length: days }, () => perDay),
  });
  const history = [mkMonth(2026, 7, 30, 100), mkMonth(2026, 8, 30, 100)]; // 各 3000
  const monthStart = new Date(2026, 8, 1).getTime(); // 2026-09,30 天

  it('与历史同节奏:预测 = 历史月均', () => {
    // 9/16 已花 1600(= 历史同期 1600)→ 剩余 1400 → 两路线都是 3000
    const f = forecastMonthEnd(history, 1600, new Date(2026, 8, 16, 12, 0), monthStart);
    expect(f.sampleMonths).toBe(2);
    expect(f.historyAvg).toBe(3000);
    expect(f.samePeriodAvg).toBe(1600);
    expect(f.paceEnd).toBe(3000);
    expect(f.historyEnd).toBe(3000);
    expect(f.predicted).toBe(3000);
    expect(f.vsAvgPct).toBe(0);
  });

  it('本月节奏偏快:两路线融合取中间值', () => {
    // 9/16 已花 3200 → paceEnd = 6000;历史同期 1600 → historyEnd = 3200+1400 = 4600;综合 5300
    const f = forecastMonthEnd(history, 3200, new Date(2026, 8, 16, 12, 0), monthStart);
    expect(f.paceEnd).toBe(6000);
    expect(f.historyEnd).toBe(4600);
    expect(f.predicted).toBe(5300);
    expect(f.vsAvgPct).toBe(77);
  });

  it('当月还没花钱 → 预测取历史月均', () => {
    const f = forecastMonthEnd(history, 0, new Date(2026, 8, 3, 9, 0), monthStart);
    expect(f.predicted).toBe(3000);
  });

  it('无历史 → 退化为纯节奏外推', () => {
    const f = forecastMonthEnd([], 1600, new Date(2026, 8, 16, 12, 0), monthStart);
    expect(f.sampleMonths).toBe(0);
    expect(f.predicted).toBe(3000);
    expect(f.vsAvgPct).toBeNull();
  });
});

describe('零记录月剔除', () => {
  it('全月无记录的历史月不参与月均', () => {
    const hist = [
      { year: 2026, month: 6, daily: new Array(30).fill(0) },        // 无记录
      { year: 2026, month: 7, daily: new Array(30).fill(100) },      // 3000
      { year: 2026, month: 8, daily: new Array(30).fill(100) },      // 3000
    ];
    const f = forecastMonthEnd(hist, 1600, new Date(2026, 8, 16, 12, 0), new Date(2026, 8, 1).getTime());
    expect(f.sampleMonths).toBe(2);
    expect(f.historyAvg).toBe(3000);
    expect(f.predicted).toBe(3000);
  });
});
