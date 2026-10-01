import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import type { TransactionRow } from '@ledgerone/domain';

it('报表预测只读取当前账本及近三月支出', async () => {
  const { db } = await import('../src/db/db');
  const { loadReportModel } = await import('../src/utils/report-data');
  const now = new Date(2026, 5, 15).getTime();
  const tx = (id: string, ledger_id: string, amount: string, happened_at: number): TransactionRow => ({
    id, ledger_id, user_id: 'u1', member_id: null, type: 'expense', amount, currency: 'CNY', amount_base: amount,
    exchange_rate: null, category_id: null, account_id: 'a1', to_account_id: null, happened_at, note: '',
    is_refunded: false, refund_of_id: null, reimburse_status: null, exclude_from_budget: false,
    attachment_count: 0, source: 'manual', client_version: 1, server_version: null, is_deleted: false,
    deleted_at: null, created_at: now, updated_at: now,
  });
  await db.meta.put({ key: 'active_ledger', value: 'l1' });
  await db.transactions.bulkPut([
    tx('current', 'l1', '10.0000', now),
    tx('other-ledger', 'l2', '999.0000', now),
    tx('old', 'l1', '500.0000', new Date(2025, 0, 1).getTime()),
  ]);
  const model = await loadReportModel('month', 'expense', now);
  expect(model.expense).toBe('10');
  expect(model.monthUsed).toBe('10');
  expect(model.rows.map((row) => row.id)).toEqual(['current']);
});
