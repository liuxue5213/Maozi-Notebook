import { isDue, newId, nextOccurrence, type RecurringRuleRow, type TransactionRow } from '@ledgerone/domain';
import { db } from './db/db';
import { enqueue } from './sync/wiring';

/**
 * 周期记账到期生成(M01-F06):扫描未暂停且到期的规则,逐期生成流水并推进 next_run_at。
 * 幂等性:流水用客户端 UUID + upsert,重复触发不会产生重复数据(PRD 5.2 recurring_rule 约束)。
 * 补生成:规则落后多期时循环追平(guard 防死循环,最多追 400 期)。
 */
export async function runDueRecurring(now = Date.now()): Promise<number> {
  const rules = (await db.recurring_rules.toArray()).filter((r) => !r.is_deleted);
  const cats = await db.categories.toArray();
  const accounts = await db.accounts.toArray();
  let generated = 0;
  for (let i = 0; i < rules.length; i++) {
    let cur: RecurringRuleRow = rules[i];
    let guard = 0;
    while (isDue(cur, now) && guard < 400) {
      const cat = cur.category_id ? cats.find((c) => c.id === cur.category_id) : undefined;
      const type = cat?.kind === 'income' ? 'income' : 'expense';
      const at = cur.next_run_at;
      const t: TransactionRow = {
        id: newId(),
        ledger_id: cur.ledger_id,
        user_id: 'local',
        member_id: null,
        type,
        amount: cur.amount,
        currency: 'CNY',
        amount_base: cur.amount,
        exchange_rate: null,
        category_id: cur.category_id ?? null,
        account_id: accounts.some((a) => a.id === cur.account_id) ? cur.account_id : accounts[0]?.id ?? cur.account_id,
        to_account_id: null,
        happened_at: at,
        note: cur.note ?? '周期记账',
        is_refunded: false,
        refund_of_id: null,
        reimburse_status: null,
        exclude_from_budget: false,
        attachment_count: 0,
        source: 'recurring',
        client_version: 1,
        server_version: null,
        is_deleted: false,
        deleted_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      await db.transactions.put(t);
      enqueue('transaction', t as unknown as Record<string, unknown>);
      const nextAt = nextOccurrence(cur.frequency, cur.interval, cur.next_run_at);
      cur = {
        ...cur,
        last_run_at: cur.next_run_at,
        next_run_at: nextAt,
        client_version: cur.client_version + 1,
        updated_at: Date.now(),
      };
      await db.recurring_rules.put(cur);
      enqueue('recurring_rule', cur as unknown as Record<string, unknown>);
      generated++;
      guard++;
    }
  }
  return generated;
}
