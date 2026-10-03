/** T-25:安全四则表达式求值(仅数字与 + - × ÷ ( ),Hermes 无 eval,自实现双栈算法) */
export function evalExpr(expr: string): number | null {
  const s = expr.replace(/[×xX]/g, '*').replace(/[÷/]/g, '/').replace(/[^0-9+\-*/().]/g, '');
  if (!s) return null;
  const nums: number[] = [];
  const ops: string[] = [];
  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };
  let i = 0;
  const apply = () => {
    const b = nums.pop(); const a = nums.pop(); const op = ops.pop();
    if (a === undefined || b === undefined || !op) return;
    nums.push(op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : (b === 0 ? NaN : a / b));
  };
  let prevIsNum = false;
  while (i < s.length) {
    const ch = s[i];
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.')) j++;
      nums.push(parseFloat(s.slice(i, j)));
      i = j; prevIsNum = true;
      continue;
    }
    if (ch === '(') { ops.push(ch); i++; prevIsNum = false; continue; }
    if (ch === ')') { while (ops.length && ops[ops.length - 1] !== '(') apply(); ops.pop(); i++; continue; }
    if ('+-*/'.includes(ch)) {
      // 一元负号(表达式开头或左括号/运算符后)
      if (ch === '-' && !prevIsNum) { nums.push(0); }
      while (ops.length && prec[ops[ops.length - 1]] >= prec[ch]) apply();
      ops.push(ch); i++; prevIsNum = false;
      continue;
    }
    i++;
  }
  while (ops.length) apply();
  const r = nums.pop();
  return r === undefined || Number.isNaN(r) ? null : Math.round(r * 100) / 100;
}
