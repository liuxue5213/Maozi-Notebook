import { cur } from './utils/currency';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {forecastBudget, formatAmount, isValidAmount, newId,
  BUDGET_TEMPLATES,
  type BudgetItemRow, type BudgetRow, type CategoryRow, budgetPeriodRange, type BudgetPeriodType } from '@ledgerone/domain';
// 预算编排口径下沉到共享内核:Web 与 App 调用同一份 buildBudgetModel,避免两端各写一遍
import { buildBudgetModel, type BudgetModel } from '@ledgerone/ledger-core';
import { db } from './db/db';
import { getActiveLedgerId } from './db/seed';
import { saveLocal } from './sync/wiring';
import { categoryFreq } from './state/freq';
import { periodRange } from './utils/period';
import { confirmDialog } from './ui/dialog';

async function loadBudgetModel(periodType: BudgetPeriodType = 'monthly'): Promise<BudgetModel | null> {
  const ledgerId = await getActiveLedgerId();
  const { start, end, prevStart } = budgetPeriodRange(periodType);
  const [budgets, budgetItems, transactions, categories] = await Promise.all([
    db.budgets.toArray(),
    db.budget_items.toArray(),
    db.transactions.toArray(),
    db.categories.toArray(),
  ]);
  return buildBudgetModel({
    budgets,
    budgetItems,
    transactions,
    categories,
    ledgerId,
    periodType,
    periodStart: start,
    periodEnd: end,
    prevPeriodStart: prevStart,
  });
}

/** 预算执行卡(M04-F01/F02/F04):总预算 + 分类预算条目、结转、80% 橙 / 100% 红 */
const BUDGET_PERIODS: Array<{ key: BudgetPeriodType; label: string }> = [
  { key: 'weekly', label: '周' },
  { key: 'monthly', label: '月' },
  { key: 'quarterly', label: '季' },
  { key: 'yearly', label: '年' },
];

export function BudgetCard() {
  const [editing, setEditing] = useState(false);
  const [periodType, setPeriodType] = useState<BudgetPeriodType>('monthly');
  const model = useLiveQuery(() => loadBudgetModel(periodType), [periodType]);

  if (!model) return null;
  const { budget, items, carryTotal, progress, adjusted } = model;

  if (!budget || !progress || !adjusted) {
    return (
      <>
        <div className="type-toggle compact" style={{ marginBottom: 6 }} onClick={(e) => e.stopPropagation()}>
          {BUDGET_PERIODS.map((p) => (
            <button key={p.key} className={periodType === p.key ? 'active' : ''} onClick={() => setPeriodType(p.key)}>{p.label}</button>
          ))}
        </div>
        <button className="budget-empty" onClick={() => setEditing(true)}>📅 设置{BUDGET_PERIODS.find((p) => p.key === periodType)?.label}预算,控制花钱节奏</button>
        {editing && <BudgetModal original={null} originalItems={[]} defaultPeriod={periodType} onClose={() => { setEditing(false); }} />}
      </>
    );
  }

  const view = adjusted;
  const levelText = view.level === 'over' ? '预算已超支' : view.level === 'warn' ? '预算即将超支' : null;
  const forecast = forecastBudget(view.total, view.used, new Date(), budgetPeriodRange(periodType).start);

  return (
    <>
      <div className="budget-card" onClick={() => setEditing(true)}>
        <div className="type-toggle compact" style={{ marginBottom: 8 }} onClick={(e) => e.stopPropagation()}>
          {BUDGET_PERIODS.map((p) => (
            <button key={p.key} className={periodType === p.key ? 'active' : ''} onClick={() => setPeriodType(p.key)}>{p.label}</button>
          ))}
        </div>
        <div className="budget-head">
          <span>
            {BUDGET_PERIODS.find((p) => p.key === periodType)?.label}预算 {cur()}{formatAmount(view.total)}
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
  defaultPeriod = 'monthly',
  onClose,
}: {
  original: BudgetRow | null;
  originalItems: BudgetItemRow[];
  /** 新建时预选的预算周期(N1);编辑时以 original.period_type 为准 */
  defaultPeriod?: BudgetPeriodType;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(original?.total_amount ?? '');
  const [rollover, setRollover] = useState(original?.rollover ?? false);
  // 总预算输入框被用户手动改过 → 保存时分类额度按比例跟随;
  // 未手动改过 → 编辑分类配额时总预算自动合计跟随
  const [totalTouched, setTotalTouched] = useState(false);
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
      const periodType = defaultPeriod;
      row = {
        id: newId(),
        ledger_id: ledgerId,
        period_type: periodType,
        period_start: budgetPeriodRange(periodType).start,
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
    await saveLocal('budget', row as unknown as Record<string, unknown>, 'upsert', (original ?? undefined) as unknown as Record<string, unknown> | undefined); // base=编辑前快照:三方合并防「后推者赢」恢复旧值

    // 改总预算(用户手动改动)时,未单独改动的分类额度按比例缩放,合计精确等于新总额
    // (取整余数补给最大项);用户本轮手动改过/清空的条目保持其意图不动
    const drafts: Record<string, string> = { ...itemDrafts };
    const oldTotal = original ? Number(original.total_amount) : NaN;
    const newTotal = Number(amount);
    if (totalTouched && original && originalItems.length > 0 && oldTotal > 0 && newTotal > 0 && oldTotal !== newTotal) {
      const untouched = originalItems
        .map((it) => {
          const d = drafts[it.category_id]?.trim() ?? '';
          return { catId: it.category_id, old: Number(d), raw: d };
        })
        .filter((u) => u.raw !== '' && isValidAmount(u.raw) && u.old > 0 && u.old === Number(u.old));
      const oldSum = untouched.reduce((s, u) => s + u.old, 0);
      if (oldSum > 0 && untouched.length > 0) {
        const scaled = untouched.map((u) => ({ ...u, val: Math.max(1, Math.round((u.old * newTotal) / oldSum)) }));
        const biggest = scaled.reduce((a, b) => (b.old > a.old ? b : a));
        const drift = newTotal - scaled.reduce((s, u) => s + u.val, 0);
        biggest.val = Math.max(0, biggest.val + drift);
        for (const u of scaled) drafts[u.catId] = String(u.val);
        setItemDrafts(drafts);
      }
    }

    // 分类条目 diff:新填/改额 → upsert;清空 → 软删除
    for (const cat of topCats) {
      const draft = drafts[cat.id]?.trim() ?? '';
      const existing = originalItems.find((i) => i.category_id === cat.id);
      if (draft === '') {
        if (existing) {
          const del: BudgetItemRow = { ...existing, is_deleted: true, deleted_at: now, client_version: existing.client_version + 1, updated_at: now };
          await saveLocal('budget_item', del as unknown as Record<string, unknown>, 'delete', existing as unknown as Record<string, unknown>);
        }
        continue;
      }
      if (!isValidAmount(draft) || Number(draft) <= 0) continue;
      if (existing) {
        if (existing.amount === draft) continue;
        const upd: BudgetItemRow = { ...existing, amount: draft, client_version: existing.client_version + 1, updated_at: now };
        await saveLocal('budget_item', upd as unknown as Record<string, unknown>, 'upsert', existing as unknown as Record<string, unknown>);
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
        await saveLocal('budget_item', item as unknown as Record<string, unknown>);
      }
    }
    onClose();
  };

  const remove = async () => {
    if (!original) return;
    if (!(await confirmDialog({ message: '删除本月预算(含分类额度)?', danger: true, confirmText: '删除' }))) return;
    const now = Date.now();
    const row: BudgetRow = { ...original, is_deleted: true, deleted_at: now, client_version: original.client_version + 1, updated_at: now };
    await saveLocal('budget', row as unknown as Record<string, unknown>, 'delete', (original ?? undefined) as unknown as Record<string, unknown> | undefined);
    for (const it of originalItems) {
      const del: BudgetItemRow = { ...it, is_deleted: true, deleted_at: now, client_version: it.client_version + 1, updated_at: now };
      await saveLocal('budget_item', del as unknown as Record<string, unknown>, 'delete');
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
          <input
            value={amount}
            onChange={(e) => { setAmount(e.target.value); setTotalTouched(true); }}
            inputMode="decimal"
            placeholder="如 5000"
          />
        </div>
        <label className="check-row">
          <input type="checkbox" checked={rollover} onChange={(e) => setRollover(e.target.checked)} />
          结转上月剩余(超支不倒扣)
        </label>
        <div className="field">
          <label>
            分类预算(可选,常用分类)
            {(() => {
              const catSum = Object.values(itemDrafts).reduce(
                (s, v) => (v && isValidAmount(v.trim()) && Number(v) > 0 ? s + Number(v) : s), 0);
              const totalNum = Number(amount);
              if (!(catSum > 0) || !(totalNum > 0)) return null;
              const over = catSum > totalNum;
              return (
                <span className={`muted small${over ? ' warn-text' : ''}`}>
                  {' '}· 合计 ¥{formatAmount(String(catSum))} / 总 ¥{formatAmount(String(totalNum))}
                  {over ? '(分类合计超过总预算)' : ''}
                </span>
              );
            })()}
          </label>
          <div className="budget-cat-list">
            {(topCats ?? []).map((c: CategoryRow) => (
              <div key={c.id} className="budget-cat-row">
                <span className="budget-cat-name">{c.icon} {c.name}</span>
                <input
                  value={itemDrafts[c.id] ?? ''}
                  onChange={(e) => {
                    const next = { ...itemDrafts, [c.id]: e.target.value };
                    setItemDrafts(next);
                    // 分类配额手动调整 → 总预算自动跟随合计(总预算被手动改过则不联动)
                    if (!totalTouched) {
                      const sum = Object.values(next).reduce(
                        (s, v) => (v && isValidAmount(v.trim()) && Number(v) > 0 ? s + Number(v) : s), 0);
                      if (sum > 0) setAmount(String(sum));
                    }
                  }}
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
