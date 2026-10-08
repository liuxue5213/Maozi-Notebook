/**
 * CSV 生成(T-23 双端共享):与 Web utils/csv.ts 单一来源——列定义、UTF-8 BOM 防 Excel 乱码、
 * 逗号/引号/换行转义、公式注入防护(OWASP)完全一致。
 */

export function csvEscape(v: string | number): string {
  let s = String(v);
  // 公式注入防护(P1-8):= + - @ 开头的单元格在 Excel/WPS 打开时会被当公式执行,
  // 备注等字段可来自外部导入的任意文本 —— 统一前置单引号 neutralize
  if (/^[=+\-@\t\r]/.test(s)) s = `'` + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function buildCsv(headers: string[], rows: Array<Array<string | number>>): string {
  const lines = [headers, ...rows].map((r) => r.map(csvEscape).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/** 文件命名规范(PRD 流程 F):LedgerOne_{账本名}_{起始日期}_{结束日期}.{ext} */
export function exportFileName(ledgerName: string, startMs: number, endMs: number, ext = 'csv'): string {
  const d = (ms: number) => {
    const x = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${x.getFullYear()}${p(x.getMonth() + 1)}${p(x.getDate())}`;
  };
  return `LedgerOne_${ledgerName}_${d(startMs)}_${d(endMs)}.${ext}`;
}
