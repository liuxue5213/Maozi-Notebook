import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { addAmount, formatAmount, type CategoryRow, type TransactionRow } from '@ledgerone/domain';
import { db } from './db/db';
import { TxEditor } from './txedit';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const DAY_MS = 86_400_000;

function monthStart(viewMonth: Date): number {
  return new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1).getTime();
}

/** 日历视图(P05):月历 + 每日收支标记,点击日期查看当日明细 */
export function CalendarView() {
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selectedDay, setSelectedDay] = useState<number | null>(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  });
  const [editing, setEditing] = useState<TransactionRow | null>(null);

  const model = useLiveQuery(async () => {
    const start = monthStart(viewMonth);
    const end = (() => {
      const d = new Date(viewMonth);
      d.setMonth(d.getMonth() + 1);
      return d.getTime();
    })();
    const rows = (await db.transactions.where('happened_at').between(start, end, true, false).toArray())
      .filter((r) => !r.is_deleted && r.type !== 'transfer');
    const cats = await db.categories.toArray();
    const accounts = await db.accounts.toArray();
    const catMap = new Map(cats.map((c) => [c.id, c]));
    const accMap = new Map(accounts.map((a) => [a.id, a]));
    const byDay = new Map<number, { expense: string; income: string }>();
    for (const r of rows) {
      const d = new Date(r.happened_at);
      const key = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const agg = byDay.get(key) ?? { expense: '0', income: '0' };
      if (r.type === 'expense') agg.expense = addAmount(agg.expense, r.amount_base);
      else agg.income = addAmount(agg.income, r.amount_base);
      byDay.set(key, agg);
    }
    const monthExpense = rows
      .filter((r) => r.type === 'expense')
      .reduce((acc, r) => addAmount(acc, r.amount_base), '0');
    return { byDay, catMap, accMap, rows, monthExpense };
  }, [viewMonth.getTime()]);

  const cells = useMemo(() => {
    const start = monthStart(viewMonth);
    const firstWeekday = (new Date(start).getDay() + 6) % 7; // 周一=0(M14-F03 默认周起始一)
    const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
    const list: Array<{ day: number; ts: number } | null>[] = [];
    let week: Array<{ day: number; ts: number } | null> = Array.from({ length: firstWeekday }, () => null);
    for (let day = 1; day <= daysInMonth; day++) {
      const ts = start + (day - 1) * DAY_MS;
      week.push({ day, ts });
      if (week.length === 7) {
        list.push(week);
        week = [];
      }
    }
    if (week.length) list.push([...week, ...Array.from({ length: 7 - week.length }, () => null)]);
    return list;
  }, [viewMonth.getTime()]);

  const shiftMonth = (delta: number) => {
    const d = new Date(viewMonth);
    d.setMonth(d.getMonth() + delta);
    setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  };

  const todayTs = (() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  })();

  const dayRows = useMemo(() => {
    if (!model || selectedDay === null) return [];
    const end = selectedDay + DAY_MS;
    return model.rows
      .filter((r) => r.happened_at >= selectedDay && r.happened_at < end)
      .sort((a, b) => b.happened_at - a.happened_at);
  }, [model, selectedDay]);

  const decorate = (r: TransactionRow): TransactionRow & { _cat?: CategoryRow; _acc?: { name: string } } => {
    const d = r as TransactionRow & { _cat?: CategoryRow; _acc?: { name: string } };
    d._cat = model?.catMap.get(r.category_id ?? '');
    d._acc = model?.accMap.get(r.account_id);
    return d;
  };

  return (
    <div className="calendar-view">
      <div className="calendar-card">
        <div className="calendar-head">
          <button className="mini" onClick={() => shiftMonth(-1)}>‹</button>
          <span className="calendar-title">{viewMonth.getFullYear()} 年 {viewMonth.getMonth() + 1} 月</span>
          <button className="mini" onClick={() => shiftMonth(1)}>›</button>
        </div>
        <div className="calendar-weekdays">
          {WEEKDAYS.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        <div className="calendar-grid">
          {cells.map((week, wi) => (
            <div key={wi} className="calendar-week">
              {week.map((cell, ci) => {
                if (!cell) return <span key={ci} className="calendar-cell empty" />;
                const agg = model?.byDay.get(cell.ts);
                const isToday = cell.ts === todayTs;
                const isSelected = cell.ts === selectedDay;
                return (
                  <button
                    key={ci}
                    className={`calendar-cell ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`}
                    onClick={() => setSelectedDay(cell.ts)}
                  >
                    <span className="calendar-day">{cell.day}</span>
                    {agg && Number(agg.expense) > 0 && <span className="calendar-expense">-{formatAmount(agg.expense)}</span>}
                    {agg && Number(agg.income) > 0 && <span className="calendar-income">+{formatAmount(agg.income)}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {model && (
          <div className="calendar-foot muted small">
            本月支出 ¥{formatAmount(model.monthExpense)}
          </div>
        )}
      </div>

      {selectedDay !== null && (
        <div className="day-group">
          <header>
            <span>{new Date(selectedDay).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })}</span>
            <span className="muted small">{dayRows.length} 笔</span>
          </header>
          {dayRows.length ? (
            dayRows.map((r) => {
              const d = decorate(r);
              return (
                <div key={r.id} className="tx-row" onClick={() => setEditing(r)}>
                  <span className="tx-icon">{d._cat?.icon ?? '📦'}</span>
                  <div className="tx-main">
                    <div className="tx-name">{d._cat?.name ?? '未分类'}</div>
                    <div className="tx-sub muted">{d._acc?.name ?? ''}{r.note ? ` · ${r.note}` : ''}</div>
                  </div>
                  <div className={`tx-amount ${r.type}`}>
                    {r.type === 'income' ? '+' : '-'}¥{formatAmount(r.amount)}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="muted" style={{ padding: 16, textAlign: 'center' }}>当日无收支</div>
          )}
        </div>
      )}

      {editing && <TxEditor tx={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
