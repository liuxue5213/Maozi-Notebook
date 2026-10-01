import { newId, type TransactionRow } from '@ledgerone/domain';
import { db } from './db';
import { getActiveLedgerId } from './seed';
import { saveLocal } from '../sync/wiring';

/** 确定性伪随机(演示数据可复现) */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成近 75 天演示流水(仅本地,不进同步队列);控制台调用 window.__ledgerone.seedDemoData() */
export async function seedDemoData(): Promise<number> {
  const ledgerId = await getActiveLedgerId();
  if (!ledgerId) throw new Error('本地尚未播种,先刷新页面');
  const accounts = await db.accounts.toArray();
  const cats = (await db.categories.toArray()).filter((c) => !c.parent_id && !c.is_hidden);
  const expenseCats = cats.filter((c) => c.kind === 'expense');
  const incomeCats = cats.filter((c) => c.kind === 'income');
  if (!accounts.length || !expenseCats.length) throw new Error('缺少账户或分类');

  const rand = mulberry32(20260926);
  const now = Date.now();
  const mk = (partial: Partial<TransactionRow>): TransactionRow => ({
    id: newId(), ledger_id: ledgerId, user_id: 'local', member_id: null,
    type: 'expense', amount: '0', currency: 'CNY', amount_base: '0', exchange_rate: null,
    category_id: null, account_id: accounts[0].id, to_account_id: null, happened_at: 0,
    note: '', is_refunded: false, refund_of_id: null, reimburse_status: null,
    exclude_from_budget: false, attachment_count: 0, source: 'manual',
    client_version: 1, server_version: null, is_deleted: false, deleted_at: null,
    created_at: 0, updated_at: 0, ...partial,
  });

  const txs: TransactionRow[] = [];
  for (let day = 75; day >= 0; day--) {
    const d = new Date(now - day * 86400000);
    d.setHours(0, 0, 0, 0);
    const base = d.getTime();
    // 每月 10 号发工资
    if (d.getDate() === 10) {
      const incomeCat = incomeCats[0];
      txs.push(mk({
        type: 'income', amount: '12800', amount_base: '12800', category_id: incomeCat?.id ?? null,
        account_id: accounts[Math.min(1, accounts.length - 1)].id, happened_at: base + 10 * 3600000,
        note: '工资', created_at: base, updated_at: base,
      }));
    }
    const count = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) {
      const cat = expenseCats[Math.floor(rand() * expenseCats.length)];
      const amount = (3 + rand() * 160).toFixed(2);
      const at = base + (8 + Math.floor(rand() * 13)) * 3600000 + Math.floor(rand() * 60) * 60000;
      txs.push(mk({
        amount, amount_base: amount, category_id: cat.id,
        account_id: accounts[rand() < 0.6 ? 0 : Math.min(1, accounts.length - 1)].id,
        happened_at: at, note: '', created_at: at, updated_at: at,
      }));
    }
  }
  // 演示数据同样走 outbox:保证「离线记账 → 登录」全链路与真实路径一致
  for (const t of txs) {
    await saveLocal('transaction', t as unknown as Record<string, unknown>);
  }
  return txs.length;
}
