import { addAmount } from './money';
import type { TransactionRow } from '../types';

/**
 * 文本草账导出(用户手写账格式):
 *   2026 9月消费
 *   1    6.3  9.05砂纸  12面
 *   合计  267.48        ← 每个自然周(周一~周日,跨月裁剪)一个小计
 *   合计  267.48 + 260.89 + 381.21 =  909.58
 * 条目 = 金额(去尾零)直接拼接品名;条目间两个空格;只导出支出。
 */

/** 金额短格式:6.30→6.3,12.00→12,9.05→9.05 */
export function shortAmount(amount: string): string {
  return String(parseFloat(Number(amount).toFixed(2)));
}

export interface TextLedgerDay {
  day: number;
  entries: string[];
  total: string;
}

export interface TextLedgerWeek {
  days: TextLedgerDay[];
  total: string;
}

/** 品名解析器:由调用方提供(如 Web 端用分类表查名) */
export type CategoryNameOf = (categoryId: string | null | undefined) => string;

export function buildTextLedger(
  txs: TransactionRow[],
  year: number,
  month: number,
  categoryNameOf?: CategoryNameOf,
): { weeks: TextLedgerWeek[]; total: string } {
  const monthStart = new Date(year, month - 1, 1).getTime();
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthEnd = new Date(year, month, 1).getTime();

  const rows = txs
    .filter((t) => !t.is_deleted && t.type === 'expense' && t.happened_at >= monthStart && t.happened_at < monthEnd)
    .sort((a, b) => a.happened_at - b.happened_at);

  const byDay = new Map<number, { entries: string[]; total: string }>();
  for (const r of rows) {
    const day = new Date(r.happened_at).getDate();
    const e = byDay.get(day) ?? { entries: [], total: '0' };
    // 品名:备注优先(具体用途);无备注退化为分类名(至少是大类型)
    const note = (r.note ?? '').trim();
    const cat = r.category_id ? (categoryNameOf?.(r.category_id) ?? '').trim() : '';
    const name = note || cat;
    e.entries.push(`${shortAmount(r.amount)}${name}`);
    e.total = addAmount(e.total, r.amount_base);
    byDay.set(day, e);
  }

  // 周块:周一起始(周日至此周收尾),首尾周按月边界裁剪
  const offset = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const weeks: TextLedgerWeek[] = [];
  let cur: TextLedgerWeek = { days: [], total: '0' };
  for (let d = 1; d <= daysInMonth; d++) {
    const info = byDay.get(d);
    cur.days.push({ day: d, entries: info?.entries ?? [], total: info?.total ?? '0' });
    cur.total = addAmount(cur.total, info?.total ?? '0');
    if ((offset + d) % 7 === 0) {
      weeks.push(cur);
      cur = { days: [], total: '0' };
    }
  }
  if (cur.days.length) weeks.push(cur);

  const total = weeks.reduce((acc, w) => addAmount(acc, w.total), '0');
  return { weeks: weeks.filter((w) => w.total !== '0'), total };
}

export function renderTextLedger(txs: TransactionRow[], year: number, month: number, categoryNameOf?: CategoryNameOf): string {
  const { weeks, total } = buildTextLedger(txs, year, month, categoryNameOf);
  const lines: string[] = [`${year} ${month}月消费`, ''];
  for (const w of weeks) {
    for (const d of w.days) {
      lines.push(d.entries.length ? `${d.day}  ${d.entries.join('  ')}` : `${d.day}`);
    }
    lines.push(`合计  ${shortAmount(w.total)}`);
    lines.push('');
  }
  const sumLine = weeks.length
    ? `合计  ${weeks.map((w) => shortAmount(w.total)).join(' + ')} =  ${shortAmount(total)}`
    : `合计  0`;
  lines.push(sumLine);
  return lines.join('\n') + '\n';
}

/* ================= 反向解析(手写账 → 结构化) ================= */

export interface TextLedgerEntry {
  day: number;
  amount: string;
  name: string;
}

export interface ParsedTextLedger {
  year: number;
  month: number;
  entries: TextLedgerEntry[];
  /** 无法解析的行数(不含空行/合计) */
  ignoredLines: number;
  /** 文本中标注的合计(周小计与总计,用于核对) */
  statedTotals: string[];
}

const AMOUNT_RE = /^(\d{1,6}(?:\.\d{1,2})?)([\s\S]*)$/;

interface RawEntry {
  day: number;
  amount: string;
  name: string;
}

/** 单 token → 一或多个条目(粘连金额如 9.311.34 按贪婪拆分,标记 name 空) */
function extractFromToken(token: string, out: RawEntry[], day: number, depth: number): void {
  if (depth > 6 || !token) return;
  const m = token.match(AMOUNT_RE);
  if (!m) return;
  const amount = m[1];
  const rest = m[2].trim();
  if (/^\d/.test(rest)) {
    // 粘连了下一笔金额(如 26 5 之间丢了空格的概率低,但 265 这类无法区分,只处理带小数点边界的)
    out.push({ day, amount, name: '' });
    extractFromToken(rest, out, day, depth + 1);
    return;
  }
  out.push({ day, amount, name: rest });
}

/** 日行剩余部分 → 条目数组:优先 2+ 空格切分;单个空格且含数字边界时退化为单空格切分 */
export function splitDayEntries(rest: string): Array<{ amount: string; name: string }> {
  const out: RawEntry[] = [];
  let parts = rest.split(/\s{2,}|\t+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1 && /\s\d/.test(rest)) {
    parts = rest.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  }
  for (const p of parts) {
    extractFromToken(p, out, 0, 0);
  }
  return out.map(({ amount, name }) => ({ amount, name }));
}

/** 解析手写账文本:需要「YYYY M月消费」标题行;合计行自动跳过并记录用于核对 */
export function parseTextLedger(text: string): { ok: false; reason: string } | { ok: true; data: ParsedTextLedger } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let year = 0;
  let month = 0;
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const h = lines[i].match(/^(\d{4})\s*(\d{1,2})\s*月消费/);
    if (h) {
      year = Number(h[1]);
      month = Number(h[2]);
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return { ok: false, reason: '缺少标题行(如「2026 9月消费」),无法确定月份' };
  }
  const entries: TextLedgerEntry[] = [];
  let ignoredLines = 0;
  const statedTotals: string[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^合计/.test(line)) {
      const nums = [...line.matchAll(/\d+(?:\.\d{1,2})?/g)].map((m) => m[0]);
      if (nums.length === 1) statedTotals.push(nums[0]);
      continue;
    }
    const dm = line.match(/^(\d{1,2})(?:\s+([\s\S]+))?$/);
    if (!dm) {
      ignoredLines++;
      continue;
    }
    const day = Number(dm[1]);
    if (day < 1 || day > 31) {
      ignoredLines++;
      continue;
    }
    const rest = (dm[2] ?? '').trim();
    if (!rest) continue; // 空日号行
    const dayEntries = splitDayEntries(rest);
    for (const e of dayEntries) {
      entries.push({ day, amount: e.amount, name: e.name });
    }
  }
  return { ok: true, data: { year, month, entries, ignoredLines, statedTotals } };
}
