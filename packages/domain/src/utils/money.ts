/** 金额定点运算:一律以字符串承载,内部按 4 位小数放大为 bigint 计算,杜绝浮点误差(PRD 5.2 decimal(18,4)) */
const SCALE = 4;
const S = 10n ** BigInt(SCALE);

export const AMOUNT_RE = /^-?\d{1,14}(\.\d{1,4})?$/;

export function isValidAmount(s: string): boolean {
  return AMOUNT_RE.test(s);
}

function toScaled(s: string): bigint {
  if (!isValidAmount(s)) throw new Error(`invalid amount: ${s}`);
  const neg = s.startsWith('-');
  const abs = neg ? s.slice(1) : s;
  const [i, f = ''] = abs.split('.');
  const frac = (f + '0'.repeat(SCALE)).slice(0, SCALE);
  const v = BigInt(i || '0') * S + BigInt(frac || '0');
  return neg ? -v : v;
}

function fromScaled(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const int = a / S;
  let frac = (a % S).toString().padStart(SCALE, '0').replace(/0+$/, '');
  const body = frac ? `${int}.${frac}` : `${int}`;
  return neg && a !== 0n ? `-${body}` : body;
}

export function addAmount(a: string, b: string): string {
  return fromScaled(toScaled(a) + toScaled(b));
}

export function subAmount(a: string, b: string): string {
  return fromScaled(toScaled(a) - toScaled(b));
}

export function negAmount(a: string): string {
  return fromScaled(-toScaled(a));
}

export function cmpAmount(a: string, b: string): -1 | 0 | 1 {
  const x = toScaled(a);
  const y = toScaled(b);
  return x > y ? 1 : x < y ? -1 : 0;
}

export function amountToNumber(a: string): number {
  return Number(a);
}

/** 展示用:千分位 + 两位小数 */
export function formatAmount(a: string): string {
  const n = Number(a);
  if (!Number.isFinite(n)) return a;
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
