import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { addAmount, formatAmount, subAmount, type CategoryRow, type TransactionRow } from '@ledgerone/domain';
import { db } from './db/db';
import { enqueue } from './sync/wiring';
import { TxEditor } from './txedit';
import { CalendarView } from './calendar';

function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function monthStart(t: number): number {
  const d = new Date(t);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function TodayCard() {
  const stats = useLiveQuery(async () => {
    const now = Date.now();
    const ds = dayStart(now);
    const ms = monthStart(now);
    const rows = (await db.transactions.where('happened_at').aboveOrEqual(ms).toArray()).filter((r) => !r.is_deleted);
    const sum = (pred: (r: TransactionRow) => boolean) =>
      rows.filter(pred).reduce((acc, r) => addAmount(acc, r.amount_base), '0');
    return {
      todayExpense: sum((r) => r.type === 'expense' && r.happened_at >= ds),
      todayIncome: sum((r) => r.type === 'income' && r.happened_at >= ds),
      monthExpense: sum((r) => r.type === 'expense'),
      monthIncome: sum((r) => r.type === 'income'),
    };
  });
  if (!stats) return null;
  return (
    <div className="today-card">
      <div className="today-row">
        <div>
          <div className="label">今日支出</div>
          <div className="num expense">¥{formatAmount(stats.todayExpense)}</div>
        </div>
        <div>
          <div className="label">今日收入</div>
          <div className="num income">¥{formatAmount(stats.todayIncome)}</div>
        </div>
      </div>
      <div className="month-row">
        本月结余 <span className={Number(subAmount(stats.monthIncome, stats.monthExpense)) >= 0 ? 'income' : 'expense'}>¥{formatAmount(subAmount(stats.monthIncome, stats.monthExpense))}</span>
        <span className="muted">(支 ¥{formatAmount(stats.monthExpense)} / 收 ¥{formatAmount(stats.monthIncome)})</span>
      </div>
    </div>
  );
}

interface DayGroup {
  key: number;
  label: string;
  expense: string;
  income: string;
  rows: TransactionRow[];
}

type TxDecorated = TransactionRow & { _cat?: { icon: string; name: string }; _acc?: { name: string } };

/** 组合筛选条件(M01-F13):关键词/金额区间/分类/账户/日期区间 */
export interface TxFilter {
  keyword: string;
  min: string;
  max: string;
  categoryId: string;
  accountId: string;
  from: string;
  to: string;
}

const EMPTY_FILTER: TxFilter = { keyword: '', min: '', max: '', categoryId: '', accountId: '', from: '', to: '' };

function activeFilterCount(f: TxFilter): number {
  return (['keyword', 'min', 'max', 'categoryId', 'accountId', 'from', 'to'] as const).filter((k) => f[k] !== '').length;
}

function applyFilter(rows: TransactionRow[], f: TxFilter, catMap: Map<string, CategoryRow>): TransactionRow[] {
  const fromTs = f.from ? new Date(`${f.from}T00:00:00`).getTime() : null;
  const toTs = f.to ? new Date(`${f.to}T00:00:00`).getTime() + 86_400_000 : null;
  return rows.filter((r) => {
    if (f.keyword) {
      const cat = r.category_id ? catMap.get(r.category_id)?.name ?? '' : '';
      const hay = `${r.note ?? ''} ${cat}`;
      if (!hay.includes(f.keyword.trim())) return false;
    }
    const amt = Number(r.amount);
    if (f.min !== '' && amt < Number(f.min)) return false;
    if (f.max !== '' && amt > Number(f.max)) return false;
    if (f.categoryId) {
      const c = r.category_id ? catMap.get(r.category_id) : undefined;
      if (!c || (c.id !== f.categoryId && c.parent_id !== f.categoryId)) return false;
    }
    if (f.accountId && r.account_id !== f.accountId && r.to_account_id !== f.accountId) return false;
    if (fromTs !== null && r.happened_at < fromTs) return false;
    if (toTs !== null && r.happened_at >= toTs) return false;
    return true;
  });
}

function FilterPanel({ filter, onChange, cats, accounts }: {
  filter: TxFilter;
  onChange: (f: TxFilter) => void;
  cats: CategoryRow[];
  accounts: Array<{ id: string; name: string }>;
}) {
  const tops = cats.filter((c) => !c.parent_id && !c.is_hidden);
  const set = (patch: Partial<TxFilter>) => onChange({ ...filter, ...patch });
  return (
    <div className="filter-panel">
      <div className="filter-grid">
        <div className="field">
          <label>关键词(备注/分类)</label>
          <input value={filter.keyword} onChange={(e) => set({ keyword: e.target.value })} placeholder="如 咖啡" />
        </div>
        <div className="filter-pair">
          <div className="field">
            <label>金额 ≥</label>
            <input value={filter.min} onChange={(e) => set({ min: e.target.value })} inputMode="decimal" placeholder="0" />
          </div>
          <div className="field">
            <label>金额 ≤</label>
            <input value={filter.max} onChange={(e) => set({ max: e.target.value })} inputMode="decimal" placeholder="∞" />
          </div>
        </div>
        <div className="field">
          <label>分类(含二级)</label>
          <select value={filter.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
            <option value="">全部分类</option>
            {tops.map((c) => (
              <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>账户</label>
          <select value={filter.accountId} onChange={(e) => set({ accountId: e.target.value })}>
            <option value="">全部账户</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
        <div className="filter-pair">
          <div className="field">
            <label>开始日期</label>
            <input type="date" value={filter.from} onChange={(e) => set({ from: e.target.value })} />
          </div>
          <div className="field">
            <label>结束日期</label>
            <input type="date" value={filter.to} onChange={(e) => set({ to: e.target.value })} />
          </div>
        </div>
      </div>
      <button className="chip" onClick={() => onChange(EMPTY_FILTER)}>清除全部筛选</button>
    </div>
  );
}

export function TransactionList() {
  const [editing, setEditing] = useState<TransactionRow | null>(null);
  const [view, setView] = useState<'active' | 'recycle' | 'calendar'>('active');
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<TxFilter>(EMPTY_FILTER);

  const activeData = useLiveQuery(async () => {
    const cats = await db.categories.toArray();
    const accounts = await db.accounts.toArray();
    const catMap = new Map(cats.map((c) => [c.id, c]));
    const accMap = new Map(accounts.map((a) => [a.id, a]));
    const all = (await db.transactions.orderBy('happened_at').reverse().limit(300).toArray()).filter((r) => !r.is_deleted);
    const rows = activeFilterCount(filter) > 0 ? applyFilter(all, filter, catMap) : all;
    const groups = new Map<number, DayGroup>();
    for (const r of rows) {
      const key = dayStart(r.happened_at);
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          label: new Date(key).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }),
          expense: '0',
          income: '0',
          rows: [],
        };
        groups.set(key, g);
      }
      if (r.type === 'expense') g.expense = addAmount(g.expense, r.amount_base);
      if (r.type === 'income') g.income = addAmount(g.income, r.amount_base);
      const d = r as TxDecorated;
      d._cat = catMap.get(r.category_id ?? '') ?? undefined;
      d._acc = accMap.get(r.account_id);
      g.rows.push(r);
    }
    return { groups: [...groups.values()], catMap, accounts, matched: rows.length, total: all.length };
  }, [filter]);

  const recycled = useLiveQuery(
    async () =>
      (await db.transactions.toArray())
        .filter((r) => r.is_deleted)
        .sort((a, b) => (b.deleted_at ?? 0) - (a.deleted_at ?? 0))
        .slice(0, 100),
  );

  const restore = async (r: TransactionRow) => {
    const updated: TransactionRow = {
      ...r,
      is_deleted: false,
      deleted_at: null,
      client_version: r.client_version + 1,
      updated_at: Date.now(),
    };
    await db.transactions.put(updated);
    enqueue('transaction', updated as unknown as Record<string, unknown>); // 回收站恢复(M01-F12)
  };

  const filterCount = activeFilterCount(filter);

  return (
    <div className="tx-list-wrap">
      <div className="list-toolbar">
        <button className={`chip ${view === 'active' ? 'selected' : ''}`} onClick={() => setView('active')}>流水</button>
        <button className={`chip ${view === 'calendar' ? 'selected' : ''}`} onClick={() => setView('calendar')}>📅 日历</button>
        <button className={`chip ${view === 'recycle' ? 'selected' : ''}`} onClick={() => setView('recycle')}>
          回收站{recycled?.length ? ` (${recycled.length})` : ''}
        </button>
        {view === 'active' && (
          <button
            className={`chip ${filterOpen || filterCount > 0 ? 'selected' : ''}`}
            onClick={() => setFilterOpen((v) => !v)}
          >
            🔍 筛选{filterCount > 0 ? ` (${filterCount})` : ''}
          </button>
        )}
        {view === 'active' && filterCount > 0 && activeData && (
          <span className="muted small" style={{ alignSelf: 'center' }}>{activeData.matched}/{activeData.total} 条</span>
        )}
      </div>

      {view === 'calendar' && <CalendarView />}

      {view === 'active' && filterOpen && activeData && (
        <FilterPanel filter={filter} onChange={setFilter} cats={activeData.catMap ? [...activeData.catMap.values()] : []} accounts={activeData.accounts} />
      )}

      {view === 'active' && (
        activeData ? (
          activeData.groups.length ? (
            <div className="tx-list">
              {activeData.groups.map((g) => (
                <section key={g.key} className="day-group">
                  <header>
                    <span>{g.label}</span>
                    <span className="muted">
                      支 ¥{formatAmount(g.expense)}
                      {Number(g.income) > 0 ? ` · 收 ¥${formatAmount(g.income)}` : ''}
                    </span>
                  </header>
                  {g.rows.map((r) => {
                    const d = r as TxDecorated;
                    return (
                      <div key={r.id} className="tx-row" onClick={() => setEditing(r)}>
                        <span className="tx-icon">{d._cat?.icon ?? (r.type === 'transfer' ? '🔄' : '📦')}</span>
                        <div className="tx-main">
                          <div className="tx-name">{d._cat?.name ?? (r.type === 'transfer' ? '转账' : '未分类')}{r.exclude_from_budget ? ' · 不计预算' : ''}</div>
                          <div className="tx-sub muted">{d._acc?.name ?? ''}{r.note ? ` · ${r.note}` : ''}</div>
                        </div>
                        <div className={`tx-amount ${r.type}`}>
                          {r.type === 'income' ? '+' : r.type === 'transfer' ? '' : '-'}¥{formatAmount(r.amount)}
                        </div>
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
          ) : (
            <div className="placeholder">
              <div className="placeholder-icon">🧾</div>
              <p>{filterCount > 0 ? '没有符合条件的流水' : '还没有流水'}</p>
              <p className="muted">{filterCount > 0 ? '调整或清除筛选条件试试' : '去「记账」页记第一笔吧'}</p>
            </div>
          )
        ) : (
          <div className="muted loading">加载中…</div>
        )
      )}

      {view === 'recycle' && (
        <div className="day-group">
          <header>
            <span>回收站</span>
            <span className="muted small">删除后保留 30 天,可恢复</span>
          </header>
          {recycled?.length ? (
            recycled.map((r) => (
              <div key={r.id} className="tx-row">
                <span className="tx-icon muted">🗑️</span>
                <div className="tx-main">
                  <div className="tx-name muted">¥{formatAmount(r.amount)} · {r.type === 'expense' ? '支出' : r.type === 'income' ? '收入' : '转账'}</div>
                  <div className="tx-sub muted">删除于 {new Date(r.deleted_at ?? r.updated_at).toLocaleString('zh-CN')}</div>
                </div>
                <button className="mini" onClick={() => void restore(r)}>恢复</button>
              </div>
            ))
          ) : (
            <div className="muted" style={{ padding: 16, textAlign: 'center' }}>回收站是空的</div>
          )}
        </div>
      )}

      {editing && <TxEditor tx={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
