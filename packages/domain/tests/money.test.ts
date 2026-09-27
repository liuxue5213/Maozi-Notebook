import { describe, expect, it } from 'vitest';
import { addAmount, cmpAmount, formatAmount, isValidAmount, negAmount, subAmount } from '../src/utils/money';

describe('money 定点运算', () => {
  it('无浮点误差', () => {
    expect(addAmount('0.1', '0.2')).toBe('0.3');
    expect(addAmount('0.0001', '0.0009')).toBe('0.001');
  });

  it('负数与借位', () => {
    expect(addAmount('-1.5', '2.25')).toBe('0.75');
    expect(subAmount('1', '0.0001')).toBe('0.9999');
    expect(negAmount('26')).toBe('-26');
    expect(negAmount('0')).toBe('0');
  });

  it('比较', () => {
    expect(cmpAmount('1.5', '1.45')).toBe(1);
    expect(cmpAmount('-2', '-1')).toBe(-1);
    expect(cmpAmount('3.00', '3')).toBe(0);
  });

  it('格式化千分位', () => {
    expect(formatAmount('1234567.891')).toBe('1,234,567.89');
    expect(formatAmount('26')).toBe('26.00');
  });

  it('合法性校验', () => {
    expect(isValidAmount('26')).toBe(true);
    expect(isValidAmount('-12.3456')).toBe(true);
    expect(isValidAmount('1.23456')).toBe(false); // 超过 4 位小数
    expect(isValidAmount('abc')).toBe(false);
    expect(isValidAmount('')).toBe(false);
  });
});
