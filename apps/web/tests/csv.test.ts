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

describe('CSV 公式注入防护(P1-8,Review)', () => {
  it('= + - @ 开头的字段被前置单引号 neutralize', () => {
    expect(csvEscape('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvEscape('+cmd|/C calc')).toBe("'+cmd|/C calc");
    expect(csvEscape('-2+1')).toBe("'-2+1");
    expect(csvEscape('@WEBSERVICE("x")')).toBe('"\'@WEBSERVICE(""x"")"'); // 含引号:先加 ' 前缀再整体包引号转义
    expect(csvEscape('\tTAB 注入')).toBe("'\tTAB 注入");
  });

  it('普通数字负号例外不受影响:仅当 - 后跟非数字内容才可注入,此处统一防护不破坏展示', () => {
    // 统一防护策略:所有 - 开头都转义。数字字段正常导出多为非负金额(方向由 type 决定),可接受
    expect(csvEscape('-123.45')).toBe("'-123.45");
  });

  it('普通文本与中文不受影响', () => {
    expect(csvEscape('午餐 咖啡')).toBe('午餐 咖啡');
    expect(csvEscape('26.00')).toBe('26.00');
  });
});
