import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { initDb, getActiveLedgerId, db } from './store';

/**
 * N2 移动端本地通知(2026-10-11):预算超支 / 信用卡还款 3 天内到期 / 每月 1 日备份提醒。
 * 纯本地调度(无推送服务依赖),App 运行中触发,同键当日去重;开关持久化 SecureStore。
 */

const AI_KEY = 'priv_ai';
const NOTIFY_KEY = 'priv_notify';

export async function isNotifyEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(NOTIFY_KEY)) !== '0';
}

export async function setNotifyEnabled(on: boolean): Promise<void> {
  if (on) {
    const settings = await Notifications.getPermissionsAsync();
    if (!settings.granted) {
      const req = await Notifications.requestPermissionsAsync();
      if (!req.granted) throw new Error('通知权限被拒绝,可在系统设置中重新开启');
    }
    await SecureStore.setItemAsync(NOTIFY_KEY, '1');
  } else {
    await SecureStore.setItemAsync(NOTIFY_KEY, '0');
  }
}

export async function isAiEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(AI_KEY)) !== '0';
}

export async function setAiEnabled(on: boolean): Promise<void> {
  if (on) await SecureStore.deleteItemAsync(AI_KEY);
  else await SecureStore.setItemAsync(AI_KEY, '0');
}

const DAY_KEY_PREFIX = 'notified_';

function alreadyNotifiedToday(key: string): boolean {
  // 内存级即可:App 生命周期内同日只发一次;重启后大不了再提醒一次,无害
  return ((globalThis as unknown as Record<string, Record<string, boolean>>).__notified)?.[key] === true;
}

function markNotified(key: string): void {
  const g = globalThis as unknown as Record<string, Record<string, boolean>>;
  g.__notified = g.__notified ?? {};
  g.__notified[key] = true;
}

let scheduled = false;

/** App 前台时调用(幂等):注册通知处理器并做一次检查 */
export async function startNotifyLoop(): Promise<void> {
  if (scheduled) return;
  scheduled = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
  await checkOnce();
}

/** 单次检查:预算超支 / 信用卡还款 3 天内 / 月初备份 */
export async function checkOnce(): Promise<void> {
  if (!(await isNotifyEnabled())) return;
  await initDb();
  const ledgerId = await getActiveLedgerId();
  if (!ledgerId) return;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  // 预算超支(>=100%)
  const budgets = await db.getAllAsync<{ id: string; total_amount: string; name: string }>(
    'SELECT id, total_amount, name FROM budgets WHERE is_deleted = 0 AND ledger_id = ? ORDER BY period_start DESC LIMIT 1', [ledgerId]);
  const budget = budgets[0];
  if (budget) {
    const txs = await db.getAllAsync<{ amount_base: string }>(
      'SELECT amount_base FROM transactions WHERE is_deleted = 0 AND ledger_id = ? AND type = ? AND exclude_from_budget = 0 AND happened_at >= ?',
      [ledgerId, 'expense', monthStart]);
    const spent = txs.reduce((s, t) => s + Number(t.amount_base), 0);
    const total = Number(budget.total_amount);
    if (total > 0 && spent >= total) {
      await fire('budget-overspend', '预算超支',
        `本月已支出 ¥${spent.toFixed(2)},超出预算 ¥${total.toFixed(2)}`);
    }
  }

  // 信用卡还款 3 天内到期
  const cards = await db.getAllAsync<{ id: string; name: string; credit_due_day: number }>(
    'SELECT id, name, credit_due_day FROM accounts WHERE is_deleted = 0 AND ledger_id = ? AND type = ? AND is_archived = 0 AND credit_due_day IS NOT NULL',
    [ledgerId, 'credit_card']);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (const c of cards) {
    const y = now.getFullYear(), m = now.getMonth();
    let due = new Date(y, m, c.credit_due_day).getTime();
    if (due < todayStart) due = new Date(y, m + 1, c.credit_due_day).getTime();
    const days = Math.round((due - todayStart) / 86_400_000);
    if (days >= 0 && days <= 3) {
      await fire(`credit-due-${c.id}`, '还款提醒', `「${c.name}」还款日还剩 ${days} 天${days === 0 ? '(就是今天)' : ''}`);
    }
  }

  // 月初备份提醒
  if (now.getDate() === 1) {
    await fire('backup-reminder', '月初备份提醒', '建议到「导出与备份」导出一份 CSV 存档——数据无价,备份无忧');
  }
}

async function fire(key: string, title: string, body: string): Promise<void> {
  if (alreadyNotifiedToday(key)) return;
  markNotified(key);
  await Notifications.scheduleNotificationAsync({
    content: { title, body, sound: true },
    trigger: null, // 立即弹出
  });
}
