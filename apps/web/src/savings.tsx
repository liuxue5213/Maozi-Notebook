import { cur } from './utils/currency';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { formatAmount, isValidAmount, newId, type SavingsPlanRow } from '@ledgerone/domain';
import { netSavings } from '@ledgerone/ledger-core';
import { db } from './db/db';
import { getActiveLedgerId } from './db/seed';
import { saveLocal } from './sync/wiring';
import { confirmDialog } from './ui/dialog';

const STATUS_LABELS: Record<string, string> = { active: '进行中', paused: '已暂停', achieved: '已达成', archived: '已归档' };

/**
 * 存钱计划(T-18,Web 补齐消除数据黑洞):列表 / 新建 / 暂停 / 达成 / 删除。
 * 进度口径与移动端严格一致:已存 = [period_start, min(period_end, now)) 内的
 * `netSavings`(income − expense,转账不计,`amount_base` 口径,复用 ledger-core)。
 */
export function SavingsPage({ onBack }: { onBack: () => void }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [ptype, setPtype] = useState<'yearly' | 'monthly'>('yearly');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const model = useLiveQuery(async () => {
    const ledgerId = await getActiveLedgerId();
    if (!ledgerId) return { plans: [] as Array<SavingsPlanRow & { saved: number; pct: number }> };
    const plans = (await db.savings_plans.where('ledger_id').equals(ledgerId).toArray())
      .filter((p) => !p.is_deleted)
      .sort((a, b) => b.created_at - a.created_at);
    const now = Date.now();
    // O5:各计划期间取并集下界/上界,[ledger_id+happened_at] 区间下推
    const minStart = plans.length ? Math.min(...plans.map((p) => p.period_start)) : 0;
    const maxEnd = plans.length ? Math.max(...plans.map((p) => p.period_end)) : 0;
    const txs = plans.length
      ? await db.transactions.where('[ledger_id+happened_at]').between([ledgerId, minStart], [ledgerId, maxEnd]).toArray()
      : [];
    const out = plans.map((p) => {
      const end = Math.min(p.period_end, now);
      const saved = Number(netSavings(txs.filter((t) => !t.is_deleted && t.ledger_id === p.ledger_id
        && t.happened_at >= p.period_start && t.happened_at < end)));
      const pct = Math.min(100, Math.round((saved / (Number(p.goal_amount) || 1)) * 100));
      return { ...p, saved, pct };
    });
    return { plans: out };
  }, []);

  if (!model) return <div className="muted loading">加载中…</div>;

  const create = async () => {
    const nm = name.trim().slice(0, 50);
    if (!nm) { setErr('请填写计划名'); return; }
    if (!isValidAmount(goal) || Number(goal) <= 0) { setErr('目标金额需为正数'); return; }
    setBusy(true);
    setErr(null);
    try {
      const ledgerId = await getActiveLedgerId();
      if (!ledgerId) return;
      const now = Date.now();
      const d = new Date(now);
      const year = d.getFullYear();
      // 与移动端口径一致:年度 = 自然年,月度 = 自然月(本地时区)
      const period_start = new Date(year, ptype === 'yearly' ? 0 : d.getMonth(), 1).getTime();
      const period_end = ptype === 'yearly' ? new Date(year + 1, 0, 1).getTime() : new Date(year, d.getMonth() + 1, 1).getTime();
      const row: SavingsPlanRow = {
        id: newId(),
        ledger_id: ledgerId,
        name: nm,
        goal_amount: Number(goal).toFixed(2),
        period_type: ptype,
        period_start,
        period_end,
        expected_income: null,
        baseline_months: 6,
        allocation: 'even',
        promo_months: null,
        exclude_oneoff: false,
        linked_account_id: null,
        status: 'active',
        client_version: 1,
        server_version: null,
        is_deleted: false,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      };
      await saveLocal('savings_plan', row as unknown as Record<string, unknown>);
      setName('');
      setGoal('');
      setCreating(false);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (p: SavingsPlanRow, status: SavingsPlanRow['status']) => {
    const upd: SavingsPlanRow = { ...p, status, client_version: p.client_version + 1, updated_at: Date.now() };
    await saveLocal('savings_plan', upd as unknown as Record<string, unknown>);
  };

  const removePlan = async (p: SavingsPlanRow) => {
    if (!(await confirmDialog({ message: `删除存钱计划「${p.name}」?(不影响已入账流水)`, danger: true, confirmText: '删除' }))) return;
    const now = Date.now();
    const del: SavingsPlanRow = { ...p, is_deleted: true, deleted_at: now, client_version: p.client_version + 1, updated_at: now };
    await saveLocal('savings_plan', del as unknown as Record<string, unknown>, 'delete');
  };

  return (
    <div className="me-tab">
      <button className="link back" onClick={onBack}>‹ 返回</button>
      <div className="me-section">
        <div className="me-row static-row">
          <span>存钱计划 🐷</span>
          <span className="muted">{model.plans.length} 个计划 · 已存 = 期间净结余</span>
        </div>
        <div className="me-row static-row">
          <span className="muted small">预算管支出上限,存钱管结余下限;两端创建的计划同步互通</span>
        </div>
      </div>
      <button className="primary" onClick={() => setCreating((v) => !v)}>+ 新建存钱计划</button>
      {creating && (
        <div className="pending-row">
          <input
            className="note-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="计划名(如 三亚旅行)"
            maxLength={50}
          />
          <input
            className="note-input"
            value={goal}
            onChange={(e) => setGoal(e.target.value.replace(/[^\d.]/g, ''))}
            inputMode="decimal"
            placeholder="目标金额"
          />
          <div className="type-toggle">
            {(['yearly', 'monthly'] as const).map((t) => (
              <button key={t} className={ptype === t ? 'active' : ''} onClick={() => setPtype(t)}>
                {t === 'yearly' ? '年度计划' : '月度计划'}
              </button>
            ))}
          </div>
          {err && <p className="muted small" style={{ color: 'var(--expense)' }}>{err}</p>}
          <button className="primary" disabled={busy || !name.trim() || !isValidAmount(goal)} onClick={() => void create()}>
            {busy ? '保存中…' : '创建计划'}
          </button>
        </div>
      )}
      {model.plans.map((p) => (
        <div key={p.id} className={`pending-row ${p.status === 'paused' ? 'rule-paused' : ''}`}>
          <div className="pending-head">
            <div>
              <div className="tx-name">
                {p.status === 'paused' ? '⏸ ' : ''}{p.name}
              </div>
              <div className="tx-sub muted">
                已存 {cur()}{formatAmount(String(p.saved))} / 目标 {cur()}{formatAmount(p.goal_amount)}
                {' · '}{p.period_type === 'yearly' ? '年度' : '月度'}
                {' · '}{STATUS_LABELS[p.status] ?? p.status}
              </div>
            </div>
            <div className="tx-amount income">{p.pct}%</div>
          </div>
          <div className="budget-bar">
            <div className="budget-bar-fill" style={{ width: `${Math.max(2, p.pct)}%` }} />
          </div>
          <div className="row-actions">
            <button className="mini" onClick={() => void setStatus(p, p.status === 'paused' ? 'active' : 'paused')}>
              {p.status === 'paused' ? '继续' : '暂停'}
            </button>
            {Number(p.saved) >= Number(p.goal_amount) && p.status === 'active' && (
              <button className="mini" onClick={() => void setStatus(p, 'achieved')}>标记达成</button>
            )}
            <button className="mini danger-text" onClick={() => void removePlan(p)}>删除</button>
          </div>
        </div>
      ))}
      {model.plans.length === 0 && !creating && (
        <p className="muted small" style={{ textAlign: 'center' }}>还没有存钱计划,点上方「新建」创建</p>
      )}
    </div>
  );
}
