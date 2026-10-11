import { db } from './db/db';
import { getActiveLedgerId } from './db/seed';
import { billingCycleRange, daysUntilDue } from '@ledgerone/domain';

/**
 * N2 轻量版(Q6/Q4 拍板):Web 桌面通知——预算超支 + 信用卡 3 天内还款到期。
 * 触发时机:登录后启动一次 + 每 5 分钟随自动同步检查;同键当日去重,不轰炸。
 * 移动端 expo-notifications 待原生构建通道确认后另行落地。
 */

const NOTIFIED_KEY = 'lo_notified'; // { [键]: 'YYYY-MM-DD' }
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

function alreadyNotifiedToday(key: string): boolean {
  try {
    const map = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? '{}') as Record<string, string>;
    return map[key] === new Date().toISOString().slice(0, 10);
  } catch {
    return false;
  }
}

function markNotified(key: string): void {
  try {
    const map = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? '{}') as Record<string, string>;
    // 只保留当天,防无限增长
    const today = new Date().toISOString().slice(0, 10);
    for (const k of Object.keys(map)) if (map[k] !== today) delete map[k];
    map[key] = today;
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(map));
  } catch { /* 存储满等异常静默 */ }
}

function notify(key: string, title: string, body: string): void {
  if (alreadyNotifiedToday(key)) return;
  markNotified(key);
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body, tag: key });
    }
  } catch { /* 通知失败静默,不影响主流程 */ }
}

async function checkBudgetAndCredit(): Promise<void> {
  if (typeof document === 'undefined' || document.hidden) return; // 后台不发
  const ledgerId = await getActiveLedgerId();
  if (!ledgerId) return;
  const [accounts, txs, budgets] = await Promise.all([
    db.accounts.toArray(),
    db.transactions.toArray(),
    db.budgets.toArray(),
  ]);
  const liveTxs = txs.filter((t) => !t.is_deleted);
  const ledgerAccIds = new Set(accounts.filter((a) => a.ledger_id === ledgerId).map((a) => a.id));

  // 1) 预算超支(>=100%)
  const budget = budgets.find((b) => b.ledger_id === ledgerId && !b.is_deleted);
  if (budget) {
    const items = (await db.budget_items.toArray()).filter((i) => i.budget_id === budget.id && !i.is_deleted);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    const spent = liveTxs
      .filter((t) => t.ledger_id === ledgerId && t.type === 'expense' && !t.exclude_from_budget && t.happened_at >= monthStart)
      .reduce((s, t) => s + Number(t.amount_base), 0);
    const total = Number(budget.total_amount);
    if (total > 0 && spent >= total) {
      notify(`budget-overspend-${ledgerId}`, '帽子记账本 · 预算超支',
        `本月已支出 ¥${spent.toFixed(2)},超出预算 ¥${total.toFixed(2)}——管住手,看看哪些还能省`);
    }
    void items; // 分类级细粒度提醒留待 O7 一并做
  }

  // 2) 信用卡还款 3 天内到期
  const today = new Date();
  for (const a of accounts) {
    if (a.is_archived || a.type !== 'credit_card' || !ledgerAccIds.has(a.id)) continue;
    const cycle = billingCycleRange(Number(a.credit_bill_day ?? 1), new Date(today.getTime()));
    const days = daysUntilDue(Number(a.credit_due_day ?? 0), new Date(today.getTime()));
    if (Number(a.credit_due_day) > 0 && days <= 3 && cycle) {
      notify(`credit-due-${a.id}`, '帽子记账本 · 还款提醒',
        `「${a.name}」还款日还剩 ${days} 天${days === 0 ? '(就是今天)' : ''},别忘了还款`);
    }
  }

  // Q8: 每月 1 日备份提醒(同月去重)
  if (today.getDate() === 1) {
    notify('backup-reminder', '帽子记账本 · 月初备份提醒',
      '新的一月开始啦,建议到「导出与备份」导出一份 CSV 存档——数据无价,备份无忧');
  }
}

/** 启用桌面通知(用户点击触发,浏览器要求必须由手势发起授权) */
export async function enableDesktopNotify(): Promise<string> {
  if (typeof Notification === 'undefined') return '此浏览器不支持桌面通知';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return '通知权限被拒绝,可在浏览器设置中重新开启';
  startDesktopNotifyLoop(); // 审查修复:开启后立即挂载检查循环(原先需刷新页面才启动)
  await checkBudgetAndCredit();
  return '桌面提醒已开启';
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startDesktopNotifyLoop(): void {
  if (timer || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  void checkBudgetAndCredit();
  timer = setInterval(() => void checkBudgetAndCredit(), CHECK_INTERVAL_MS);
}
