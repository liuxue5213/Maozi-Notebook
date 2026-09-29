import { isDue, nextOccurrence, type RecurringRuleRow, type TransactionRow } from '@ledgerone/domain';
import { db } from './db/db';
import { enqueue } from './sync/wiring';
import { getBaseCurrency } from './sync/api';

/**
 * 周期记账到期生成(M01-F06):扫描未暂停且到期的规则,逐期生成流水并推进 next_run_at。
 * 幂等性(第 19 轮 P0-2 修复):流水 id 确定性派生 `rc_<规则id>_<到期时刻>`,重复触发
 * (启动 + 手动 + 多标签页)只会覆盖同一行而非新增;流水与规则推进置于同一 Dexie 事务。
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
        id: `rc_${cur.id}_${at}`,
        ledger_id: cur.ledger_id,
        user_id: 'local',
        member_id: null,
        type,
        amount: cur.amount,
        currency: getBaseCurrency(), // 主币种即记账币种(M16/第 16 轮)
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
      // 同一 Dexie 事务:流水落库、规则推进与两次入队要么全部生效要么全部回滚(修复前两个 put 分离)
      await db.transaction('rw', db.transactions, db.recurring_rules, db.outbox, async () => {
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
      });
      generated++;
      guard++;
    }
  }
  return generated;
}
