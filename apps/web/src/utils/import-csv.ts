/** 账单 CSV 解析(M05-F01):支持支付宝 / 微信 / 通用预设映射;全部纯字符串处理 */

export type FieldSlot = 'date' | 'amount' | 'type' | 'merchant' | 'note' | 'none';

export interface ColumnMapping {
  slots: FieldSlot[];
}

export interface ParsedRow {
  amount: string;
  /** 支出为 true */
  isExpense: boolean;
  happenedAt: number;
  merchant: string;
  note: string;
  raw: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  skipped: number;
  /** 无法识别金额的行号(0 起) */
  badLines: number[];
}

/** CSV 单行解析:处理引号与逗号 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** 来源识别:扫全文(支付宝/微信导出在表头前的前导行里含平台名) */
export function detectSource(text: string): 'alipay' | 'wechat' | 'generic' {
  const head = text.slice(0, 2000).toLowerCase();
  if (head.includes('支付宝') || head.includes('alipay')) return 'alipay';
  if (head.includes('微信支付') || head.includes('wechat')) return 'wechat';
  return 'generic';
}

/** 各来源的默认列映射(M05-F02 预设):索引 0 起 */
export function defaultMapping(source: 'alipay' | 'wechat' | 'generic', headers: string[]): ColumnMapping {
  const find = (re: RegExp): number => headers.findIndex((h) => re.test(h));
  if (source === 'alipay') {
    // 支付宝导出:交易时间、交易分类、交易对方、商品说明、收/支、金额…
    const slots: FieldSlot[] = headers.map(() => 'none');
    const iDate = find(/交易时间|日期/);
    const iType = find(/收\/支|收支/);
    const iAmount = find(/金额/);
    const iMerchant = find(/交易对方|商户/);
    const iNote = find(/商品说明|备注/);
    if (iDate >= 0) slots[iDate] = 'date';
    if (iType >= 0) slots[iType] = 'type';
    if (iAmount >= 0) slots[iAmount] = 'amount';
    if (iMerchant >= 0) slots[iMerchant] = 'merchant';
    if (iNote >= 0) slots[iNote] = 'note';
    return { slots };
  }
  if (source === 'wechat') {
    // 微信导出:交易时间、交易类型、交易对方、商品、收/支、金额(元)…
    const slots: FieldSlot[] = headers.map(() => 'none');
    const iDate = find(/交易时间|日期/);
    const iType = find(/收\/支|收支/);
    const iAmount = find(/金额/);
    const iMerchant = find(/交易对方|商户/);
    const iNote = find(/商品|备注/);
    if (iDate >= 0) slots[iDate] = 'date';
    if (iType >= 0) slots[iType] = 'type';
    if (iAmount >= 0) slots[iAmount] = 'amount';
    if (iMerchant >= 0) slots[iMerchant] = 'merchant';
    if (iNote >= 0) slots[iNote] = 'note';
    return { slots };
  }
  // 通用:按表头语义猜
  const slots: FieldSlot[] = headers.map(() => 'none');
  const iDate = find(/时间|日期|date/i);
  const iAmount = find(/金额|amount/i);
  const iType = find(/收\/支|收支|类型|type/i);
  const iMerchant = find(/商户|对方|merchant|payee/i);
  const iNote = find(/备注|说明|note|memo/i);
  if (iDate >= 0) slots[iDate] = 'date';
  if (iType >= 0) slots[iType] = 'type';
  if (iAmount >= 0) slots[iAmount] = 'amount';
  if (iMerchant >= 0) slots[iMerchant] = 'merchant';
  if (iNote >= 0) slots[iNote] = 'note';
  return { slots };
}

function parseDate(s: string): number {
  const t = s.trim().replace(/^"|"$/g, '');
  // 常见格式:2026-09-20 14:30:05 / 2026/09/20 14:30 / 2026-09-20
  const m = t.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日]?\s*(\d{1,2})?:?(\d{2})?:?(\d{2})?/);
  if (!m) return NaN;
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4] ?? '0'), Number(m[5] ?? '0'), Number(m[6] ?? '0'),
  ).getTime();
}

function parseAmount(s: string): string {
  const cleaned = s.replace(/[¥￥￥,\s"￥]/g, '').replace(/[¥￥,\s]/g, '').replace(/[^\d.-]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n.toFixed(2);
}

/** 表头探测:支付宝/微信导出表头前有前导行;取前 30 行内首个含 ≥2 个语义关键词的行 */
export function findHeaderLineIndex(lines: string[]): number {
  const limit = Math.min(lines.length, 30);
  for (let i = 0; i < limit; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length < 2) continue;
    const hits = cells.filter((c) => /(时间|日期|金额|收\/支|商户|对方|备注|amount|date|type|merchant)/i.test(c)).length;
    if (hits >= 2) return i;
  }
  return 0;
}

export function parseCsv(text: string, mapping: ColumnMapping): ParseResult {
  // 去 BOM、跳过空行与平台前导行,定位表头
  const allLines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const headerIdx = findHeaderLineIndex(allLines);
  const lines = allLines.slice(headerIdx);
  if (!lines.length) return { rows: [], skipped: 0, badLines: [] };
  const headers = splitCsvLine(lines[0]);
  const idx = {
    date: mapping.slots.findIndex((s) => s === 'date'),
    amount: mapping.slots.findIndex((s) => s === 'amount'),
    type: mapping.slots.findIndex((s) => s === 'type'),
    merchant: mapping.slots.findIndex((s) => s === 'merchant'),
    note: mapping.slots.findIndex((s) => s === 'note'),
  };
  const rows: ParsedRow[] = [];
  const badLines: number[] = [];
  let skipped = 0;
  for (let li = 1; li < lines.length; li++) {
    const cells = splitCsvLine(lines[li]);
    const amount = idx.amount >= 0 ? parseAmount(cells[idx.amount] ?? '') : '';
    if (!amount) {
      skipped++;
      badLines.push(li - 1);
      continue;
    }
    const dateTs = idx.date >= 0 ? parseDate(cells[idx.date] ?? '') : NaN;
    const rawType = idx.type >= 0 ? (cells[idx.type] ?? '').trim() : '';
    if (rawType.includes('不计收支')) {
      // 支付宝「不计收支」(余额宝转入等)非收支,跳过而非误记为支出
      skipped++;
      continue;
    }
    const isExpense = rawType ? !/收入|收\s*$/.test(rawType) : true;
    rows.push({
      amount,
      isExpense,
      happenedAt: Number.isNaN(dateTs) ? Date.now() : dateTs,
      merchant: idx.merchant >= 0 ? (cells[idx.merchant] ?? '').trim() : '',
      note: idx.note >= 0 ? (cells[idx.note] ?? '').trim() : '',
      raw: lines[li],
    });
  }
  void headers;
  return { rows, skipped, badLines };
}
