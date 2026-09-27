import { describe, expect, it } from 'vitest';
import { parseTextLedger, renderTextLedger, shortAmount } from '../src/utils/text-ledger';
import type { TransactionRow } from '../src/types';

const SAMPLE = `2026 9月消费

1    6.3  9.05砂纸  12面
2   6.3  1.8水
合计  27.4
`;

describe('手写账反向解析(parseTextLedger)', () => {
  it('标题行解析年月,日行拆出金额+品名', () => {
    const r = parseTextLedger(SAMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.year).toBe(2026);
    expect(r.data.month).toBe(9);
    expect(r.data.entries).toEqual([
      { day: 1, amount: '6.3', name: '' },
      { day: 1, amount: '9.05', name: '砂纸' },
      { day: 1, amount: '12', name: '面' },
      { day: 2, amount: '6.3', name: '' },
      { day: 2, amount: '1.8', name: '水' },
    ]);
    expect(r.data.ignoredLines).toBe(0);
  });

  it('合计行跳过并记录标注值', () => {
    const r = parseTextLedger(SAMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.statedTotals).toEqual(['27.4']);
  });

  it('缺标题行 → 报错', () => {
    const r = parseTextLedger('1  6.3\n');
    expect(r.ok).toBe(false);
  });

  it('单空格分隔也可解析', () => {
    const r = parseTextLedger(`2026 9月消费\n3  5.6 15.9饭冰 6.5烧饼\n`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.entries).toEqual([
      { day: 3, amount: '5.6', name: '' },
      { day: 3, amount: '15.9', name: '饭冰' },
      { day: 3, amount: '6.5', name: '烧饼' },
    ]);
  });

  it('与导出互为逆操作:导出的文本可完整还原', () => {
    const txs = [
      { id: 'a', type: 'expense', amount: '26.50', amount_base: '26.50', note: '咖啡', happened_at: new Date(2026, 8, 5, 10, 0).getTime(), is_deleted: false },
      { id: 'b', type: 'expense', amount: '3.6', amount_base: '3.6', note: '', happened_at: new Date(2026, 8, 5, 15, 0).getTime(), is_deleted: false },
    ] as unknown as TransactionRow[];
    const exported = renderTextLedger(txs, 2026, 9);
    const r = parseTextLedger(exported);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const day5 = r.data.entries.filter((e) => e.day === 5);
    expect(day5).toEqual([
      { day: 5, amount: '26.5', name: '咖啡' },
      { day: 5, amount: '3.6', name: '' },
    ]);
  });

  it('短金额格式往返一致', () => {
    expect(shortAmount('9.10')).toBe('9.1');
  });
});
