import { describe, expect, it } from 'vitest';
import { buildCsv, csvEscape, exportFileName } from '../src/utils/csv';

describe('CSV 工具(M08-F01)', () => {
  it('普通字段直出', () => {
    expect(csvEscape('餐饮')).toBe('餐饮');
    expect(csvEscape(26)).toBe('26');
  });

  it('逗号/引号/换行加引号并转义', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('说"你好"')).toBe('"说""你好"""');
    expect(csvEscape('行1\n行2')).toBe('"行1\n行2"');
  });

  it('带 BOM 与 CRLF', () => {
    const csv = buildCsv(['时间', '金额'], [['2026-09-26', '26']]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('时间,金额\r\n2026-09-26,26\r\n');
  });

  it('文件名规范:LedgerOne_{账本名}_{起}_{止}.csv(PRD 流程 F)', () => {
    expect(exportFileName('我的账本', new Date(2026, 8, 1).getTime(), new Date(2026, 8, 26).getTime()))
      .toBe('LedgerOne_我的账本_20260901_20260926.csv');
  });
});
