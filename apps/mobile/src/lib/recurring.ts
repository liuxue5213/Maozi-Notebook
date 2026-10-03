/** 循环记账引擎(SQLite 版,移植 web recurring-engine):到期规则逐期生成流水并推进 next_run_at。
 *  幂等:流水 id 确定性派生 rc_<规则id>_<到期时刻>,重复触发覆盖同一行而非新增。 */
import { isDue, nextOccurrence, type RecurringFrequency } from '@ledgerone/domain';
import { db } from './db';
import { saveLocal } from '@ledgerone/sqlite-sync';

interface RuleRow {
  id: string; ledger_id: string; amount: string; category_id: string | null;
  account_id: string; note: string | null; frequency: RecurringFrequency;
  interval: number; next_run_at: number; paused: number; last_run_at: number | null;
  client_version: number; server_version: number | null; is_deleted: number; deleted_at: number | null;
  created_at: number; updated_at: number;
}

export async function runDueRecurring(now = Date.now()): Promise<number> {
  const rules = await db.getAllAsync<RuleRow>('SELECT * FROM recurring_rules WHERE is_deleted = 0');
  let generated = 0;
  for (let i = 0; i < rules.length; i++) {
    let cur = rules[i];
    let guard = 0;
    while (cur.paused === 0 && cur.next_run_at <= now && guard < 400) {
      const kind = await db.getAllAsync<{ kind: string }>(
        'SELECT kind FROM categories WHERE id = ?', [cur.category_id ?? '']);
      const type = kind[0]?.kind === 'income' ? 'income' : 'expense';
      const at = cur.next_run_at;
      const tx = {
        id: `rc_${cur.id}_${at}`, ledger_id: cur.ledger_id, user_id: 'local', member_id: null,
        type, amount: cur.amount, currency: 'CNY', amount_base: cur.amount, exchange_rate: null,
        category_id: cur.category_id ?? null, account_id: cur.account_id, to_account_id: null,
        happened_at: at, note: cur.note ?? '周期记账', is_refunded: 0, refund_of_id: null,
        reimburse_status: null, exclude_from_budget: 0, attachment_count: 0, source: 'recurring',
        client_version: 1, server_version: null, is_deleted: 0, deleted_at: null,
        created_at: Date.now(), updated_at: Date.now(),
      };
      await saveLocal(db, 'transaction', tx as never);
      cur = {
        ...cur,
        last_run_at: cur.next_run_at,
        next_run_at: nextOccurrence(cur.frequency, cur.interval, cur.next_run_at),
        client_version: cur.client_version + 1,
        updated_at: Date.now(),
      };
      await saveLocal(db, 'recurring_rule', cur as never);
      generated++;
      guard++;
    }
  }
  return generated;
}
