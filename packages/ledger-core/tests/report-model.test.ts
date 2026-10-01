/** 报表编排单测(第 30 轮):总览聚合/kind 过滤/占比归集/趋势桶/预测基线 */
import { describe, expect, it } from 'vitest';
import { buildReportModel, trendBuckets, periodRange } from '../src/report';
import type { CategoryRow, TransactionRow } from '@ledgerone/domain';

const DAY = 86_400_000;
const NOW = new Date(2026, 2, 15, 12).getTime(); // 2026-03-15 12:00 本地

function cat(id: string, parent: string | null): CategoryRow {
  return { id, ledger_id: 'l1', parent_id: parent, name: id === 'c1' ? '餐饮' : id === 'c2' ? '早餐' : '购物', kind: 'expense', icon: '📦', color: null, sort: 0, is_hidden: false, is_preset: true, client_version: 1, server_version: 1, is_deleted: false, deleted_at: null, created_at: 1, updated_at: 1 };
}

function tx(id: string, o: Partial<TransactionRow>): TransactionRow {
  return { id, ledger_id: 'l1', user_id: 'u1', member_id: null, type: 'expense', amount: '10.00', currency: 'CNY', amount_base: '10.00', exchange_rate: null, category_id: 'c1', account_id: 'a1', to_account_id: null, happened_at: NOW - DAY, note: '', is_refunded: false, refund_of_id: null, reimburse_status: null, exclude_from_budget: false, attachment_count: 0, source: 'manual', client_version: 1, server_version: 1, is_deleted: false, deleted_at: null, created_at: 1, updated_at: 1, ...o };
}

const cats = [cat('c1', null), cat('c2', 'c1'), cat('c3', null)];

describe('buildReportModel(P1-1 报表下沉)', () => {
  it('总览聚合:income/expense 分计、结余正确;转账不计入', () => {
    const rows = [
      tx('1', { type: 'expense', amount_base: '30.00', happened_at: NOW }),
      tx('2', { type: 'income', amount_base: '100.00', happened_at: NOW }),
      tx('3', { type: 'transfer', amount_base: '999.00', happened_at: NOW }),
    ];
    const m = buildReportModel({ rows, allExpenses: rows, cats, kind: 'expense', period: 'month', now: NOW });
    expect(Number(m.expense)).toBe(30);
    expect(Number(m.income)).toBe(100);
  });

  it('kind 过滤:占比只统计所选 kind;一级/二级归集正确', () => {
    const rows = [
      tx('1', { type: 'expense', amount_base: '20.00', category_id: 'c2' }), // 二级→归集到 c1
      tx('2', { type: 'expense', amount_base: '10.00', category_id: 'c1' }), // 一级直挂
      tx('3', { type: 'income', amount_base: '500.00', category_id: 'c3' }), // income 不进 expense 占比
    ];
    const m = buildReportModel({ rows, allExpenses: rows, cats, kind: 'expense', period: 'month', now: NOW });
    const top = m.byTop.get('c1');
    expect(Number(top!.amount)).toBe(30);
    expect(top!.count).toBe(2); // 二级 c2 20 + 一级 c1 10
    expect(Number(m.byCat.get("c2")!.amount)).toBe(20);
    expect(m.byCat.get("c2")!.count).toBe(1);
  });

  it('软删与转账行被排除在占比之外', () => {
    const rows = [
      tx('1', { amount_base: '10.00', category_id: 'c1' }),
      tx('2', { amount_base: '40.00', category_id: 'c1', is_deleted: true }),
      tx('3', { amount_base: '60.00', category_id: 'c1', type: 'transfer' }),
    ];
    const m = buildReportModel({ rows, allExpenses: rows, cats, kind: 'expense', period: 'month', now: NOW });
    expect(Number(m.byTop.get("c1")!.amount)).toBe(10);
    expect(m.byTop.get("c1")!.count).toBe(1);
  });

  it('趋势桶:金额按桶聚合且当前桶高亮', () => {
    const rows = [tx('1', { amount_base: '7.00', happened_at: NOW })];
    const m = buildReportModel({ rows, allExpenses: rows, cats, kind: 'expense', period: 'month', now: NOW });
    const cur = m.buckets.find((b) => b.isCurrent);
    expect(cur).toBeTruthy();
    expect(Number(cur!.amount)).toBe(7);
    expect(m.buckets.reduce((acc, b) => acc + Number(b.amount), 0)).toBe(7);
  });

  it('预测基线:monthUsed 只计当月(allExpenses 含跨月数据)', () => {
    const lastMonth = NOW - 40 * DAY;
    const rows = [
      tx('1', { amount_base: '50.00', happened_at: NOW }),
      tx('2', { amount_base: '500.00', happened_at: lastMonth }),
    ];
    const m = buildReportModel({ rows, allExpenses: rows, cats, kind: 'expense', period: 'month', now: NOW });
    expect(Number(m.monthUsed)).toBe(50);
  });

  it('periodRange/trendBuckets 从 web 下沉后语义不变(周一起始/月末天数)', () => {
    const wk = periodRange('week', new Date(2026, 2, 18)); // 2026-03-18 周三
    expect(new Date(wk.start).getDay()).toBe(1); // 周一
    expect(trendBuckets('month', new Date(2026, 1, 10))).toHaveLength(28); // 2 月 28 天(2026 非闰)
  });
});
