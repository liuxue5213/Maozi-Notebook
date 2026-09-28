import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  formatAmount, isValidAmount, newId, RECURRING_FREQUENCIES,
  type CategoryRow, type RecurringFrequency, type RecurringRuleRow,
} from '@ledgerone/domain';
import { db } from './db/db';
import { getActiveLedgerId } from './db/seed';
import { enqueue } from './sync/wiring';
import { runDueRecurring } from './recurring-engine';

const FREQ_LABELS: Record<RecurringFrequency, string> = {
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  quarterly: '每季',
  yearly: '每年',
};

function freqLabel(frequency: RecurringFrequency, interval: number): string {
  const base = FREQ_LABELS[frequency];
  return interval > 1 ? `每 ${interval} ${base.replace(/^每/, '')}` : base;
}

/** 周期记账管理(M01-F06):规则增删停,下次执行时间一目了然 */
export function RecurringPage({ onBack }: { onBack: () => void }) {
  const [creating, setCreating] = useState(false);
  const [genMsg, setGenMsg] = useState<string | null>(null);

  const model = useLiveQuery(async () => {
    const ledgerId = await getActiveLedgerId();
    const rules = (await db.recurring_rules.toArray())
      .filter((r) => !r.is_deleted && r.ledger_id === ledgerId)
      .sort((a, b) => a.next_run_at - b.next_run_at);
    const cats = (await db.categories.where('ledger_id').equals(ledgerId).toArray());
    const accounts = (await db.accounts.toArray()).filter((a) => !a.is_archived);
    const generated = (await db.transactions.toArray()).filter((t) => t.source === 'recurring' && !t.is_deleted).length;
    return { rules, cats, accounts, generated };
  }, []);

  if (!model) return <div className="muted loading">加载中…</div>;

  const catName = (id: string | null | undefined) => {
    const c = model.cats.find((x) => x.id === id);
    return c ? `${c.icon} ${c.name}` : '未分类';
  };

  return (
    <div className="me-tab">
      <button className="link back" onClick={onBack}>‹ 返回</button>
      <div className="me-section">
        <div className="me-row static-row">
          <span>周期记账</span>
          <span className="muted">{model.rules.length} 条规则 · 已生成 {model.generated} 笔</span>
        </div>
        <div className="me-row static-row">
          <span className="muted small">到期自动生成流水(房租/工资/订阅),打开应用时补生成历史</span>
        </div>
      </div>
      <button className="primary" onClick={() => setCreating(true)}>+ 新建周期规则</button>
      <button
        className="mini"
        onClick={async () => {
          const n = await runDueRecurring();
          setGenMsg(n > 0 ? `已补生成 ${n} 笔到期流水` : '没有到期的规则');
        }}
      >
        立即检查到期
      </button>
      {genMsg && <p className="muted small">{genMsg}</p>}

      {model.rules.map((r) => (
        <div key={r.id} className={`pending-row ${r.paused ? 'rule-paused' : ''}`}>
          <div className="pending-head">
            <div>
              <div className="tx-name">
                {r.paused ? '⏸ ' : ''}¥{formatAmount(r.amount)} · {freqLabel(r.frequency, r.interval)}
              </div>
              <div className="tx-sub muted">
                {catName(r.category_id)} · 下次 {new Date(r.next_run_at).toLocaleDateString('zh-CN')}
                {r.last_run_at ? ` · 上次 ${new Date(r.last_run_at).toLocaleDateString('zh-CN')}` : ''}
              </div>
            </div>
          </div>
          <div className="row-actions">
            <button
              className="mini"
              onClick={async () => {
                const upd: RecurringRuleRow = { ...r, paused: !r.paused, client_version: r.client_version + 1, updated_at: Date.now() };
                await db.recurring_rules.put(upd);
                enqueue('recurring_rule', upd as unknown as Record<string, unknown>);
              }}
            >
              {r.paused ? '恢复' : '暂停'}
            </button>
            <button
              className="danger slim"
              onClick={async () => {
                if (!window.confirm('删除该周期规则?已生成的流水不受影响。')) return;
                const upd: RecurringRuleRow = { ...r, is_deleted: true, deleted_at: Date.now(), client_version: r.client_version + 1, updated_at: Date.now() };
                await db.recurring_rules.put(upd);
                enqueue('recurring_rule', upd as unknown as Record<string, unknown>, 'delete');
              }}
            >
              删除
            </button>
          </div>
        </div>
      ))}
      {model.rules.length === 0 && (
        <div className="placeholder">
          <div className="placeholder-icon">🔁</div>
          <p>还没有周期规则</p>
          <p className="muted">房租、工资、订阅费交给自动生成</p>
        </div>
      )}

      {creating && (
        <RecurringModal
          cats={model.cats}
          accounts={model.accounts}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function RecurringModal({ cats, accounts, onClose }: {
  cats: CategoryRow[];
  accounts: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<RecurringFrequency>('monthly');
  const [interval, setIntervalNum] = useState('1');
  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [note, setNote] = useState('');
  const valid = isValidAmount(amount) && Number(amount) > 0 && !!accountId && Number(interval) >= 1;

  const save = async () => {
    if (!valid) return;
    const now = Date.now();
    const row: RecurringRuleRow = {
      id: newId(),
      ledger_id: await getActiveLedgerId(),
      amount,
      category_id: categoryId || null,
      account_id: accountId,
      note: note.trim() || null,
      frequency,
      interval: Math.max(1, Number(interval) || 1),
      next_run_at: now, // 立即生效:若起始日已过将补生成;下一期按周期推进
      paused: false,
      last_run_at: null,
      client_version: 1,
      server_version: null,
      is_deleted: false,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
    await db.recurring_rules.put(row);
    enqueue('recurring_rule', row as unknown as Record<string, unknown>);
    await runDueRecurring();
    onClose();
  };

  const kindOf = (id: string) => cats.find((c) => c.id === id)?.kind;
  const tops = cats.filter((c) => !c.parent_id && !c.is_hidden);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal budget-modal" onClick={(e) => e.stopPropagation()}>
        <h3>新建周期规则</h3>
        <div className="field">
          <label>金额</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="如 3500" />
        </div>
        <div className="filter-pair">
          <div className="field">
            <label>周期</label>
            <select value={frequency} onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}>
              {RECURRING_FREQUENCIES.map((f) => (
                <option key={f} value={f}>{FREQ_LABELS[f]}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>间隔(几期一次)</label>
            <input value={interval} onChange={(e) => setIntervalNum(e.target.value.replace(/\D/g, ''))} inputMode="numeric" />
          </div>
        </div>
        <div className="field">
          <label>分类(收入类分类将生成收入)</label>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">未分类(按支出)</option>
            {tops.map((c) => (
              <option key={c.id} value={c.id}>{c.icon} {c.name}{c.kind === 'income' ? '(收)' : ''}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>账户</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>备注(可选)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="如 房租" maxLength={100} />
        </div>
        <p className="muted small">
          首期立即生成一次,之后{freqLabel(frequency, Number(interval) || 1)}推进;支持月末日期自动兜底。
        </p>
        <button className="primary" disabled={!valid} onClick={() => void save()}>保存并生成首期</button>
      </div>
    </div>
  );
}
