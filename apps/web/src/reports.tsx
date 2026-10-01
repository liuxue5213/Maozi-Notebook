import { cur } from './utils/currency';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { addAmount, cmpAmount, formatAmount, subAmount, type CategoryRow, type TransactionRow } from '@ledgerone/domain';
import { buildReportModel, periodRange, type CatAgg, type PeriodKind } from '@ledgerone/ledger-core';
import { db } from './db/db';
import { getActiveLedgerId } from './db/seed';


const PERIODS: Array<{ key: PeriodKind; label: string }> = [
  { key: 'day', label: '日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
  { key: 'year', label: '年' },
];

const PALETTE = ['#4361ee', '#e5484d', '#2f9e6e', '#f08c00', '#8e44ad', '#0ea5e9', '#d6336c', '#adb5bd'];

export function Reports() {
  const [period, setPeriod] = useState<PeriodKind>('month');
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [drillId, setDrillId] = useState<string | null>(null);

  const model = useLiveQuery(
    async () => {
      const { start, end } = periodRange(period);
      const ledgerId = await getActiveLedgerId(); // P1-4:报表按当前账本作用域
      const rows = (await db.transactions.where('happened_at').between(start, end, true, false).toArray())
        .filter((r) => !r.is_deleted && r.type !== 'transfer' && r.ledger_id === ledgerId);
      const cats = (await db.categories.where('ledger_id').equals(ledgerId).toArray());
      // P1-1:聚合编排下沉共享内核(Web 取数 → core 口径 → 渲染;App 直接复用)
      const allExpenses = (await db.transactions.toArray()).filter((r) => !r.is_deleted && r.type === 'expense');
      const core = buildReportModel({ rows, allExpenses, cats, kind, period, now: Date.now() });
      return { ...core, cats, catMap: core.catMap };
    },
    [period, kind],
  );

  if (!model) return <div className="muted loading">加载中…</div>;

  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? '';
  const balance = subAmount(model.income, model.expense);
  const items = [...model.byTop.entries()]
    .map(([id, v]) => ({ id, ...v, cat: model.catMap.get(id) }))
    .filter((x): x is { id: string; amount: string; count: number; cat: CategoryRow } => !!x.cat && !x.cat.is_hidden)
    .sort((a, b) => cmpAmount(b.amount, a.amount));
  const total = items.reduce((acc, x) => addAmount(acc, x.amount), '0');

  return (
    <div className="reports">
      <div className="report-controls">
        <div className="type-toggle compact">
          {PERIODS.map((p) => (
            <button key={p.key} className={period === p.key ? 'active' : ''} onClick={() => { setPeriod(p.key); setDrillId(null); }}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="type-toggle compact">
          <button className={kind === 'expense' ? 'active' : ''} onClick={() => { setKind('expense'); setDrillId(null); }}>支出</button>
          <button className={kind === 'income' ? 'active' : ''} onClick={() => { setKind('income'); setDrillId(null); }}>收入</button>
        </div>
      </div>

      <div className="report-overview">
        <div>
          <div className="label">本{periodLabel}支出</div>
          <div className="num expense">{cur()}{formatAmount(model.expense)}</div>
        </div>
        <div>
          <div className="label">本{periodLabel}收入</div>
          <div className="num income">{cur()}{formatAmount(model.income)}</div>
        </div>
        <div>
          <div className="label">结余</div>
          <div className={`num ${Number(balance) >= 0 ? 'income' : 'expense'}`}>{cur()}{formatAmount(balance)}</div>
        </div>
      </div>

      {model.forecast && (model.forecast.predicted > 0 || model.forecast.sampleMonths > 0) && (
        <div className="report-card forecast-card">
          <div className="report-card-title">月底预测</div>
          <div className="forecast-main">
            <span>预计本月支出</span>
            <span className={`forecast-num ${((model.forecast.vsAvgPct ?? 0) > 0) ? 'expense' : 'income'}`}>
              {cur()}{formatAmount(String(model.forecast.predicted))}
            </span>
            {model.forecast.vsAvgPct !== null && (
              <span className={`forecast-badge ${(model.forecast.vsAvgPct) > 0 ? 'up' : 'down'}`}>
                {model.forecast.vsAvgPct > 0 ? '高于' : '低于'}近{model.forecast.sampleMonths}月均 {Math.abs(model.forecast.vsAvgPct)}%
              </span>
            )}
          </div>
          <div className="muted small">
            本月已花 {cur()}{formatAmount(String(model.forecast.elapsedDays >= 0 ? model.monthUsed : '0'))}(至 {model.forecast.elapsedDays}/{model.forecast.totalDays} 日)
            {model.forecast.sampleMonths > 0 && <> · 近 {model.forecast.sampleMonths} 个月月均 {cur()}{formatAmount(String(Math.round(model.forecast.historyAvg ?? 0)))}</>}
          </div>
          <div className="muted small">
            按本月节奏 {cur()}{formatAmount(String(Math.round(model.forecast.paceEnd)))}
            {model.forecast.historyEnd !== null && <> · 按历史同期 {cur()}{formatAmount(String(Math.round(model.forecast.historyEnd)))}</>}
            ,取两路平均
          </div>
        </div>
      )}

      <div className="report-card">
        <div className="report-card-title">支出趋势</div>
        <div className="trend">
          {model.buckets.map((b, i) => {
            const max = Math.max(...model.buckets.map((x) => Number(x.amount)), 1);
            return (
              <div key={i} className={`trend-col ${b.isCurrent ? 'current' : ''}`} title={`${b.label} ${cur()}${formatAmount(b.amount)}`}>
                <div className="trend-bar-wrap">
                  <div className="trend-bar" style={{ height: `${Math.max((Number(b.amount) / max) * 100, Number(b.amount) > 0 ? 6 : 0)}%` }} />
                </div>
                <span className="trend-label">{b.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {drillId ? (
        <DrillDown
          top={model.catMap.get(drillId)!}
          byCat={model.byCat}
          catMap={model.catMap}
          rows={model.rows}
          kind={kind}
          total={total}
          onBack={() => setDrillId(null)}
        />
      ) : (
        <div className="report-card">
          <div className="report-card-title">{kind === 'expense' ? '支出' : '收入'}分类占比</div>
          {items.length === 0 || Number(total) === 0 ? (
            <div className="muted" style={{ padding: '24px 0', textAlign: 'center' }}>本周期暂无{kind === 'expense' ? '支出' : '收入'}</div>
          ) : (
            <>
              <div className="donut-row">
                <Donut items={items.map((x) => ({ label: x.cat.name, amount: x.amount }))} total={total} />
                <div className="donut-legend">
                  {items.slice(0, 8).map((x, i) => (
                    <div key={x.id} className="legend-item">
                      <span className="legend-dot" style={{ background: PALETTE[i % PALETTE.length] }} />
                      <span className="legend-name">{x.cat.icon} {x.cat.name}</span>
                      <span className="legend-pct">{((Number(x.amount) / Number(total)) * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rank-list">
                {items.map((x, i) => (
                  <button key={x.id} className="rank-row" onClick={() => setDrillId(x.id)}>
                    <span className="tx-icon">{x.cat.icon}</span>
                    <div className="rank-main">
                      <div className="rank-name">{x.cat.name} <span className="muted small">{x.count} 笔</span></div>
                      <div className="rank-bar">
                        <div className="rank-bar-fill" style={{ width: `${(Number(x.amount) / Number(total)) * 100}%`, background: PALETTE[i % PALETTE.length] }} />
                      </div>
                    </div>
                    <div className="rank-amount">{cur()}{formatAmount(x.amount)}</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Donut({ items, total }: { items: Array<{ label: string; amount: string }>; total: string }) {
  const top7 = items.slice(0, 7);
  const rest = items.slice(7);
  const segments: Array<{ label: string; pct: number }> = top7.map((x) => ({ label: x.label, pct: (Number(x.amount) / Number(total)) * 100 }));
  if (rest.length) {
    segments.push({ label: '其他', pct: rest.reduce((acc, x) => acc + Number(x.amount), 0) / Number(total) * 100 });
  }
  let acc = 25; // SVG 圆环从 12 点方向起笔
  return (
    <svg viewBox="0 0 42 42" className="donut" role="img">
      <circle cx="21" cy="21" r="15.915" fill="none" stroke="#eef0f4" strokeWidth="5" />
      {segments.map((s, i) => {
        const dash = `${s.pct} ${100 - s.pct}`;
        const offset = acc;
        acc -= s.pct;
        return (
          <circle
            key={i}
            cx="21" cy="21" r="15.915" fill="none"
            stroke={PALETTE[i % PALETTE.length]} strokeWidth="5"
            strokeDasharray={dash} strokeDashoffset={offset}
          />
        );
      })}
    </svg>
  );
}

function DrillDown({
  top, byCat, catMap, rows, kind, total, onBack,
}: {
  top: CategoryRow;
  byCat: Map<string, CatAgg>;
  catMap: Map<string, CategoryRow>;
  rows: TransactionRow[];
  kind: 'expense' | 'income';
  total: string;
  onBack: () => void;
}) {
  const children = [...byCat.entries()]
    .map(([id, v]) => ({ id, ...v, cat: catMap.get(id) }))
    .filter((x): x is { id: string; amount: string; count: number; cat: CategoryRow } => !!x.cat && x.cat.parent_id === top.id)
    .sort((a, b) => cmpAmount(b.amount, a.amount));
  const direct = byCat.get(top.id);
  const topAgg = byCat.get(top.id) ?? { amount: '0', count: 0 };
  const catTotal = children.reduce((acc, c) => addAmount(acc, c.amount), direct ? topAgg.amount : '0');
  const txRows = rows
    .filter((r) => {
      if (r.type !== kind || !r.category_id) return false;
      const c = catMap.get(r.category_id);
      return !!c && (c.id === top.id || c.parent_id === top.id);
    })
    .sort((a, b) => b.happened_at - a.happened_at)
    .slice(0, 50);

  return (
    <div className="report-card">
      <button className="link back" onClick={onBack}>‹ 返回占比</button>
      <div className="report-card-title">{top.icon} {top.name} · {cur()}{formatAmount(catTotal)}{Number(total) > 0 ? `(${((Number(catTotal) / Number(total)) * 100).toFixed(1)}%)` : ''}</div>
      <div className="rank-list">
        {direct && (
          <div className="rank-row static">
            <span className="tx-icon">{top.icon}</span>
            <div className="rank-main"><div className="rank-name">未分二级</div></div>
            <div className="rank-amount">{cur()}{formatAmount(direct.amount)} <span className="muted small">{direct.count} 笔</span></div>
          </div>
        )}
        {children.map((c, i) => (
          <div key={c.id} className="rank-row static">
            <span className="tx-icon">{c.cat.icon}</span>
            <div className="rank-main">
              <div className="rank-name">{c.cat.name} <span className="muted small">{c.count} 笔</span></div>
              <div className="rank-bar">
                <div className="rank-bar-fill" style={{ width: `${Number(catTotal) > 0 ? (Number(c.amount) / Number(catTotal)) * 100 : 0}%`, background: PALETTE[i % PALETTE.length] }} />
              </div>
            </div>
            <div className="rank-amount">{cur()}{formatAmount(c.amount)}</div>
          </div>
        ))}
        {!direct && children.length === 0 && <div className="muted" style={{ padding: 12, textAlign: 'center' }}>该分类本周期无记录</div>}
      </div>
      {txRows.length > 0 && (
        <>
          <div className="report-card-title small-title">流水明细({txRows.length}{rows.length > 50 ? '+' : ''})</div>
          <div className="drill-tx-list">
            {txRows.map((r) => {
              const c = catMap.get(r.category_id ?? '');
              return (
                <div key={r.id} className="tx-row">
                  <span className="tx-icon">{c?.icon ?? '📦'}</span>
                  <div className="tx-main">
                    <div className="tx-name">{c?.name ?? '未分类'}</div>
                    <div className="tx-sub muted">{new Date(r.happened_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}{r.note ? ` · ${r.note}` : ''}</div>
                  </div>
                  <div className={`tx-amount ${r.type}`}>{r.type === 'income' ? '+' : '-'}{cur()}{formatAmount(r.amount)}</div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
