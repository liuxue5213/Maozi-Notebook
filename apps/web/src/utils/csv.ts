/** CSV 生成已下沉 @ledgerone/domain(T-23 双端共享):本文件再导出 + 保留 Web 专属的 downloadText */
export { csvEscape, buildCsv, exportFileName } from '@ledgerone/domain';

/** 浏览器下载(DOM 专属,不进 domain) */
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
