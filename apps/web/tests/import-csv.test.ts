import { describe, expect, it } from 'vitest';
import { defaultMapping, detectSource, parseCsv, splitCsvLine } from '../src/utils/import-csv';

const ALIPAY_CSV = `支付宝交易记录明细查询
账号:xxx@example.com
起始日期:2026-09-01
----------------------------------------
交易时间,交易分类,交易对方,商品说明,收/支,金额
2026-09-20 14:30:05,餐饮美食,星巴克,拿铁,支出,26.00
2026-09-21 09:00:00,转账红包,张三,转账,收入,100.00
无效行`;

describe('CSV 解析(M05-F01)', () => {
  it('splitCsvLine 处理引号与转义', () => {
    expect(splitCsvLine('a,"b,c","d""e"')).toEqual(['a', 'b,c', 'd"e']);
  });

  it('识别支付宝来源并用预设映射解析', () => {
    const source = detectSource(ALIPAY_CSV);
    expect(source).toBe('alipay');
    const headers = splitCsvLine(ALIPAY_CSV.split('\n')[4]);
    const mapping = defaultMapping(source, headers);
    const r = parseCsv(ALIPAY_CSV, mapping);
    expect(r.rows).toHaveLength(2);
    expect(r.skipped).toBe(1);
    expect(r.rows[0]).toMatchObject({ amount: '26.00', isExpense: true, merchant: '星巴克', note: '拿铁' });
    expect(r.rows[1].isExpense).toBe(false);
    expect(new Date(r.rows[0].happenedAt).getMonth()).toBe(8);
  });

  it('通用来源按表头语义猜列', () => {
    const csv = `Date,Merchant,Type,Amount,Memo\n2026-09-22 10:00,便利店,支出,12.5,水\n`;
    const mapping = defaultMapping('generic', splitCsvLine(csv.split('\n')[0]));
    const r = parseCsv(csv, mapping);
    expect(r.rows[0]).toMatchObject({ amount: '12.50', merchant: '便利店', note: '水' });
  });

  it('金额含千分位与货币符号', () => {
    const csv = `时间,金额\n2026-09-22 10:00,"¥1,234.56"\n`;
    const mapping = defaultMapping('generic', splitCsvLine(csv.split('\n')[0]));
    const r = parseCsv(csv, mapping);
    expect(r.rows[0].amount).toBe('1234.56');
  });

  it('无法解析的日期回退为当前时间且不丢行', () => {
    const csv = `时间,金额\n日期不详,10\n`;
    const mapping = defaultMapping('generic', splitCsvLine(csv.split('\n')[0]));
    const r = parseCsv(csv, mapping);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].happenedAt).toBeGreaterThan(0);
  });
});
