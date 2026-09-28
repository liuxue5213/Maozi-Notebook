import { cur } from './utils/currency';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  addAmount, carryover, computeBudgetProgress, forecastBudget, formatAmount, isValidAmount, newId,
  BUDGET_TEMPLATES,
  type BudgetItemRow, type BudgetRow, type CategoryRow,
} from '@ledgerone/domain';
import { db } from './db/db';
import { getActiveLedgerId } from './db/seed';
import { enqueue } from './sync/wiring';
import { categoryFreq } from './state/freq';
import { periodRange } from './utils/period';

interface BudgetModel {
  budget: BudgetRow | undefined;
  items: BudgetItemRow[];
  /** 结转额:开启结转且上月有预算时,总/分类各自动结转正剩余 */
  carryTotal: string;
  carryByCat: Map<string, string>;
  progress: ReturnType<typeof computeBudgetProgress>;
  adjusted: ReturnType<typeof computeBudgetProgress>;
}

async function loadBudgetModel(): Promise<BudgetModel | null> {
  const ledgerId = await getActiveLedgerId();
  const { start, end } = periodRange('month');
  const all = (await db.budgets.toArray())
    .filter((b) => !b.is_deleted && b.ledger_id === ledgerId && b.period_type === 'monthly')
    .sort((a, b) => b.period_start - a.period_start);
  const budget = all[0];
  const allItems = await db.budget_items.toArray();
  const txs = await db.transactions.toArray();
  const cats = await db.categories.toArray();
  const catMap = new Map(cats.map((c) => [c.id, c]));

  // 上月预算与执行 → 结转(M04-F02)
  const prevStart = (() => {
    const d = new Date(start);
    d.setMonth(d.getMonth() - 1);
    return d.getTime();
  })();
  const prev = all.find((b) => b.period_start === prevStart);
  const carryTotal = budget?.rollover && prev ? carryover(prev.total_amount, computeBudgetProgress(prev, [], txs, catMap, prevStart, start)?.used ?? '0') : '0';
  const carryByCat = new Map<string, string>();
  if (budget?.rollover && prev) {
    const prevItems = allItems.filter((i) => !i.is_deleted && i.budget_id === prev.id);
    const prevProg = computeBudgetProgress(prev, prevItems, txs, catMap, prevStart, start);
    for (const it of prevProg?.items ?? []) {
      const base = prevItems.find((x) => x.category_id === it.categoryId);
      if (base) carryByCat.set(it.categoryId, carryover(base.amount, it.used));
    }
  }

  const items = budget ? allItems.filter((i) => !i.is_deleted && i.budget_id === budget.id) : [];
  const progress = computeBudgetProgress(budget ?? null, items, txs, catMap, start, end);
  // 结转后的「实际可用」视图
  const adjustedBudget = budget ? { total_amount: carryTotal === '0' ? budget.total_amount : addAmount(budget.total_amount, carryTotal) } : null;
  const adjustedItems: BudgetItemRow[] = items.map((it) => {
    const c = carryByCat.get(it.category_id);
    return c && c !== '0' ? { ...it, amount: addAmount(it.amount, c) } : it;
  });
  const adjusted = computeBudgetProgress(adjustedBudget, adjustedItems, txs, catMap, start, end);
  return { budget, items, carryTotal, carryByCat, progress, adjusted };
}

/** 预算执行卡(M04-F01/F02/F04):总预算 + 分类预算条目、结转、80% 橙 / 100% 红 */
export function BudgetCard() {
  const [editing, setEditing] = useState(false);
  const model = useLiveQuery(loadBudgetModel, []);

  if (!model) return null;
  const { budget, items, carryTotal, progress, adjusted } = model;

  if (!budget || !progress || !adjusted) {
    return (
      <>
        <button className="budget-empty" onClick={() => setEditing(true)}>📅 设置本月预算,控制花钱节奏</button>
        {editing && <BudgetModal original={null} originalItems={[]} onClose={() => setEditing(false)} />}
      </>
    );
  }

  const view = adjusted;
  const levelText = view.level === 'over' ? '本月预算已超支' : view.level === 'warn' ? '预算即将超支' : null;
  const forecast = forecastBudget(view.total, view.used, new Date(), periodRange('month').start);

  return (
    <>
      <div className="budget-card" onClick={() => setEditing(true)}>
        <div className="budget-head">
          <span>
            本月预算 {cur()}{formatAmount(view.total)}
            {carryTotal !== '0' && <span className="muted small"> (含结转 {cur()}{formatAmount(carryTotal)})</span>}
          </span>
          <span className={`budget-pct level-${view.level}`}>{view.pct}%</span>
        </div>
        <div className="budget-bar">
          <div className={`budget-bar-fill level-${view.level}`} style={{ width: `${Math.min(view.pct, 100)}%` }} />
        </div>
        <div className="budget-sub muted">
          已用 {cur()}{formatAmount(view.used)} · 剩余 {cur()}{formatAmount(view.remaining)}
          {levelText && <span className={`budget-hint level-${view.level}`}> · {levelText}</span>}
        </div>
        <div className={`budget-forecast ${forecast.overRisk ? 'warn-text' : ''}`}>
          📈 按当前速度月末约花 {cur()}{formatAmount(forecast.predictedSpend)}
          {forecast.overRisk ? ' · 有超支风险' : ''} · 日均可用 {cur()}{formatAmount(forecast.dailyAvailable)}
        </div>
        {view.items.length > 0 && (
          <div className="budget-items" onClick={(e) => e.stopPropagation()}>
            {view.items.map((it) => (
              <div key={it.categoryId} className="budget-item">
                <div className="budget-item-head">
                  <BudgetItemName categoryId={it.categoryId} />
                  <span className="muted small">
                    {cur()}{formatAmount(it.used)} / {cur()}{formatAmount(it.amount)}
                  </span>
                </div>
                <div className="budget-item-bar">
                  <div className={`budget-bar-fill level-${it.level}`} style={{ width: `${Math.min(it.pct, 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {editing && <BudgetModal original={budget} originalItems={items} onClose={() => setEditing(false)} />}
    </>
  );
}

function BudgetItemName({ categoryId }: { categoryId: string }) {
  const name = useLiveQuery(async () => (await db.categories.get(categoryId))?.name ?? '', [categoryId]);
  return <span className="budget-item-name">{name ?? ''}</span>;
}

function BudgetModal({
  original,
  originalItems,
  onClose,
}: {
  original: BudgetRow | null;
  originalItems: BudgetItemRow[];
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(original?.total_amount ?? '');
  const [rollover, setRollover] = useState(original?.rollover ?? false);
  const [itemDrafts, setItemDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(originalItems.map((i) => [i.category_id, i.amount])),
  );
  const valid = isValidAmount(amount) && Number(amount) > 0;

  const topCats = useLiveQuery(async () => {
    const freq = categoryFreq();
    const ledgerId = await getActiveLedgerId();
    return (await db.categories.toArray())
      .filter((c) => c.ledger_id === ledgerId && !c.parent_id && c.kind === 'expense' && !c.is_hidden)
      .sort((a, b) => (freq[b.id] ?? 0) - (freq[a.id] ?? 0) || a.sort - b.sort)
      .slice(0, 8);
  }, []);

  const save = async () => {
    if (!valid || !topCats) return;
    const now = Date.now();
    const ledgerId = await getActiveLedgerId();
    let row: BudgetRow;
    if (original) {
      row = { ...original, total_amount: amount, rollover, client_version: original.client_version + 1, updated_at: now, is_deleted: false, deleted_at: null };
    } else {
      row = {
        id: newId(),
        ledger_id: ledgerId,
        period_type: 'monthly',
        period_start: periodRange('month').start,
        total_amount: amount,
        currency: 'CNY',
        rollover,
        client_version: 1,
        server_version: null,
        is_deleted: false,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      };
    }
    await db.budgets.put(row);
    enqueue('budget', row as unknown as Record<string, unknown>);

    // 分类条目 diff:新填/改额 → upsert;清空 → 软删除
    for (const cat of topCats) {
      const draft = itemDrafts[cat.id]?.trim() ?? '';
      const existing = originalItems.find((i) => i.category_id === cat.id);
      if (draft === '') {
        if (existing) {
          const del: BudgetItemRow = { ...existing, is_deleted: true, deleted_at: now, client_version: existing.client_version + 1, updated_at: now };
          await db.budget_items.put(del);
          enqueue('budget_item', del as unknown as Record<string, unknown>, 'delete');
        }
        continue;
      }
      if (!isValidAmount(draft) || Number(draft) <= 0) continue;
      if (existing) {
        if (existing.amount === draft) continue;
        const upd: BudgetItemRow = { ...existing, amount: draft, client_version: existing.client_version + 1, updated_at: now };
        await db.budget_items.put(upd);
        enqueue('budget_item', upd as unknown as Record<string, unknown>);
      } else {
        const item: BudgetItemRow = {
          id: newId(),
          budget_id: row.id,
          category_id: cat.id,
          amount: draft,
          used_cached: null,
          client_version: 1,
          server_version: null,
          is_deleted: false,
          deleted_at: null,
          created_at: now,
          updated_at: now,
        };
        await db.budget_items.put(item);
        enqueue('budget_item', item as unknown as Record<string, unknown>);
      }
    }
    onClose();
  };

  const remove = async () => {
    if (!original) return;
    if (!window.confirm('删除本月预算(含分类额度)?')) return;
    const now = Date.now();
    const row: BudgetRow = { ...original, is_deleted: true, deleted_at: now, client_version: original.client_version + 1, updated_at: now };
    await db.budgets.put(row);
    enqueue('budget', row as unknown as Record<string, unknown>, 'delete');
    for (const it of originalItems) {
      const del: BudgetItemRow = { ...it, is_deleted: true, deleted_at: now, client_version: it.client_version + 1, updated_at: now };
      await db.budget_items.put(del);
      enqueue('budget_item', del as unknown as Record<string, unknown>, 'delete');
    }
    onClose();
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal budget-modal" onClick={(e) => e.stopPropagation()}>
        <h3>本月预算</h3>
        {!original && (topCats?.length ?? 0) > 0 && (
          <div className="field">
            <label>套用模板</label>
            <div className="template-chips">
              {BUDGET_TEMPLATES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className="chip"
                  title={t.description}
                  onClick={() => {
                    setAmount(t.total);
                    const drafts: Record<string, string> = {};
                    for (const c of topCats!) {
                      const v = t.items[c.name];
                      if (v) drafts[c.id] = v;
                    }
                    setItemDrafts((d) => ({ ...d, ...drafts }));
                  }}
                >
                  {t.name} {cur()}{Number(t.total).toLocaleString('zh-CN')}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="field">
          <label>月度总预算</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="如 5000" />
        </div>
        <label className="check-row">
          <input type="checkbox" checked={rollover} onChange={(e) => setRollover(e.target.checked)} />
          结转上月剩余(超支不倒扣)
        </label>
        <div className="field">
          <label>分类预算(可选,常用分类)</label>
          <div className="budget-cat-list">
            {(topCats ?? []).map((c: CategoryRow) => (
              <div key={c.id} className="budget-cat-row">
                <span className="budget-cat-name">{c.icon} {c.name}</span>
                <input
                  value={itemDrafts[c.id] ?? ''}
                  onChange={(e) => setItemDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                  inputMode="decimal"
                  placeholder="不限"
                />
              </div>
            ))}
          </div>
        </div>
        <p className="muted small">达到 80% 提醒预警、100% 标记超支;仅统计计入预算的支出。</p>
        <button className="primary" disabled={!valid} onClick={() => void save()}>保存</button>
        {original && <button className="danger slim" onClick={() => void remove()}>删除预算</button>}
      </div>
    </div>
  );
}
