import { describe, expect, it } from 'vitest';
import { buildCsv, csvEscape, exportFileName } from '../src/csv';

describe('buildCsv(T-23 双端共享)', () => {
  it('UTF-8 BOM 开头,CRLF 行尾', () => {
    const csv = buildCsv(['a', 'b'], [['1', '2']]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('\r\n');
  });

  it('含逗号/引号/换行的字段加引号转义', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('plain')).toBe('plain');
  });

  it('公式注入防护:= + - @ 开头前置单引号(OWASP CSV Injection)', () => {
    expect(csvEscape('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvEscape('+1+1')).toBe("'+1+1");
    expect(csvEscape('-1')).toBe("'-1");
    expect(csvEscape('@cmd')).toBe("'@cmd");
    // 数字经 String() 后同样按前缀转义(与 Web 行为一致;负数余额会显示为文本,金额恒为正故无实际影响)
    expect(csvEscape(-1)).toBe("'-1");
  });

  it('行拼接与列数对齐', () => {
    const csv = buildCsv(['h1', 'h2'], [['r1c1', 'r1c2'], ['r2c1', 'r2c2']]);
    expect(csv).toBe('\uFEFFh1,h2\r\nr1c1,r1c2\r\nr2c1,r2c2\r\n');
  });

  it('exportFileName 命名规范:LedgerOne_{账本}_{起}_{止}.csv', () => {
    const start = new Date('2026-10-01T00:00:00').getTime();
    const end = new Date('2026-10-31T00:00:00').getTime();
    expect(exportFileName('主账本', start, end)).toBe('LedgerOne_主账本_20261001_20261031.csv');
    expect(exportFileName('主账本', start, end, 'txt')).toBe('LedgerOne_主账本_20261001_20261031.txt');
  });
});
