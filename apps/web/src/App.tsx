import { cur } from './utils/currency';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { addAmount, billingCycleRange, daysUntilDue, subAmount } from '@ledgerone/domain';
import { engine } from './sync/wiring';
import { isLoggedIn } from './sync/api';
import { db } from './db/db';
import { QuickAdd } from './quickadd';
import { TodayCard, TransactionList } from './lists';
import { Reports } from './reports';
import { BudgetCard } from './budget';
import { AuthModal, MeTab } from './auth';
import { WriteErrorToast } from './WriteErrorToast';
import { startDesktopNotifyLoop } from './notify';
import { DialogHost } from './ui/dialog';
import { SyncAuditBanner } from './SyncAuditBanner';

type Tab = 'record' | 'list' | 'report' | 'me';

const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: 'record', label: '记账', icon: '✏️' },
  { key: 'list', label: '明细', icon: '📋' },
  { key: 'report', label: '报表', icon: '📊' },
  { key: 'me', label: '我的', icon: '👤' },
];

function useSyncStatus() {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot);
}

const BANNER_KEY = 'lo_credit_banner_date';

/** 信用卡还款提醒横幅(M09-F06):有本期账单且 3 天内到期(含逾期)时在首页提醒,当日可关闭 */
function useCreditAlert() {
  const alert = useLiveQuery(async () => {
    const cards = (await db.accounts.toArray()).filter((a) => a.type === 'credit_card' && !a.is_archived && a.credit_due_day != null);
    const txs = await db.transactions.toArray();
    const now = new Date();
    for (const a of cards) {
      const { start } = billingCycleRange(a.credit_bill_day ?? 1, now);
      const onCard = txs.filter((t) => !t.is_deleted && t.happened_at >= start && (t.account_id === a.id || t.to_account_id === a.id));
      const spend = onCard.filter((t) => t.type === 'expense').reduce((acc, t) => addAmount(acc, t.amount_base), '0');
      const repaid = onCard.filter((t) => t.type === 'transfer' && t.to_account_id === a.id).reduce((acc, t) => addAmount(acc, t.amount_base), '0');
      const bill = subAmount(spend, repaid);
      const dueIn = daysUntilDue(a.credit_due_day!, now);
      if (Number(bill) > 0 && dueIn <= 3) {
        return { name: a.name, bill, dueIn };
      }
    }
    return null;
  }, []);
  const dismissedOn = typeof localStorage !== 'undefined' ? localStorage.getItem(BANNER_KEY) : null;
  const today = new Date().toDateString();
  return alert && dismissedOn !== today ? alert : null;
}

function CreditBanner() {
  const alert = useCreditAlert();
  const [hidden, setHidden] = useState(false);
  if (!alert || hidden) return null;
  return (
    <div className="credit-banner">
      <span>
        💳 {alert.name} 本期账单 {cur()}{Number(alert.bill).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}
        {alert.dueIn > 0 ? `,${alert.dueIn} 天后还款` : alert.dueIn === 0 ? ',今天还款日' : ',已过还款日'}
      </span>
      <button
        className="mini"
        onClick={() => {
          localStorage.setItem(BANNER_KEY, new Date().toDateString());
          setHidden(true);
        }}
      >
        知道了
      </button>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>('record');
  const [authOpen, setAuthOpen] = useState(false);
  const [authEpoch, setAuthEpoch] = useState(0); // 登录/登出后触发重渲染
  const sync = useSyncStatus();
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  // N2 轻量版:已授权桌面通知时启动预算超支/还款到期检查循环
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') startDesktopNotifyLoop();
  }, []);

  // navigator.onLine 非响应式:监听 online/offline 事件驱动重渲染
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const badge = (() => {
    if (sync.state === 'syncing') return '同步中…';
    if (sync.pending > 0) return `待同步 ${sync.pending} 条`;
    if (sync.state === 'error') return '同步失败 · 重试';
    if (!isLoggedIn()) return '未登录';
    return sync.lastSyncAt ? '已同步' : '已登录';
  })();

  return (
    <div className="app">
      <header className="topbar">
        <div className="title">帽子记账本</div>
        <button className="sync-badge" data-state={sync.state} onClick={() => void engine.syncOnce()}>
          {badge}
        </button>
      </header>
      {!online && <div className="banner">离线模式 · 待同步 {sync.pending} 条</div>}
      {tab === 'record' && <CreditBanner />}
      <main className="content">
        {tab === 'record' && (
          <>
            <TodayCard />
            <BudgetCard />
            <QuickAdd onNeedAuth={() => setAuthOpen(true)} />
          </>
        )}
        {tab === 'list' && <TransactionList />}
        {tab === 'report' && <Reports />}
        {tab === 'me' && <MeTab key={authEpoch} onOpenAuth={() => setAuthOpen(true)} onAuthChanged={() => setAuthEpoch((e) => e + 1)} />}
      </main>
      <nav className="tabbar">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
            <span className="tab-icon">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
      {authOpen && (
        <AuthModal
          onClose={() => setAuthOpen(false)}
          onAuthed={() => {
            setAuthEpoch((e) => e + 1);
            setAuthOpen(false);
          }}
        />
      )}
      <WriteErrorToast />
      <SyncAuditBanner />
      <DialogHost />
    </div>
  );
}
