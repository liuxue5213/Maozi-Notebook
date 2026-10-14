import { describe, expect, it } from 'vitest';
import { parseTextLedger } from '@ledgerone/domain';
import { prepareTextLedgerEntries } from '../src/lib/text-ledger-import';

describe('手机端手写账导入日期', () => {
  it('使用标题中的年月，并保留同日同额同名的两笔', () => {
    const parsed = parseTextLedger('2025 9月消费\n3  7早餐  5午餐  5午餐\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { entries, invalid } = prepareTextLedgerEntries(parsed.data);
    expect(invalid).toBe(0);
    expect(entries).toHaveLength(3);
    expect(new Date(entries[0].happenedAt).getFullYear()).toBe(2025);
    expect(new Date(entries[0].happenedAt).getMonth()).toBe(8);
    expect(entries.map((row) => row.occurrence)).toEqual([0, 1, 2]);
  });

  it('跳过不存在的月内日期', () => {
    const parsed = parseTextLedger('2025 2月消费\n29  10午餐\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(prepareTextLedgerEntries(parsed.data)).toMatchObject({ entries: [], invalid: 1 });
  });
});
