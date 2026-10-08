import { cur } from './utils/currency';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, addAmount, billingCycleRange, computeNetWorth, daysUntilDue,
  formatAmount, isValidAmount, newId, subAmount,
  type AccountRow, type AccountType, type TransactionRow,
} from '@ledgerone/domain';
import { db } from './db/db';
import { getActiveLedgerId } from './db/seed';
import { saveLocal } from './sync/wiring';
import { alertDialog, confirmDialog } from './ui/dialog';

const TYPE_ICONS: Record<AccountType, string> = {
  cash: '💵', debit_card: '💳', credit_card: '💳', wallet: '👛',
  investment: '📈', receivable: '🤝', payable: '🧾',
};

export function AccountsPage({ onBack }: { onBack: () => void }) {
  const [editing, setEditing] = useState<AccountRow | null>(null);
  const [creating, setCreating] = useState(false);

  const model = useLiveQuery(async () => {
    // P1-4:账户/余额按当前账本作用域;P1-5:软删账户不显示且不计入净值
    const ledgerId = await getActiveLedgerId();
    const accounts = (await db.accounts.where('ledger_id').equals(ledgerId).toArray())
      .filter((a) => !a.is_deleted)
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
    const txs = (await db.transactions.where('ledger_id').equals(ledgerId).toArray());
    const now = new Date();
    // 信用卡本期账单(M02-F05):周期消费 − 周期内还款(转入)
    const credits = accounts
      .filter((a) => a.type === 'credit_card' && !a.is_archived && a.credit_bill_day != null)
      .map((a) => {
        const { start } = billingCycleRange(a.credit_bill_day!, now);
        const onCard = txs.filter((t) => !t.is_deleted && t.happened_at >= start && (t.account_id === a.id || t.to_account_id === a.id));
        const spend = onCard
          .filter((t) => t.type === 'expense')
          .reduce((acc, t) => addAmount(acc, t.amount_base), '0');
        const repaid = onCard
          .filter((t) => t.type === 'transfer' && t.to_account_id === a.id)
          .reduce((acc, t) => addAmount(acc, t.amount_base), '0');
        return {
          account: a,
          bill: subAmount(spend, repaid),
          spend,
          dueIn: a.credit_due_day != null ? daysUntilDue(a.credit_due_day, now) : null,
        };
      });
    return { accounts, summary: computeNetWorth(accounts, txs), credits };
  });

  if (!model) return <div className="muted loading">加载中…</div>;
  const { accounts, summary, credits } = model;
  const active = accounts.filter((a) => !a.is_archived);
  const archived = accounts.filter((a) => a.is_archived);

  return (
    <div className="accounts-page">
      <button className="link back" onClick={onBack}>‹ 返回</button>
      <div className="networth-card">
        <div className="today-row">
          <div>
            <div className="label">资产</div>
            <div className="num">{cur()}{formatAmount(summary.assets)}</div>
          </div>
          <div>
            <div className="label">负债</div>
            <div className="num">{cur()}{formatAmount(summary.liabilities)}</div>
          </div>
          <div>
            <div className="label">净值</div>
            <div className="num strong">{cur()}{formatAmount(summary.net)}</div>
          </div>
        </div>
        <div className="month-row muted small">余额由流水实时推导 · 归档账户不计入汇总</div>
      </div>

      <div className="account-list">
        {active.map((a) => (
          <div key={a.id} className="account-row" onClick={() => setEditing(a)}>
            <span className="tx-icon">{TYPE_ICONS[a.type as AccountType] ?? '💵'}</span>
            <div className="tx-main">
              <div className="tx-name">{a.name}</div>
              <div className="tx-sub muted">{ACCOUNT_TYPE_LABELS[a.type as AccountType]}{a.include_in_net ? '' : ' · 不计净值'}</div>
            </div>
            <div className={`tx-amount ${Number(summary.balances.get(a.id)) < 0 ? 'expense' : ''}`}>{cur()}{formatAmount(summary.balances.get(a.id) ?? '0')}</div>
          </div>
        ))}
        {archived.length > 0 && <div className="muted small" style={{ padding: '10px 6px 2px' }}>已归档(不计净值,历史保留)</div>}
        {archived.map((a) => (
          <div key={a.id} className="account-row archived" onClick={() => setEditing(a)}>
            <span className="tx-icon">{TYPE_ICONS[a.type as AccountType] ?? '💵'}</span>
            <div className="tx-main">
              <div className="tx-name">{a.name}</div>
              <div className="tx-sub muted">{ACCOUNT_TYPE_LABELS[a.type as AccountType]} · 已归档</div>
            </div>
            <div className="tx-amount muted">{cur()}{formatAmount(summary.balances.get(a.id) ?? '0')}</div>
          </div>
        ))}
      </div>

      {credits.length > 0 && (
        <div className="me-section credit-section">
          <div className="me-row static-row">
            <span>信用卡账单</span>
            <span className="muted">周期自账单日起</span>
          </div>
          {credits.map((c) => (
            <div key={c.account.id} className="me-row static-row credit-row">
              <div>
                <div className="tx-name">{TYPE_ICONS.credit_card} {c.account.name} 本期账单</div>
                <div className="tx-sub muted">
                  消费 {cur()}{formatAmount(c.spend)}
                  {c.account.credit_limit != null && ` · 额度 ${cur()}${formatAmount(c.account.credit_limit)}`}
                  {c.dueIn != null && (c.dueIn > 0 ? ` · ${c.dueIn} 天后还款` : c.dueIn === 0 ? ' · 今天还款日' : ' · 还款日已过')}
                </div>
              </div>
              <div className="credit-right">
                <div className={`tx-amount ${Number(c.bill) > 0 ? 'expense' : 'income'}`}>{cur()}{formatAmount(c.bill)}</div>
                {Number(c.bill) > 0 && (
                  <button
                    className="mini"
                    onClick={() => void repay(c.account, c.bill, model.accounts)}
                  >
                    一键还款
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <button className="primary" onClick={() => setCreating(true)}>+ 新增账户</button>

      {(editing || creating) && (
        <AccountEditor
          original={editing}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

/** 一键还款(M02-F04):从第一个可用非信用账户转入信用卡,转账不计支出 */
async function repay(creditAccount: AccountRow, amount: string, accounts: AccountRow[]): Promise<void> {
  const from = accounts.find((a) => !a.is_archived && a.id !== creditAccount.id && (a.type === 'cash' || a.type === 'debit_card'));
  if (!from) {
    await alertDialog('没有可用的现金/储蓄卡账户作为还款来源');
    return;
  }
  if (!(await confirmDialog({ message: `从「${from.name}」向「${creditAccount.name}」还款 ${cur()}${formatAmount(amount)}?`, confirmText: '还款' }))) return;
  const now = Date.now();
  const tx: TransactionRow = {
    id: newId(),
    ledger_id: creditAccount.ledger_id,
    user_id: 'local',
    member_id: null,
    type: 'transfer',
    amount,
    currency: 'CNY',
    amount_base: amount,
    exchange_rate: null,
    category_id: null,
    account_id: from.id,
    to_account_id: creditAccount.id,
    happened_at: now,
    note: `信用卡还款 · ${creditAccount.name}`,
    is_refunded: false,
    refund_of_id: null,
    reimburse_status: null,
    exclude_from_budget: false,
    attachment_count: 0,
    source: 'manual',
    client_version: 1,
    server_version: null,
    is_deleted: false,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
  await saveLocal('transaction', tx as unknown as Record<string, unknown>);
}

function AccountEditor({ original, onClose }: { original: AccountRow | null; onClose: () => void }) {
  const [name, setName] = useState(original?.name ?? '');
  const [type, setType] = useState<AccountType>((original?.type as AccountType) ?? 'cash');
  const [initialBalance, setInitialBalance] = useState(original?.initial_balance ?? '0');
  const [includeInNet, setIncludeInNet] = useState(original?.include_in_net ?? true);
  const [isArchived, setIsArchived] = useState(original?.is_archived ?? false);
  const [billDay, setBillDay] = useState(original?.credit_bill_day != null ? String(original.credit_bill_day) : '');
  const [dueDay, setDueDay] = useState(original?.credit_due_day != null ? String(original.credit_due_day) : '');
  const [limit, setLimit] = useState(original?.credit_limit ?? '');
  const [error, setError] = useState<string | null>(null);

  const valid = name.trim().length > 0 && isValidAmount(initialBalance);
  const isCredit = type === 'credit_card';
  const creditValid = !isCredit || (
    (billDay === '' || (/^\d{1,2}$/.test(billDay) && Number(billDay) >= 1 && Number(billDay) <= 31)) &&
    (dueDay === '' || (/^\d{1,2}$/.test(dueDay) && Number(dueDay) >= 1 && Number(dueDay) <= 31)) &&
    (limit === '' || isValidAmount(limit))
  );

  const save = async () => {
    if (!valid) return;
    const now = Date.now();
    let row: AccountRow;
    if (original) {
      row = {
        ...original,
        name: name.trim(),
        type,
        initial_balance: initialBalance,
        include_in_net: includeInNet,
        is_archived: isArchived,
        credit_bill_day: isCredit && billDay !== '' ? Number(billDay) : null,
        credit_due_day: isCredit && dueDay !== '' ? Number(dueDay) : null,
        credit_limit: isCredit && limit !== '' ? limit : null,
        client_version: original.client_version + 1,
        updated_at: now,
      };
    } else {
      row = {
        id: newId(),
        ledger_id: await getActiveLedgerId(),
        name: name.trim(),
        type,
        initial_balance: initialBalance,
        initial_date: now,
        currency: 'CNY',
        include_in_net: includeInNet,
        is_archived: isArchived,
        sort: 100,
        credit_bill_day: isCredit && billDay !== '' ? Number(billDay) : null,
        credit_due_day: isCredit && dueDay !== '' ? Number(dueDay) : null,
        credit_limit: isCredit && limit !== '' ? limit : null,
        balance_cached: null,
        client_version: 1,
        server_version: null,
        is_deleted: false,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      };
    }
    await saveLocal('account', row as unknown as Record<string, unknown>);
    onClose();
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{original ? '编辑账户' : '新增账户'}</h3>
        <div className="field">
          <label>名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如:招行储蓄卡" />
        </div>
        <div className="field">
          <label>类型</label>
          <select value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            {ACCOUNT_TYPES.map((t) => (
              <option key={t} value={t}>{TYPE_ICONS[t]} {ACCOUNT_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>初始余额</label>
          <input value={initialBalance} onChange={(e) => setInitialBalance(e.target.value)} placeholder="0" />
        </div>
        {isCredit && (
          <>
            <div className="filter-pair">
              <div className="field">
                <label>账单日(1–31)</label>
                <input value={billDay} onChange={(e) => setBillDay(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="如 10" />
              </div>
              <div className="field">
                <label>还款日(1–31)</label>
                <input value={dueDay} onChange={(e) => setDueDay(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="如 25" />
              </div>
            </div>
            <div className="field">
              <label>信用额度(可选)</label>
              <input value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="decimal" placeholder="如 30000" />
            </div>
          </>
        )}
        <label className="check-row">
          <input type="checkbox" checked={includeInNet} onChange={(e) => setIncludeInNet(e.target.checked)} />
          计入净值
        </label>
        <label className="check-row">
          <input type="checkbox" checked={isArchived} onChange={(e) => setIsArchived(e.target.checked)} />
          归档(保留历史流水,不计净值)
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="primary" disabled={!valid || !creditValid} onClick={() => void save()}>保存</button>
        <button className="link" onClick={onClose}>取消</button>
      </div>
    </div>
  );
}
