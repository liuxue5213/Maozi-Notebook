import { buildReportModel, periodRange, type PeriodKind } from '@ledgerone/ledger-core';
import { db } from '../db/db';
import { getActiveLedgerId } from '../db/seed';

export async function loadReportModel(period: PeriodKind, kind: 'expense' | 'income', now = Date.now()) {
  const { start, end } = periodRange(period, new Date(now));
  const ledgerId = await getActiveLedgerId();
  const rows = (await db.transactions.where('[ledger_id+happened_at]').between([ledgerId, start], [ledgerId, end], true, false).toArray())
    .filter((r) => !r.is_deleted && r.type !== 'transfer');
  const cats = await db.categories.where('ledger_id').equals(ledgerId).toArray();
  const month = periodRange('month', new Date(now));
  const date = new Date(month.start);
  const historyStart = new Date(date.getFullYear(), date.getMonth() - 3, 1).getTime();
  const allExpenses = (await db.transactions.where('[ledger_id+happened_at]').between([ledgerId, historyStart], [ledgerId, month.end], true, false).toArray())
    .filter((r) => !r.is_deleted && r.type === 'expense');
  const core = buildReportModel({ rows, allExpenses, cats, kind, period, now });
  return { ...core, cats };
}
