/** 金额键盘四则运算求值(M01-F01):覆盖优先级/括号/一元负号/全角运算符/非法输入边界 */
import { describe, expect, it } from 'vitest';
import { evaluateExpression } from '../src/calc/evaluator';

describe('calc/evaluator(M01-F01)', () => {
  it('基础四则与优先级', () => {
    expect(evaluateExpression('2+3')).toBe('5');
    expect(evaluateExpression('2+3*4')).toBe('14'); // 乘法优先
    expect(evaluateExpression('(2+3)*4')).toBe('20');
    expect(evaluateExpression('10-2-3')).toBe('5'); // 左结合
    expect(evaluateExpression('100/5/2')).toBe('10');
  });

  it('全角运算符与空白', () => {
    expect(evaluateExpression('6×7')).toBe('42');
    expect(evaluateExpression('9÷3')).toBe('3');
    expect(evaluateExpression('5−2')).toBe('3');
    expect(evaluateExpression(' 1 + 2 ')).toBe('3');
  });

  it('一元负号', () => {
    expect(evaluateExpression('-5+8')).toBe('3');
    expect(evaluateExpression('(-3)*2')).toBe('-6');
    expect(evaluateExpression('2*-3')).toBe('-6');
  });

  it('小数与精度(4 位舍入)', () => {
    expect(evaluateExpression('0.1+0.2')).toBe('0.3');
    expect(evaluateExpression('1/3')).toBe('0.3333');
    expect(evaluateExpression('.5*2')).toBe('1');
  });

  it('除零返回 null', () => {
    expect(evaluateExpression('1/0')).toBeNull();
    expect(evaluateExpression('1/(2-2)')).toBeNull();
  });

  it('非法输入返回 null', () => {
    expect(evaluateExpression('')).toBeNull();
    expect(evaluateExpression('2+')).toBeNull();
    expect(evaluateExpression('+2')).toBeNull();
    expect(evaluateExpression('2++3')).toBeNull();
    expect(evaluateExpression('(1+2')).toBeNull(); // 括号不闭合
    expect(evaluateExpression('1+2)')).toBeNull(); // 多余右括号
    expect(evaluateExpression('1+a')).toBeNull(); // 非法字符
    expect(evaluateExpression('()')).toBeNull();
  });
});
