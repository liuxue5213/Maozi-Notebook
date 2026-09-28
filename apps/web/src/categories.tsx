import { useLiveQuery } from 'dexie-react-hooks';
import { newId, type CategoryRow } from '@ledgerone/domain';
import { db } from './db/db';
import { getActiveLedgerId } from './db/seed';
import { enqueue } from './sync/wiring';

/**
 * 分类管理(M03 自定义分类,第 15 轮):新建一级/子分类、重命名、隐藏/显示、删除。
 * 约束:预置分类(is_preset)只可隐藏不可删除;删除自定义分类会级联软删其子分类,
 * 已有流水保留原分类引用(明细对缺失分类优雅降级,不丢数据)。
 */
export function CategoryPanel({ onBack }: { onBack: () => void }) {
  const data = useLiveQuery(async () => {
    const ledgerId = await getActiveLedgerId();
    const cats = (await db.categories.where('ledger_id').equals(ledgerId).toArray())
      .filter((c) => !c.is_deleted) // 墓碑不渲染(LedgerPanel 同款过滤,第 15 轮漏检后补)
      .sort((a, b) => a.sort - b.sort);
    return { ledgerId, tops: cats.filter((c) => !c.parent_id), children: cats.filter((c) => c.parent_id) };
  }, []);
  if (!data) return null;
  const { ledgerId, tops, children } = data;

  const nextSort = (siblings: CategoryRow[]): number => siblings.reduce((m, c) => Math.max(m, c.sort), 0) + 1;

  const create = async (kind: 'expense' | 'income', parentId: string | null = null): Promise<void> => {
    const label = parentId ? '子分类名称' : kind === 'expense' ? '支出分类名称' : '收入分类名称';
    const name = window.prompt(`${label}(可含 emoji 图标前缀,如「🐾 宠物用品」)`);
    if (!name?.trim()) return;
    const siblings = parentId ? children.filter((c) => c.parent_id === parentId) : tops.filter((c) => c.kind === kind);
    const raw = name.trim();
    // 名称带 emoji 前缀时拆出图标:emoji 是代理对,须按首空白切分且前缀不含字母数字(第 15 轮修复 \S 半码元缺陷)
    const sp = raw.indexOf(' ');
    const head = sp > 0 ? raw.slice(0, sp) : '';
    const icon = head && head.length <= 4 && !/[a-zA-Z0-9]/.test(head) ? head : '📦';
    const finalName = sp > 0 && icon !== '📦' ? raw.slice(sp + 1).trim() : raw;
    const row: CategoryRow = {
      id: newId(),
      ledger_id: ledgerId,
      parent_id: parentId,
      name: finalName,
      kind,
      icon,
      color: null,
      sort: nextSort(siblings),
      is_hidden: false,
      is_preset: false,
      client_version: 1, server_version: null, is_deleted: false, deleted_at: null,
      created_at: Date.now(), updated_at: Date.now(),
    };
    await db.categories.put(row);
    enqueue('category', row as unknown as Record<string, unknown>);
  };

  const rename = async (c: CategoryRow): Promise<void> => {
    const name = window.prompt('新的分类名称', c.name);
    if (!name?.trim() || name.trim() === c.name) return;
    const updated: CategoryRow = { ...c, name: name.trim(), client_version: c.client_version + 1, updated_at: Date.now() };
    await db.categories.put(updated);
    enqueue('category', updated as unknown as Record<string, unknown>, 'upsert', c as unknown as Record<string, unknown>);
  };

  const toggleHidden = async (c: CategoryRow): Promise<void> => {
    const updated: CategoryRow = { ...c, is_hidden: !c.is_hidden, client_version: c.client_version + 1, updated_at: Date.now() };
    await db.categories.put(updated);
    enqueue('category', updated as unknown as Record<string, unknown>, 'upsert', c as unknown as Record<string, unknown>);
  };

  const remove = async (c: CategoryRow): Promise<void> => {
    if (c.is_preset) {
      window.alert('预置分类不可删除,可使用「隐藏」将其从选择器收起。');
      return;
    }
    const kids = children.filter((k) => k.parent_id === c.id);
    if (!window.confirm(`删除「${c.name}」${kids.length ? `及其 ${kids.length} 个子分类` : ''}?已有流水保留原分类引用。`)) return;
    const now = Date.now();
    const tomb = (row: CategoryRow): CategoryRow => ({ ...row, is_deleted: true, deleted_at: now, client_version: row.client_version + 1 });
    for (const k of kids) {
      const row = tomb(k);
      await db.categories.put(row);
      enqueue('category', row as unknown as Record<string, unknown>, 'delete');
    }
    const row = tomb(c);
    await db.categories.put(row);
    enqueue('category', row as unknown as Record<string, unknown>, 'delete');
  };

  const kindSections: Array<{ kind: 'expense' | 'income'; label: string }> = [
    { kind: 'expense', label: '支出分类' },
    { kind: 'income', label: '收入分类' },
  ];

  return (
    <div className="me-tab">
      <button className="link back" onClick={onBack}>‹ 返回</button>
      {kindSections.map(({ kind, label }) => {
        const kindTops = tops.filter((t) => t.kind === kind);
        return (
          <div key={kind} className="me-section">
            <div className="me-row static-row">
              <span>{label}</span>
              <button className="mini" onClick={() => void create(kind)}>新建一级</button>
            </div>
            {kindTops.map((t) => {
              const kids = children.filter((k) => k.parent_id === t.id);
              return (
                <div key={t.id} className="me-row cat-mgmt-row">
                  <span>
                    {t.icon} {t.name}
                    {t.is_preset ? <span className="muted small"> · 预置</span> : null}
                    {t.is_hidden ? <span className="muted small"> · 已隐藏</span> : null}
                    {kids.length > 0 && <span className="muted small"> ({kids.length} 子)</span>}
                  </span>
                  <span>
                    <button className="mini" onClick={() => void create(kind, t.id)}>子</button>{' '}
                    <button className="mini" onClick={() => void rename(t)}>改名</button>{' '}
                    <button className="mini" onClick={() => void toggleHidden(t)}>{t.is_hidden ? '显示' : '隐藏'}</button>{' '}
                    {!t.is_preset && <button className="mini danger-text" onClick={() => void remove(t)}>删除</button>}
                  </span>
                </div>
              );
            })}
            {kindTops.filter((t) => !t.is_preset).length === 0 && (
              <div className="me-row static-row">
                <span className="muted small">尚无自定义{kind === 'expense' ? '支出' : '收入'}分类;预置分类可隐藏不可删</span>
              </div>
            )}
          </div>
        );
      })}
      <div className="me-section">
        <div className="me-row static-row">
          <span className="muted small">子分类(一级分类行内「子」按钮创建):{children.map((k) => `${k.icon} ${k.name}`).join(' / ') || '无'}</span>
        </div>
      </div>
    </div>
  );
}
