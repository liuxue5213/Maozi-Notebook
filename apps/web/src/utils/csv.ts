/** CSV 生成与下载(M08-F01):UTF-8 BOM 防 Excel 乱码,字段含逗号/引号/换行时加引号转义 */
export function csvEscape(v: string | number): string {
  const s = String(v);
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

export function downloadText(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
