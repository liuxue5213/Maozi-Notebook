import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { formatAmount, isValidAmount, newId, type TransactionRow, type TransactionType } from '@ledgerone/domain';
import { db } from './db/db';
import { enqueue } from './sync/wiring';
import { fromLocalInputValue, toLocalInputValue } from './utils/period';
import { getActiveLedgerId } from './db/seed';

const TYPE_LABELS: Record<TransactionType, string> = { expense: '支出', income: '收入', transfer: '转账' };

/** P02/P07:流水详情与编辑(全字段)、复制、软删除 */
export function TxEditor({ tx, onClose }: { tx: TransactionRow; onClose: () => void }) {
  const [type, setType] = useState<TransactionType>(tx.type);
  const [amount, setAmount] = useState(tx.amount);
  const [note, setNote] = useState(tx.note ?? '');
  const [happenedAt, setHappenedAt] = useState(toLocalInputValue(tx.happened_at));
  const [categoryId, setCategoryId] = useState(tx.category_id ?? '');
  const [accountId, setAccountId] = useState(tx.account_id);
  const [toAccountId, setToAccountId] = useState(tx.to_account_id ?? '');
  const [excludeBudget, setExcludeBudget] = useState(tx.exclude_from_budget);
  const [error, setError] = useState<string | null>(null);

  // 分类按当前账本作用域(M02 多账本)
  const cats = useLiveQuery(async () => (await db.categories.where('ledger_id').equals(await getActiveLedgerId()).toArray()), []);
  const accounts = useLiveQuery(async () => (await db.accounts.toArray()).filter((a) => !a.is_archived), []);

  const selectedCat = cats?.find((c) => c.id === categoryId) ?? null;
  const selectedTopId = selectedCat ? (selectedCat.parent_id ?? selectedCat.id) : '';
  const tops = (cats ?? []).filter((c) => !c.parent_id && c.kind === (type === 'income' ? 'income' : 'expense') && !c.is_hidden);
  const children = selectedTopId ? (cats ?? []).filter((c) => c.parent_id === selectedTopId) : [];

  const amountValid = isValidAmount(amount) && Number(amount) > 0;
  const valid = amountValid && !!accountId && (type === 'transfer' ? !!toAccountId && toAccountId !== accountId : !!categoryId);

  const save = async () => {
    if (!valid) return;
    const updated: TransactionRow = {
      ...tx,
      type,
      amount,
      amount_base: amount,
      note: note.trim(),
      happened_at: fromLocalInputValue(happenedAt),
      category_id: type === 'transfer' ? null : categoryId,
      account_id: accountId,
      to_account_id: type === 'transfer' ? toAccountId : null,
      exclude_from_budget: excludeBudget,
      client_version: tx.client_version + 1,
      updated_at: Date.now(),
    };
    await db.transactions.put(updated);
    // base = 打开编辑器时所见的行(tx):服务端三方合并的公共祖先,防陈旧字段覆盖并发修改(第 13 轮)
    enqueue('transaction', updated as unknown as Record<string, unknown>, 'upsert', tx as unknown as Record<string, unknown>);
    onClose();
  };

  const duplicate = async () => {
    if (!valid) return;
    const now = Date.now();
    const copy: TransactionRow = {
      ...tx,
      id: newId(),
      type,
      amount,
      amount_base: amount,
      note: note.trim(),
      happened_at: now,
      category_id: type === 'transfer' ? null : categoryId,
      account_id: accountId,
      to_account_id: type === 'transfer' ? toAccountId : null,
      exclude_from_budget: excludeBudget,
      client_version: 1,
      server_version: null,
      is_deleted: false,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
    await db.transactions.put(copy);
    enqueue('transaction', copy as unknown as Record<string, unknown>);
    onClose();
  };

  const remove = async () => {
    if (!window.confirm(`删除该笔 ¥${formatAmount(tx.amount)}?进入回收站保留 30 天,可恢复。`)) return;
    const updated: TransactionRow = {
      ...tx,
      is_deleted: true,
      deleted_at: Date.now(),
      client_version: tx.client_version + 1,
      updated_at: Date.now(),
    };
    await db.transactions.put(updated);
    enqueue('transaction', updated as unknown as Record<string, unknown>, 'delete');
    onClose();
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal tx-editor" onClick={(e) => e.stopPropagation()}>
        <h3>编辑流水</h3>
        <div className="type-toggle">
          {(Object.keys(TYPE_LABELS) as TransactionType[]).map((t) => (
            <button key={t} className={type === t ? 'active' : ''} onClick={() => setType(t)}>{TYPE_LABELS[t]}</button>
          ))}
        </div>
        <div className="field">
          <label>金额</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" />
        </div>
        {type !== 'transfer' ? (
          <>
            <div className="field">
              <label>一级分类</label>
              <select value={selectedTopId} onChange={(e) => setCategoryId(e.target.value)}>
                {tops.map((c) => (
                  <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>二级分类(可选)</label>
              <select value={selectedCat?.parent_id ? selectedCat.id : ''} onChange={(e) => setCategoryId(e.target.value || selectedTopId)}>
                <option value="">不选二级</option>
                {children.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </>
        ) : (
          <div className="transfer-accounts">
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {(accounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <span className="arrow">→</span>
            <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
              {(accounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
        )}
        {type !== 'transfer' && (
          <div className="field">
            <label>账户</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {(accounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label>时间</label>
          <input type="datetime-local" value={happenedAt} onChange={(e) => setHappenedAt(e.target.value)} />
        </div>
        <div className="field">
          <label>备注</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选,500 字内" maxLength={500} />
        </div>
        <label className="check-row">
          <input type="checkbox" checked={excludeBudget} onChange={(e) => setExcludeBudget(e.target.checked)} />
          不计入预算
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="primary" disabled={!valid} onClick={() => void save()}>保存</button>
        <div className="row-actions">
          <button className="mini" onClick={() => void duplicate()} disabled={!valid}>复制一笔</button>
          <button className="danger slim" onClick={() => void remove()}>删除</button>
        </div>
      </div>
    </div>
  );
}
