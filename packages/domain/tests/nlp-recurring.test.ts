import { describe, expect, it } from 'vitest';
import { parseVoiceInput } from '../src/utils/nlp';
import { isDue, nextOccurrence } from '../src/utils/recurring';

describe('语音解析(M01-F03)', () => {
  it('「买咖啡 26 块」→ 金额 26 / 餐饮 / 支出', () => {
    const r = parseVoiceInput('买咖啡 26 块');
    expect(r.amount).toBe('26.00');
    expect(r.categoryKeyword).toBe('餐饮');
    expect(r.isIncome).toBe(false);
    expect(r.note).toContain('咖啡');
  });

  it('「收到工资 12000」→ 收入 / 工资', () => {
    const r = parseVoiceInput('收到工资 12000');
    expect(r.amount).toBe('12000.00');
    expect(r.isIncome).toBe(true);
    expect(r.categoryKeyword).toBe('工资');
  });

  it('中文数字「打车二十六块」', () => {
    const r = parseVoiceInput('打车二十六块');
    expect(r.amount).toBe('26.00');
    expect(r.categoryKeyword).toBe('交通');
  });

  it('「两块五」→ 2.50', () => {
    expect(parseVoiceInput('早餐两块五').amount).toBe('2.50');
  });

  it('无金额 → amount null(交由用户补填)', () => {
    expect(parseVoiceInput('买咖啡').amount).toBeNull();
  });
});

describe('周期记账(M01-F06)', () => {
  const base = new Date(2026, 8, 10, 9, 0).getTime(); // 2026-09-10 09:00

  it('日/周按天推进', () => {
    expect(nextOccurrence('daily', 1, base)).toBe(base + 86_400_000);
    expect(nextOccurrence('weekly', 2, base)).toBe(base + 14 * 86_400_000);
  });

  it('月推:9/10 → 10/10', () => {
    const next = nextOccurrence('monthly', 1, base);
    expect(new Date(next).getMonth()).toBe(9);
    expect(new Date(next).getDate()).toBe(10);
    expect(new Date(next).getHours()).toBe(9);
  });

  it('1/31 月推 → 2/28 月末兜底', () => {
    const jan31 = new Date(2026, 0, 31, 8, 0).getTime();
    const next = nextOccurrence('monthly', 1, jan31);
    expect(new Date(next).getMonth()).toBe(1);
    expect(new Date(next).getDate()).toBe(28);
  });

  it('季推/年推', () => {
    expect(new Date(nextOccurrence('quarterly', 1, base)).getMonth()).toBe(11);
    expect(new Date(nextOccurrence('yearly', 1, base)).getFullYear()).toBe(2027);
  });

  it('到期判定:未暂停且 next_run_at ≤ now', () => {
    expect(isDue({ next_run_at: 1000, paused: false }, 2000)).toBe(true);
    expect(isDue({ next_run_at: 3000, paused: false }, 2000)).toBe(false);
    expect(isDue({ next_run_at: 1000, paused: true }, 2000)).toBe(false);
  });
});

describe('语音解析日期上下文(第 19 轮 P0-7,Review 实证缺陷)', () => {
  it('日期数字不得被当金额:「2026年9月买咖啡26块」→ 26(修复前 2026)', () => {
    expect(parseVoiceInput('2026年9月买咖啡26块').amount).toBe('26.00');
  });

  it('「9月15日打车花了38元」→ 38(修复前 9)', () => {
    expect(parseVoiceInput('9月15日打车花了38元').amount).toBe('38.00');
  });

  it('「买HYA 5号电池花了9块」→ 9(修复前 5)', () => {
    expect(parseVoiceInput('买HYA 5号电池花了9块').amount).toBe('9.00');
  });

  it('裸数字兜底取最后一个非日期数字:「9月15日打车花了38」→ 38', () => {
    expect(parseVoiceInput('9月15日打车花了38').amount).toBe('38.00');
  });

  it('备注保留日期/型号数字,仅剔除金额词:「2026年9月买咖啡26块」note 含 2026年', () => {
    const r = parseVoiceInput('2026年9月买咖啡26块');
    expect(r.note).toContain('2026年');
    expect(r.note).toBe('2026年9月买咖啡'); // 金额词 26块 已剔除,日期数字完整保留;注:not.toContain('26') 会误伤 '2026'
  });
});
