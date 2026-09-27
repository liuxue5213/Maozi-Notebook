import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  dedupeHash, formatAmount, isValidAmount, newId, parseTextLedger,
  type CategoryRow, type PendingTransactionRow, type TransactionRow,
} from '@ledgerone/domain';
import { db } from './db/db';
import { getActiveLedgerId } from './db/seed';
import { enqueue } from './sync/wiring';
import { defaultMapping, detectSource, findHeaderLineIndex, parseCsv, type ColumnMapping } from './utils/import-csv';

/** 待确认池(P08,M05-F04)+ 账单文件导入向导(M05-F01/F02/F05) */
export function PendingPage({ onBack }: { onBack: () => void }) {
  const [wizard, setWizard] = useState(false);
  const [textImport, setTextImport] = useState(false);

  const model = useLiveQuery(async () => {
    const ledgerId = await getActiveLedgerId();
    const rows = (await db.pending_transactions.toArray())
      .filter((p) => !p.is_deleted && p.ledger_id === ledgerId && p.status === 'pending')
      .sort((a, b) => b.created_at - a.created_at);
    const allCats = await db.categories.toArray();
    const accounts = (await db.accounts.toArray()).filter((a) => !a.is_archived);
    const txs = await db.transactions.toArray();
    return { rows, cats: allCats.filter((c) => c.kind === 'expense' && !c.is_hidden), accounts, txs };
  }, []);

  if (!model) return <div className="muted loading">加载中…</div>;

  return (
    <div className="me-tab">
      <button className="link back" onClick={onBack}>‹ 返回</button>
      <div className="me-section">
        <div className="me-row static-row">
          <span>待确认池</span>
          <span className="muted">{model.rows.length} 条</span>
        </div>
        <div className="me-row static-row">
          <span className="muted small">导入/自动记账生成的记录先入池,确认后才计入统计与预算</span>
        </div>
      </div>
      <button className="primary" onClick={() => setWizard(true)}>📥 导入账单文件(CSV)</button>
      <button className="primary slim-btn" onClick={() => setTextImport(true)}>📝 导入手写账文本</button>

      {model.rows.length > 0 && (
        <div className="pending-actions">
          <button
            className="primary slim-btn"
            onClick={() => void confirmAll(model.rows, model.cats, model.accounts)}
          >
            全部确认({model.rows.length})
          </button>
        </div>
      )}

      {model.rows.map((p) => (
        <PendingRow key={p.id} pending={p} cats={model.cats} accounts={model.accounts} />
      ))}
      {model.rows.length === 0 && (
        <div className="placeholder">
          <div className="placeholder-icon">📥</div>
          <p>待确认池是空的</p>
          <p className="muted">导入支付宝/微信/银行 CSV 账单试试</p>
        </div>
      )}

      {wizard && <ImportWizard onClose={() => setWizard(false)} txs={model.txs} />}
      {textImport && <TextImportModal onClose={() => setTextImport(false)} />}
    </div>
  );
}

/** 确认:待确认 → 正式流水(source=import,计入统计);冲突忽略项保留 30 天由后续清理 */
async function confirmOne(p: PendingTransactionRow, categoryId: string | null, accountId: string, noteOverride?: string): Promise<void> {
  const parsed = (p.parsed ?? {}) as { amount?: string; isExpense?: boolean; happenedAt?: number; merchant?: string; note?: string };
  if (!parsed.amount || !isValidAmount(parsed.amount)) {
    await markStatus(p, 'ignored');
    return;
  }
  const now = Date.now();
  // 用途留空 → 回退默认(商户 · 导入备注);填写了才覆盖
  const provided = noteOverride?.trim();
  const finalNote = (provided ? provided : [parsed.merchant, parsed.note].filter(Boolean).join(' · ')).slice(0, 500);
  const tx: TransactionRow = {
    id: newId(),
    ledger_id: p.ledger_id,
    user_id: 'local',
    member_id: null,
    type: parsed.isExpense === false ? 'income' : 'expense',
    amount: parsed.amount,
    currency: 'CNY',
    amount_base: parsed.amount,
    exchange_rate: null,
    category_id: categoryId,
    account_id: accountId,
    to_account_id: null,
    happened_at: parsed.happenedAt ?? now,
    note: finalNote,
    is_refunded: false,
    refund_of_id: null,
    reimburse_status: null,
    exclude_from_budget: false,
    attachment_count: 0,
    source: 'import',
    client_version: 1,
    server_version: null,
    is_deleted: false,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
  await db.transactions.put(tx);
  enqueue('transaction', tx as unknown as Record<string, unknown>);
  const done: PendingTransactionRow = { ...p, status: 'confirmed', client_version: p.client_version + 1, updated_at: now };
  await db.pending_transactions.put(done);
  enqueue('pending_transaction', done as unknown as Record<string, unknown>);
}

async function markStatus(p: PendingTransactionRow, status: 'ignored'): Promise<void> {
  const now = Date.now();
  const row: PendingTransactionRow = { ...p, status, client_version: p.client_version + 1, updated_at: now };
  await db.pending_transactions.put(row);
  enqueue('pending_transaction', row as unknown as Record<string, unknown>);
}

/** 简单自动分类:商户/备注含分类名,或命中父分类关键词(规则引擎端侧简化,M05-F03);优先更具体(二级) */
function autoCategory(merchantNote: string, cats: CategoryRow[]): string | null {
  if (!merchantNote) return null;
  const byName = cats.find((c) => c.parent_id && merchantNote.includes(c.name));
  if (byName) return byName.id;
  const kwHit = cats.find((c) => !c.parent_id && c.name !== '其他' && merchantNote.includes(c.name));
  if (kwHit) return kwHit.id;
  const kwMap: Array<[RegExp, string]> = [
    [/餐|食|咖|茶|饮|外卖/, '餐饮'],
    [/车|加油|打车|地铁|公交/, '交通'],
    [/店|购|超市/, '购物'],
    [/房租|水电|物业/, '居住'],
  ];
  for (const [re, name] of kwMap) {
    if (re.test(merchantNote)) {
      const top = cats.find((c) => !c.parent_id && c.name === name);
      if (top) return top.id;
    }
  }
  return null;
}

async function confirmAll(rows: PendingTransactionRow[], cats: CategoryRow[], accounts: Array<{ id: string }>): Promise<void> {
  if (!window.confirm(`确认全部 ${rows.length} 条并计入统计?`)) return;
  for (const p of rows) {
    const parsed = (p.parsed ?? {}) as { merchant?: string; note?: string };
    await confirmOne(p, autoCategory(`${parsed.merchant ?? ''}${parsed.note ?? ''}`, cats), accounts[0]?.id ?? '');
  }
}

function PendingRow({ pending, cats, accounts }: {
  pending: PendingTransactionRow;
  cats: CategoryRow[];
  accounts: Array<{ id: string; name: string }>;
}) {
  const [categoryId, setCategoryId] = useState<string>('');
  const [accountId, setAccountId] = useState<string>(accounts[0]?.id ?? '');
  const [note, setNote] = useState<string>('');
  const parsed = (pending.parsed ?? {}) as { amount?: string; isExpense?: boolean; happenedAt?: number; merchant?: string; note?: string };
  const when = parsed.happenedAt ? new Date(parsed.happenedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div className="pending-row">
      <div className="pending-head">
        <div>
          <div className="tx-name">
            {parsed.isExpense === false ? '+' : '-'}¥{formatAmount(parsed.amount ?? '0')}
            {parsed.merchant && <span className="muted"> · {parsed.merchant}</span>}
          </div>
          <div className="tx-sub muted">{when}{parsed.note ? ` · ${parsed.note}` : ''}</div>
        </div>
      </div>
      <div className="pending-controls">
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">未分类</option>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
          ))}
        </select>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </div>
      <input
        className="note-input"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={`用途(默认「${[parsed.merchant, parsed.note].filter(Boolean).join(' · ') || parsed.merchant || '无'}」)`}
        maxLength={50}
      />
      <div className="row-actions">
        <button className="mini" onClick={() => void markStatus(pending, 'ignored')}>忽略</button>
        <button
          className="primary slim-btn"
          onClick={() => void confirmOne(pending, categoryId || null, accountId, note)}
        >
          确认入账
        </button>
      </div>
    </div>
  );
}

type Step = 'file' | 'mapping' | 'review';

function ImportWizard({ onClose, txs }: { onClose: () => void; txs: TransactionRow[] }) {
  const [step, setStep] = useState<Step>('file');
  const [source, setSource] = useState<'alipay' | 'wechat' | 'generic'>('generic');
  const [text, setText] = useState('');
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [preview, setPreview] = useState<{ count: number; from: number; to: number; dupes: number; bad: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadFile = async (file: File): Promise<void> => {
    const t = await file.text();
    setText(t);
    const src = detectSource(t);
    setSource(src);
    const lines = t.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
    const headers = lines[findHeaderLineIndex(lines)] ?? '';
    setMapping(defaultMapping(src, headers.split(',').map((h) => h.trim())));
  };

  /** 预检(M05-F05):条数 / 日期范围 / 可能重复 / 无法识别 */
  const buildPreview = () => {
    if (!mapping) return;
    const r = parseCsv(text, mapping);
    let dupes = 0;
    for (const row of r.rows) {
      const merchant = row.merchant;
      const hit = txs.find(
        (t) => !t.is_deleted && t.amount === row.amount && Math.abs(t.happened_at - row.happenedAt) <= 10 * 60_000 &&
          ((t.note ?? '').includes(merchant) || merchant === ''),
      );
      if (hit) dupes++;
    }
    const times = r.rows.map((x) => x.happenedAt);
    setPreview({
      count: r.rows.length,
      from: times.length ? Math.min(...times) : 0,
      to: times.length ? Math.max(...times) : 0,
      dupes,
      bad: r.skipped,
    });
  };

  const writePending = async (): Promise<void> => {
    if (!mapping) return;
    const r = parseCsv(text, mapping);
    const ledgerId = await getActiveLedgerId();
    const now = Date.now();
    // M05-F05 去重:同账本内 dedupe_hash 已存在(任意状态)则跳过,防止重复导入与撞服务端唯一索引
    const existingHashes = new Set(
      (await db.pending_transactions.toArray())
        .filter((p) => p.ledger_id === ledgerId && p.dedupe_hash)
        .map((p) => p.dedupe_hash),
    );
    let written = 0;
    for (const row of r.rows) {
      const parsed = { amount: row.amount, isExpense: row.isExpense, happenedAt: row.happenedAt, merchant: row.merchant, note: row.note };
      const hash = await dedupeHash({
        amount: row.amount,
        happenedAt: row.happenedAt,
        accountId: 'import',
        merchant: row.merchant,
      });
      if (existingHashes.has(hash)) continue;
      existingHashes.add(hash);
      const p: PendingTransactionRow = {
        id: newId(),
        ledger_id: ledgerId,
        source_type: 'import',
        raw: row.raw,
        parsed,
        confidence: 0.8,
        dedupe_hash: hash,
        status: 'pending',
        client_version: 1,
        server_version: null,
        is_deleted: false,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      };
      await db.pending_transactions.put(p);
      enqueue('pending_transaction', p as unknown as Record<string, unknown>);
      written++;
    }
    window.alert(`已写入 ${written} 条到待确认池${r.rows.length - written > 0 ? `,去重跳过 ${r.rows.length - written} 条` : ''}`);
    onClose();
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal budget-modal" onClick={(e) => e.stopPropagation()}>
        <h3>导入账单</h3>
        {step === 'file' && (
          <>
            <p className="muted small">支持支付宝 / 微信 / 银行导出的 CSV;自动识别来源与列映射。</p>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void loadFile(f).then(() => setStep('mapping'));
              }}
            />
            <button className="primary" onClick={() => fileRef.current?.click()}>选择 CSV 文件</button>
            <button className="link" onClick={onClose}>取消</button>
          </>
        )}
        {step === 'mapping' && mapping && text && (
          <MappingEditor
            headers={(() => {
              const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
              return (lines[findHeaderLineIndex(lines)] ?? '').split(',').map((h) => h.trim());
            })()}
            mapping={mapping}
            onChange={setMapping}
            onNext={() => setStep('review')}
          />
        )}
        {step === 'review' && mapping && (
          <>
            {(() => {
              if (!preview) {
                Promise.resolve().then(() => buildPreview());
              }
              return preview ? (
                <div className="preview-box">
                  <div>共 <b>{preview.count}</b> 条可导入</div>
                  <div className="muted small">
                    日期 {new Date(preview.from).toLocaleDateString('zh-CN')} ~ {new Date(preview.to).toLocaleDateString('zh-CN')}
                  </div>
                  <div className={`muted small ${preview.dupes > 0 ? 'warn-text' : ''}`}>疑似重复 {preview.dupes} 条(±10 分钟同金额)</div>
                  <div className="muted small">无法识别 {preview.bad} 行(将跳过)</div>
                </div>
              ) : (
                <div className="muted small">预检中…</div>
              );
            })()}
            <button className="primary" onClick={() => void writePending()}>写入待确认池</button>
            <button className="link" onClick={() => setStep('mapping')}>‹ 返回调整映射</button>
          </>
        )}
      </div>
    </div>
  );
}

function MappingEditor({ headers, mapping, onChange, onNext }: {
  headers: string[];
  mapping: ColumnMapping;
  onChange: (m: ColumnMapping) => void;
  onNext: () => void;
}) {
  const slots: Array<{ key: import('./utils/import-csv').FieldSlot; label: string }> = [
    { key: 'date', label: '时间' },
    { key: 'amount', label: '金额' },
    { key: 'type', label: '收/支' },
    { key: 'merchant', label: '商户' },
    { key: 'note', label: '备注' },
  ];
  const hasAmount = mapping.slots.includes('amount');

  return (
    <>
      <p className="muted small">列映射:为每列指定含义,金额列必选。</p>
      <div className="mapping-list">
        {headers.map((h, i) => (
          <div key={i} className="mapping-row">
            <div className="mapping-col-name">
              <div className="tx-name">{h || `列${i + 1}`}</div>
            </div>
            <select
              value={mapping.slots[i]}
              onChange={(e) => {
                const slots2 = [...mapping.slots];
                slots2[i] = e.target.value as import('./utils/import-csv').FieldSlot;
                onChange({ slots: slots2 });
              }}
            >
              <option value="none">忽略</option>
              {slots.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <button className="primary" disabled={!hasAmount} onClick={onNext}>下一步:预检</button>
    </>
  );
}

interface TextParsePreview {
  year: number;
  month: number;
  count: number;
  total: string;
  ignored: number;
}

/** 手写账文本导入:粘贴「YYYY M月消费」格式文本 → 解析 → 待确认池 */
function TextImportModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<TextParsePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const parse = () => {
    setError(null);
    setDone(null);
    const r = parseTextLedger(text);
    if (!r.ok) {
      setPreview(null);
      setError(r.reason);
      return;
    }
    const total = r.data.entries.reduce((acc, e) => acc + Number(e.amount), 0);
    setPreview({
      year: r.data.year,
      month: r.data.month,
      count: r.data.entries.length,
      total: total.toFixed(2),
      ignored: r.data.ignoredLines,
    });
  };

  const writePending = async (): Promise<void> => {
    if (!preview) return;
    const r = parseTextLedger(text);
    if (!r.ok) return;
    const ledgerId = await getActiveLedgerId();
    const now = Date.now();
    const existingHashes = new Set(
      (await db.pending_transactions.toArray())
        .filter((p) => p.ledger_id === ledgerId && p.dedupe_hash)
        .map((p) => p.dedupe_hash),
    );
    const daysInMonth = new Date(preview.year, preview.month, 0).getDate();
    let written = 0;
    let skipped = 0;
    let perDaySeq = 0;
    let lastDay = -1;
    for (const e of r.data.entries) {
      if (e.day > daysInMonth || !isValidAmount(e.amount) || Number(e.amount) <= 0) {
        skipped++;
        continue;
      }
      if (e.day !== lastDay) {
        lastDay = e.day;
        perDaySeq = 0;
      }
      const happenedAt = new Date(preview.year, preview.month - 1, e.day, 12, 0).getTime();
      const hash = await dedupeHash({
        amount: e.amount,
        happenedAt,
        accountId: `text#${perDaySeq}`,
        merchant: e.name,
      });
      perDaySeq++;
      if (existingHashes.has(hash)) {
        skipped++;
        continue;
      }
      existingHashes.add(hash);
      const p: PendingTransactionRow = {
        id: newId(),
        ledger_id: ledgerId,
        source_type: 'import',
        raw: `${e.day}  ${e.amount}${e.name}`,
        parsed: { amount: e.amount, isExpense: true, happenedAt, merchant: '', note: e.name },
        confidence: e.name ? 0.7 : 0.4,
        dedupe_hash: hash,
        status: 'pending',
        client_version: 1,
        server_version: null,
        is_deleted: false,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      };
      await db.pending_transactions.put(p);
      enqueue('pending_transaction', p as unknown as Record<string, unknown>);
      written++;
    }
    setDone(`已写入 ${written} 条到待确认池${skipped > 0 ? `,跳过 ${skipped} 条(重复或无效)` : ''}`);
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal budget-modal" onClick={(e) => e.stopPropagation()}>
        <h3>导入手写账文本</h3>
        <p className="muted small">粘贴手写账文本(第一行需为「2026 9月消费」这样的标题);金额后的品名会作为备注;合计行自动跳过并用于核对。</p>
        <textarea
          className="text-preview"
          rows={10}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
            setError(null);
          }}
          placeholder={'2026 9月消费\n\n1  6.3  9.05砂纸  12面\n2  6.3  1.8水'}
        />
        {error && <div className="form-error">{error}</div>}
        {preview && (
          <div className="preview-box">
            <div>共 <b>{preview.count}</b> 笔 · 合计 ¥{formatAmount(preview.total)}</div>
            <div className="muted small">{preview.year} 年 {preview.month} 月 · 无法解析 {preview.ignored} 行</div>
          </div>
        )}
        {!preview && (
          <button className="primary" disabled={!text.trim()} onClick={parse}>解析预览</button>
        )}
        {preview && (
          <button className="primary" onClick={() => void writePending()}>写入待确认池</button>
        )}
        {done && <p className="muted small">{done}</p>}
        <button className="link" onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}
