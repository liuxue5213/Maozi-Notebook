import { useLiveQuery } from 'dexie-react-hooks';
import type { LedgerRow } from '@ledgerone/domain';
import { db } from './db/db';
import { createLedgerLocally } from './db/seed';
import { enqueue } from './sync/wiring';
import { getUserId } from './sync/api';

/**
 * 账本管理(M02 多账本,第 14 轮):列表 / 切换(新记账归入)/ 新建 / 重命名 / 删除。
 * 语义说明:Web 端明细/报表跨账本展示,「切换」决定后续记账归入哪个账本(active_ledger)。
 * 删除为级联软删(账本+其流水/分类/账户/预算入回收站或下行墓碑),最后一个账本不可删。
 */
export function LedgerPanel({ onBack }: { onBack: () => void }) {
  const data = useLiveQuery(async () => {
    const ledgers = (await db.ledgers.toArray()).filter((l) => !l.is_deleted);
    const active = (await db.meta.get('active_ledger'))?.value as string | undefined;
    return { ledgers: ledgers.sort((a, b) => a.sort - b.sort || a.created_at - b.created_at), active: active ?? ledgers[0]?.id };
  }, []);
  if (!data) return null;
  const { ledgers, active } = data;

  const switchTo = async (id: string): Promise<void> => {
    await db.meta.put({ key: 'active_ledger', value: id });
  };

  const create = async (): Promise<void> => {
    const name = window.prompt('新账本名称(如:出差账本)');
    if (!name?.trim()) return;
    const id = await createLedgerLocally(name.trim());
    await switchTo(id);
  };

  const rename = async (l: LedgerRow): Promise<void> => {
    const name = window.prompt('新的账本名称', l.name);
    if (!name?.trim() || name.trim() === l.name) return;
    const updated: LedgerRow = { ...l, name: name.trim(), client_version: l.client_version + 1, updated_at: Date.now() };
    await db.ledgers.put(updated);
    enqueue('ledger', updated as unknown as Record<string, unknown>, 'upsert', l as unknown as Record<string, unknown>);
  };

  const remove = async (l: LedgerRow): Promise<void> => {
    if (ledgers.length <= 1) {
      window.alert('至少保留一个账本,不能删除。');
      return;
    }
    const uid = getUserId() ?? 'local';
    if (l.owner_user_id !== 'local' && l.owner_user_id !== uid) {
      window.alert('仅账本所有者可删除。');
      return;
    }
    if (!window.confirm(`删除「${l.name}」?其流水/分类/账户将一并进入回收站(30 天后清除),不可撤销。`)) return;
    const now = Date.now();
    // 级联软删(P1-3 修复,Review):账本 + 名下流水/分类/账户/预算/预算项/周期规则/待确认池,
    // 全部本地软删并**统一以 delete op 上行**—— 修复前 accounts/categories/budgets 用 upsert
    // 携墓碑载荷,服务端 !existing 分支会以 is_deleted:false 落库「复活」无主脏行;
    // delete op 对已存在行写墓碑、对不存在行幂等 noop,语义唯一。
    const mark = <T extends { client_version: number; is_deleted: boolean; deleted_at?: number | null }>(r: T): T => ({
      ...r,
      is_deleted: true,
      deleted_at: now,
      client_version: r.client_version + 1,
    });
    const [txs, accs, cats, budgets, budgetItems, rules, pendings] = await Promise.all([
      db.transactions.where('ledger_id').equals(l.id).toArray(),
      db.accounts.where('ledger_id').equals(l.id).toArray(),
      db.categories.where('ledger_id').equals(l.id).toArray(),
      db.budgets.where('ledger_id').equals(l.id).toArray(),
      db.budget_items.toArray(),
      db.recurring_rules.where('ledger_id').equals(l.id).toArray(),
      db.pending_transactions.where('ledger_id').equals(l.id).toArray(),
    ]);
    const budgetIds = new Set(budgets.map((b) => b.id));
    const items = budgetItems.filter((i) => budgetIds.has(i.budget_id)); // 预算项经 budget 归属账本
    const purge = async (
      table: { put: (row: never) => Promise<unknown> },
      rows: Array<{ client_version: number; is_deleted: boolean; deleted_at?: number | null }>,
      entity: 'transaction' | 'account' | 'category' | 'budget' | 'budget_item' | 'recurring_rule' | 'pending_transaction',
    ): Promise<void> => {
      for (const r of rows) {
        const row = mark(r);
        await table.put(row as never);
        enqueue(entity, row as unknown as Record<string, unknown>, 'delete');
      }
    };
    await purge(db.transactions, txs, 'transaction');
    await purge(db.accounts, accs, 'account');
    await purge(db.categories, cats, 'category');
    await purge(db.budgets, budgets, 'budget');
    await purge(db.budget_items, items, 'budget_item');
    await purge(db.recurring_rules, rules, 'recurring_rule');
    await purge(db.pending_transactions, pendings, 'pending_transaction');
    const ledgerTomb = mark(l);
    await db.ledgers.put(ledgerTomb);
    enqueue('ledger', ledgerTomb as unknown as Record<string, unknown>, 'delete');
    if (active === l.id) {
      const rest = ledgers.find((x) => x.id !== l.id);
      if (rest) await switchTo(rest.id);
    }
  };

  return (
    <div className="me-tab">
      <button className="link back" onClick={onBack}>‹ 返回</button>
      <div className="me-section">
        <div className="me-row static-row">
          <span>账本管理</span>
          <span className="muted">{ledgers.length} 本 · 切换决定新记账归入</span>
        </div>
        {ledgers.map((l) => (
          <div key={l.id} className="me-row">
            <span>{l.icon} {l.name}{l.id === active ? ' · 当前' : ''}</span>
            <span>
              {l.id !== active && <button className="mini" onClick={() => void switchTo(l.id)}>切换</button>}{' '}
              <button className="mini" onClick={() => void rename(l)}>重命名</button>{' '}
              <button className="mini danger-text" onClick={() => void remove(l)}>删除</button>
            </span>
          </div>
        ))}
        <div className="me-row">
          <span className="muted small">新建账本会自动预置分类与默认账户,离线可用、登录后同步</span>
          <button className="mini" onClick={() => void create()}>新建账本</button>
        </div>
      </div>
    </div>
  );
}
