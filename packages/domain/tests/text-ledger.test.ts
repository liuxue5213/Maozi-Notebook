import { describe, expect, it } from 'vitest';
import { buildTextLedger, renderTextLedger, shortAmount } from '../src/utils/text-ledger';
import type { TransactionRow } from '../src/types';

function tx(day: number, amount: string, note = '', extra: Partial<TransactionRow> = {}): TransactionRow {
  const at = new Date(2026, 8, day, 12, 0).getTime();
  return {
    id: `t${day}-${amount}-${note}`, ledger_id: 'l1', user_id: 'u1', type: 'expense',
    amount, currency: 'CNY', amount_base: amount, account_id: 'a1', happened_at: at,
    note, is_refunded: false, exclude_from_budget: false, attachment_count: 0, source: 'manual',
    client_version: 1, is_deleted: false, created_at: 1, updated_at: 1, ...extra,
  } as TransactionRow;
}

describe('金额短格式', () => {
  it('去尾零', () => {
    expect(shortAmount('6.30')).toBe('6.3');
    expect(shortAmount('12.00')).toBe('12');
    expect(shortAmount('9.05')).toBe('9.05');
    expect(shortAmount('0.50')).toBe('0.5');
  });
});

describe('文本草账(2026 年 9 月,周二开月)', () => {
  const txs = [
    tx(1, '6.30'), tx(1, '9.05', '砂纸'), tx(1, '12', '面'),
    tx(6, '17.50', '酒精'),
    tx(7, '6.30'),
    tx(13, '9.00', '冰'),
    tx(19, '21.85', '肉'),
    tx(20, '20.10'),
    tx(27, '8.00', '梨'),
  ];

  it('周块:1–6 / 7–13 / 14–20 / 21–27(周日收尾,月尾裁剪)', () => {
    const { weeks } = buildTextLedger(txs, 2026, 9);
    expect(weeks.map((w) => [w.days[0].day, w.days[w.days.length - 1].day])).toEqual([
      [1, 6], [7, 13], [14, 20], [21, 27],
    ]);
  });

  it('条目 = 金额拼品名,日内按时间序', () => {
    const { weeks } = buildTextLedger(txs, 2026, 9);
    expect(weeks[0].days[0].entries).toEqual(['6.3', '9.05砂纸', '12面']);
    expect(weeks[0].total).toBe('44.85'); // 6.3+9.05+12+17.5
  });

  it('无备注时退化为分类名(至少大类型),备注优先', () => {
    const catNameOf = (id: string | null | undefined) => ({ c1: '餐饮', c2: '交通' } as Record<string, string>)[id ?? ''] ?? '';
    const withCats = [
      tx(2, '20.00', '', { category_id: 'c1' }),        // 无备注 → 分类名
      tx(2, '5.00', '地铁', { category_id: 'c2' }),     // 有备注 → 备注
      tx(2, '3.00'),                                    // 无备注无分类 → 光金额
    ];
    const { weeks } = buildTextLedger(withCats, 2026, 9, catNameOf);
    expect(weeks[0].days[1].entries).toEqual(['20餐饮', '5地铁', '3']);
  });

  it('无数据周(28–30)被裁掉,总计 110.1', () => {
    const { weeks, total } = buildTextLedger(txs, 2026, 9);
    expect(weeks.map((w) => w.total)).toEqual(['44.85', '15.3', '41.95', '8']);
    expect(total).toBe('110.1');
  });

  it('收入/软删除不计入', () => {
    const withNoise = [
      ...txs,
      tx(2, '500', '工资', { type: 'income' }),
      tx(2, '99', '误删', { is_deleted: true, deleted_at: 1 }),
    ];
    const { total } = buildTextLedger(withNoise, 2026, 9);
    expect(total).toBe('110.1');
  });

  it('渲染与手写格式对齐:头行/日行双空格/周合计/总合计', () => {
    const text = renderTextLedger(txs, 2026, 9);
    const lines = text.split('\n');
    expect(lines[0]).toBe('2026 9月消费');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('1  6.3  9.05砂纸  12面');
    expect(lines[7]).toBe('6  17.5酒精');
    expect(lines[8]).toBe('合计  44.85');
    expect(lines[9]).toBe('');
    expect(lines[10]).toBe('7  6.3');
    expect(lines).toContain('19  21.85肉');
    expect(lines[lines.length - 2]).toBe('合计  44.85 + 15.3 + 41.95 + 8 =  110.1');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('空月份:只有头行与零合计', () => {
    const text = renderTextLedger([], 2026, 10);
    expect(text).toBe('2026 10月消费\n\n合计  0\n');
  });
});

describe('文本账币种口径统一(P0-9,第 27 轮)', () => {
  it('明细行与合计统一取 amount_base:折算额 ≠ 原币额时导出账自洽', () => {
    // USD 10 → 折算 CNY 72:明细应写 72(与合计一致),修复前明细写 10、合计 72,肉眼不平
    const tx = (id: string, amt: string, base: string, day: number): TransactionRow => ({
      id, ledger_id: 'l1', user_id: 'u', member_id: null, type: 'expense', amount: amt,
      currency: 'USD', amount_base: base, exchange_rate: '7.2', category_id: null,
      account_id: 'a1', to_account_id: null, happened_at: new Date(2026, 4, day).getTime(),
      note: `item-${id}`, is_refunded: false, refund_of_id: null, reimburse_status: null,
      exclude_from_budget: false, attachment_count: 0, source: 'manual',
      client_version: 1, server_version: null, is_deleted: false, deleted_at: null,
      created_at: 1, updated_at: 1,
    });
    const { weeks, total } = buildTextLedger(
      [tx('a', '10', '72.00', 2), tx('b', '20', '144.00', 2)],
      2026, 5,
    );
    const day2 = weeks.flatMap((w) => w.days).find((d) => d.day === 2);
    expect(day2?.entries[0]).toContain('72'); // shortAmount 去尾零;修复前此处为 '10'(原币额)
    expect(Number(day2?.total)).toBe(216); // total 经 addAmount 定点运算
    expect(Number(total)).toBe(216); // 明细 72+144 与合计一致
  });
});
