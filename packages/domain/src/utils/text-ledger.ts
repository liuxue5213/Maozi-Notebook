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
    // P0-9(第 27 轮):明细与合计统一取折算主币种金额 amount_base —— 修复前明细 r.amount、
    // 合计 r.amount_base,单币种无感,多币种下导出账肉眼不平且与手写原稿核对不上
    e.entries.push(`${shortAmount(r.amount_base)}${name}`);
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
  /** 文本中标注的合计(单数字 = 周小计,按出现顺序) */
  statedTotals: string[];
  /** T7:「= C」总校验基准(无则为 null) */
  statedGrandTotal: string | null;
}

const AMOUNT_RE = /^(\d{1,6}(?:\.\d{1,2})?)([\s\S]*)$/;

/** T3(需求 4.3/IMP-FR-02,第 31 轮):加法表达式「12.9+8.9线」→ 合并为 1 笔 21.80,品名取尾部 */
const ADDITION_RE = /^(\d{1,6}(?:\.\d{1,2})?)(?:\+(\d{1,6}(?:\.\d{1,2})?))+([\s\S]*)$/;

/** 加法 token → 合并后的单笔(金额求和定点化,品名为最后一个加数后的尾部文本) */
function extractAddition(token: string): { amount: string; name: string } | null {
  const m = token.match(ADDITION_RE);
  if (!m) return null;
  const addends = token.match(/\d{1,6}(?:\.\d{1,2})?/g) ?? [];
  // 尾部非金额文本(品名)挂在最后一个加数上
  const lastAmt = addends[addends.length - 1];
  const tail = token.slice(token.lastIndexOf(lastAmt) + lastAmt.length).trim();
  let total = 0;
  for (const a of addends) total += Number(a);
  return { amount: total.toFixed(2), name: tail };
}

interface RawEntry {
  day: number;
  amount: string;
  name: string;
}

/** 单 token → 一或多个条目(粘连金额如 9.311.34 按贪婪拆分,标记 name 空) */
function extractFromToken(token: string, out: RawEntry[], day: number, depth: number): void {
  if (depth > 6 || !token) return;
  // T3(第 31 轮):加法表达式优先合并为 1 笔(需求决策 F-01)
  const add = extractAddition(token);
  if (add) {
    out.push({ day, amount: add.amount, name: add.name });
    return;
  }
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
  // T5/T4(需求 4.3):「品名 单空格 金额…」→ 品名归当前笔,金额部分递归
  // (如「18包子 5.24+3.39水管」→ 18包子 + 8.63水管;「7.63 画」由上层单空格切分进入)
  const mid = rest.match(/^(\S+)\s+(\d[\s\S]*)$/);
  if (mid && /^\d/.test(token)) {
    out.push({ day, amount, name: mid[1] });
    extractFromToken(mid[2], out, day, depth + 1);
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
  let statedGrandTotal: string | null = null;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^合计/.test(line)) {
      // T7:「合计 A + B + … =  C」的 C 为总校验基准;单数字为周小计(按出现顺序)
      const grand = line.match(/=\s*(\d+(?:\.\d{1,2})?)\s*$/);
      if (grand) {
        statedGrandTotal = grand[1];
        continue;
      }
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
  return { ok: true, data: { year, month, entries, ignoredLines, statedTotals, statedGrandTotal } };
}

/* ================= 三路核对(IMP-FR-03,第 31 轮) ================= */

export interface ReconcileDiff {
  kind: 'week' | 'total';
  label: string;
  stated: string;
  computed: string;
  /** computed − stated(±0.01 内视为平,记 '0') */
  diff: string;
}

export interface ReconcileResult {
  weeks: Array<{ weekIndex: number; computed: string; stated: string | null; diff: string | null }>;
  total: { computed: string; stated: string | null; diff: string | null };
  /** 所有 |diff| > 0.01 的差异(IMP-FR-04:未处理差异阻断全部确认) */
  unresolvedDiffs: ReconcileDiff[];
}

/** 与 buildTextLedger 同一归桶:day → 周序号(周一起始,首尾周按月边界) */
function weekIndexOf(year: number, month: number, day: number): number {
  const offset = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  return Math.floor((offset + day - 1) / 7);
}

/**
 * 三路核对:复算(解析条目按周/总计求和) vs 文本标注(单数字合计行 / 「= C」总校验)。
 * 差异阈值 0.01;差异进 unresolvedDiffs,由调用方强制用户三选一(需求 4.4 决策 Q2)。
 */
export function reconcileTextLedger(parsed: ParsedTextLedger): ReconcileResult {
  const { year, month } = parsed;
  const daysInMonth = new Date(year, month, 0).getDate();
  const weeksCount = Math.ceil(((new Date(year, month - 1, 1).getDay() + 6) % 7 + daysInMonth) / 7);
  const weekSums = new Array(weeksCount).fill('0');
  let computedTotal = '0';
  for (const e of parsed.entries) {
    const wi = weekIndexOf(year, month, e.day);
    weekSums[wi] = addAmount(weekSums[wi], e.amount);
    computedTotal = addAmount(computedTotal, e.amount);
  }
  const diffOf = (computed: string, stated: string): string =>
    Math.abs(Number(computed) - Number(stated)) <= 0.01 ? '0' : (Number(computed) - Number(stated)).toFixed(2);
  const unresolved: ReconcileDiff[] = [];
  const weeks = weekSums.map((computed, i) => {
    const stated = parsed.statedTotals[i] ?? null;
    const diff = stated !== null ? diffOf(computed, stated) : null;
    if (stated !== null && diff !== null && diff !== '0') {
      unresolved.push({ kind: 'week', label: '周' + (i + 1), stated, computed, diff });
    }
    return { weekIndex: i, computed, stated, diff };
  });
  const totalDiff = parsed.statedGrandTotal !== null ? diffOf(computedTotal, parsed.statedGrandTotal) : null;
  if (parsed.statedGrandTotal !== null && totalDiff !== null && totalDiff !== '0') {
    unresolved.push({ kind: 'total', label: '总计', stated: parsed.statedGrandTotal, computed: computedTotal, diff: totalDiff });
  }
  const total = { computed: computedTotal, stated: parsed.statedGrandTotal, diff: totalDiff };
  return { weeks, total, unresolvedDiffs: unresolved };
}
