/** 金额键盘四则运算(M01-F01):支持 + − × ÷ 与括号,shunting-yard 求值;非法或除零返回 null */
export function evaluateExpression(expr: string): string | null {
  const s = expr.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\s+/g, '');
  if (!s) return null;
  const tokens = s.match(/(\d+\.?\d*|\.\d+|[+\-*/()])/g);
  if (!tokens || tokens.join('') !== s) return null;

  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };
  const out: Array<number | string> = [];
  const ops: string[] = [];
  let prev: string | null = null;
  for (const t of tokens) {
    if (/^[\d.]/.test(t)) {
      out.push(parseFloat(t));
    } else if (t === '(') {
      ops.push(t);
    } else if (t === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') out.push(ops.pop()!);
      if (!ops.length) return null;
      ops.pop();
    } else if (t === '-' && (prev === null || prev === '(' || prec[prev] !== undefined)) {
      out.push(0); // 一元负号
      ops.push(t);
    } else {
      while (ops.length && prec[ops[ops.length - 1]] >= prec[t]) out.push(ops.pop()!);
      ops.push(t);
    }
    prev = t;
  }
  while (ops.length) {
    const op = ops.pop()!;
    if (op === '(') return null;
    out.push(op);
  }

  const st: number[] = [];
  for (const t of out) {
    if (typeof t === 'number') {
      st.push(t);
    } else {
      const b = st.pop();
      const a = st.pop();
      if (a === undefined || b === undefined) return null;
      if (t === '+') st.push(a + b);
      else if (t === '-') st.push(a - b);
      else if (t === '*') st.push(a * b);
      else {
        if (b === 0) return null;
        st.push(a / b);
      }
    }
  }
  if (st.length !== 1 || !isFinite(st[0])) return null;
  return String(parseFloat(st[0].toFixed(4)));
}
