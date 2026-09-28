import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  formatAmount, isValidAmount, newId, parseVoiceInput,
  type CategoryRow, type TransactionRow, type TransactionType, type VoiceParseResult,
} from '@ledgerone/domain';
import { db } from './db/db';
import { getActiveLedgerId } from './db/seed';
import { getBaseCurrency } from './sync/api';
import { enqueue } from './sync/wiring';
import { getUserId } from './sync/api';
import { evaluateExpression } from './calc/evaluator';
import { bumpCategory, categoryFreq } from './state/freq';

const KEYS = ['7', '8', '9', '⌫', '4', '5', '6', '÷', '1', '2', '3', '×', '.', '0', 'C', '+'];

const TYPE_LABELS: Record<TransactionType, string> = { expense: '支出', income: '收入', transfer: '转账' };

/** 快捷模板(M01-F05):名称+金额+分类+账户,设备本地保存 */
interface QuickTemplate {
  id: string;
  name: string;
  amount: string;
  type: TransactionType;
  categoryId: string | null;
  accountId: string;
}

const TPL_KEY = 'lo_templates';

function loadTemplates(): QuickTemplate[] {
  try {
    return JSON.parse(localStorage.getItem(TPL_KEY) ?? '[]') as QuickTemplate[];
  } catch {
    return [];
  }
}

function saveTemplates(tpls: QuickTemplate[]): void {
  localStorage.setItem(TPL_KEY, JSON.stringify(tpls.slice(0, 12)));
}

export function QuickAdd({ onNeedAuth }: { onNeedAuth?: () => void }) {
  const [expr, setExpr] = useState('');
  const [type, setType] = useState<TransactionType>('expense');
  const [selectedCat, setSelectedCat] = useState<string | null>(null);
  const [fromAccount, setFromAccount] = useState<string>('');
  const [toAccount, setToAccount] = useState<string>('');
  const [note, setNote] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [freqTick, setFreqTick] = useState(0);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [templates, setTemplates] = useState<QuickTemplate[]>(() => loadTemplates());

  const categories = useLiveQuery(
    async () => {
      // 分类按当前账本作用域(M02 多账本):避免多账本后选择器出现跨账本重复项
      const ledgerId = await getActiveLedgerId();
      return (await db.categories.where('ledger_id').equals(ledgerId).toArray()).filter(
        (c) => !c.parent_id && !c.is_hidden && c.kind === (type === 'income' ? 'income' : 'expense'),
      );
    },
    [type],
  );
  const children = useLiveQuery(async () => {
    if (!selectedCat) return [];
    const cat = await db.categories.get(selectedCat);
    if (!cat) return [];
    return (await db.categories.where('ledger_id').equals(cat.ledger_id).toArray()).filter((c) => c.parent_id === cat.id && !c.is_hidden);
  }, [selectedCat]);
  const accounts = useLiveQuery(async () => (await db.accounts.toArray()).filter((a) => !a.is_archived), []);

  useEffect(() => {
    setExpr('');
    setSelectedCat(null);
  }, [type]);

  useEffect(() => {
    if (accounts?.length && !fromAccount) setFromAccount(accounts[0].id);
    if (accounts && accounts.length > 1 && !toAccount) setToAccount(accounts[1].id);
  }, [accounts, fromAccount, toAccount]);

  const sorted = useMemo(() => {
    if (!categories) return [];
    const freq = categoryFreq();
    return [...categories].sort((a, b) => (freq[b.id] ?? 0) - (freq[a.id] ?? 0) || a.sort - b.sort);
  }, [categories, freqTick]);

  const value = useMemo(() => (expr ? evaluateExpression(expr) : null), [expr]);
  const valid = !!value && isValidAmount(value) && Number(value) > 0 && (type === 'transfer' ? !!fromAccount && !!toAccount && fromAccount !== toAccount : !!selectedCat);

  const onKey = (k: string) => {
    if (k === 'C') return setExpr('');
    if (k === '⌫') return setExpr((e) => e.slice(0, -1));
    if (/[+\-×÷]/.test(k)) {
      if (!expr) return;
      return setExpr((e) => (/[+\-×÷.]$/.test(e) ? e.slice(0, -1) + k : e + k));
    }
    if (k === '.') {
      const seg = expr.split(/[+\-×÷]/).pop() ?? '';
      if (seg.includes('.')) return;
      if (!seg) return setExpr((e) => e + '0.');
      return setExpr((e) => e + '.');
    }
    const seg = expr.split(/[+\-×÷]/).pop() ?? '';
    if (seg.replace('.', '').length >= 12) return;
    setExpr((e) => e + k);
  };

  const applyVoice = (parsed: VoiceParseResult) => {
    if (!parsed.amount) return;
    setType(parsed.isIncome ? 'income' : 'expense');
    // 切类型后 categories 会异步刷新,用 setTimeout 等一拍再选分类
    const target = parsed.categoryKeyword;
    if (target) {
      setTimeout(() => {
        void (async () => {
          const ledgerId = await getActiveLedgerId();
          const all = await db.categories.where('ledger_id').equals(ledgerId).toArray();
          const hit = all.find((c) => !c.parent_id && c.name === target && !c.is_hidden);
          if (hit) setSelectedCat(hit.id);
        })();
      }, 120);
    }
    setExpr(String(parseFloat(parsed.amount)));
    setVoiceOpen(false);
    setToast(`已解析:${parsed.isIncome ? '收入' : '支出'} ¥${formatAmount(parsed.amount)}${target ? ` · ${target}` : ''},请确认后保存`);
  };

  const save = async () => {
    if (!valid || !value) return;
    const ledgerId = await getActiveLedgerId();
    if (!ledgerId) return;
    const now = Date.now();
    const cleanNote = note.trim();
    const tx: TransactionRow = {
      id: newId(),
      ledger_id: ledgerId,
      user_id: getUserId() ?? 'local',
      member_id: null,
      type,
      amount: value,
      currency: getBaseCurrency(), // 主币种即记账币种(M16/账号设置,第 16 轮)
      amount_base: value,
      exchange_rate: null,
      category_id: type === 'transfer' ? null : selectedCat,
      account_id: type === 'transfer' ? fromAccount : fromAccount || (accounts?.[0]?.id ?? ''),
      to_account_id: type === 'transfer' ? toAccount : null,
      happened_at: now,
      note: cleanNote,
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
    await db.transactions.put(tx);
    enqueue('transaction', tx as unknown as Record<string, unknown>); // 本地写入即入队,同步在后台(PRD 流程 A)
    if (tx.category_id) {
      bumpCategory(tx.category_id);
      setFreqTick((t) => t + 1);
    }
    const catName = type === 'transfer' ? '转账' : (categories?.find((c) => c.id === selectedCat)?.name ?? '');
    const label = cleanNote ? `${cleanName(cleanNote)}(${catName})` : catName;
    setToast(`已记入${label} ¥${formatAmount(value)}`);
    setExpr('');
    setSelectedCat(null);
    setNote('');
  };

  const cleanName = (s: string) => s.slice(0, 20);

  const saveTemplate = () => {
    if (!valid || !value) return;
    const name = window.prompt('模板名称(如:每天咖啡)', catNameOf(selectedCat, categories) || '快捷模板');
    if (!name) return;
    const tpl: QuickTemplate = {
      id: newId(),
      name,
      amount: value,
      type,
      categoryId: type === 'transfer' ? null : selectedCat,
      accountId: fromAccount || (accounts?.[0]?.id ?? ''),
    };
    const next = [tpl, ...loadTemplates()];
    saveTemplates(next);
    setTemplates(next);
    setToast(`已存模板「${name}」`);
  };

  const applyTemplate = (tpl: QuickTemplate) => {
    setType(tpl.type);
    setExpr(String(parseFloat(tpl.amount)));
    if (tpl.categoryId) setSelectedCat(tpl.categoryId);
    if (tpl.accountId) setFromAccount(tpl.accountId);
    setToast(`模板「${tpl.name}」已预填`);
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="quickadd">
      <div className="type-toggle">
        {(Object.keys(TYPE_LABELS) as TransactionType[]).map((t) => (
          <button key={t} className={type === t ? 'active' : ''} onClick={() => setType(t)}>
            {TYPE_LABELS[t]}
          </button>
        ))}
      </div>

      {templates.length > 0 && (
        <div className="tpl-row">
          {templates.slice(0, 5).map((t) => (
            <button key={t.id} className="chip tpl-chip" onClick={() => applyTemplate(t)}>
              {t.name} ¥{formatAmount(t.amount)}
            </button>
          ))}
        </div>
      )}

      <div className="amount-display">
        <span className="currency">¥</span>
        <span className={expr ? '' : 'placeholder'}>{expr || '0'}</span>
        {expr && /[+\-×÷]/.test(expr) && <span className="preview">= {value ?? '错误'}</span>}
        <button className="mic-btn" title="语音记账" onClick={() => setVoiceOpen(true)}>🎤</button>
      </div>

      <input
        className="note-input"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="用途(可选,如 砂纸 / 午餐 / 买东西)"
        maxLength={50}
      />

      {type === 'transfer' ? (
        <div className="transfer-accounts">
          <select value={fromAccount} onChange={(e) => setFromAccount(e.target.value)}>
            {(accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <span className="arrow">→</span>
          <select value={toAccount} onChange={(e) => setToAccount(e.target.value)}>
            {(accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
      ) : (
        <>
          <div className="category-grid">
            {sorted.slice(0, 16).map((c) => (
              <button
                key={c.id}
                className={selectedCat === c.id ? 'selected' : ''}
                onClick={() => setSelectedCat(c.id)}
              >
                <span className="cat-icon">{c.icon}</span>
                <span className="cat-name">{c.name}</span>
              </button>
            ))}
          </div>
          {!!children?.length && (
            <div className="child-chips">
              {children.map((c) => (
                <button key={c.id} className={`chip ${selectedCat === c.id ? 'selected' : ''}`} onClick={() => setSelectedCat(c.id)}>
                  {c.name}
                </button>
              ))}
              {selectedCat && (
                <button className="chip" onClick={() => setSelectedCat(null)}>仅记一级</button>
              )}
            </div>
          )}
        </>
      )}

      <div className="keypad">
        {KEYS.map((k) => (
          <button key={k} className={/[+\-×÷]/.test(k) || k === '⌫' || k === 'C' ? 'fn' : ''} onClick={() => onKey(k)}>
            {k}
          </button>
        ))}
      </div>
      <button className="save-btn" disabled={!valid} onClick={() => void save()}>
        保存{value && valid ? ` ¥${formatAmount(value)}` : ''}
      </button>
      <button className="tpl-save link" disabled={!valid} onClick={saveTemplate}>存为模板</button>

      {toast && <div className="toast">{toast}</div>}
      {voiceOpen && (
        <VoiceModal
          onClose={() => setVoiceOpen(false)}
          onApply={applyVoice}
        />
      )}
    </div>
  );
}

function catNameOf(id: string | null, cats?: CategoryRow[]): string {
  if (!id) return '';
  return cats?.find((c) => c.id === id)?.name ?? '';
}

/** 语音记账(M01-F03 + I05/I06):优先 Web Speech 端侧识别,不可用退化为文字输入;解析结果仅预填,保存即二次确认 */
function VoiceModal({ onClose, onApply }: { onClose: () => void; onApply: (p: VoiceParseResult) => void }) {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recogRef = useRef<{ start: () => void; stop: () => void } | null>(null);

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown };
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) return;
    setSupported(true);
    const r = new SR() as {
      lang: string; interimResults: boolean; continuous: boolean;
      onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
      onend: () => void; onerror: () => void; start: () => void; stop: () => void;
    };
    r.lang = 'zh-CN';
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e) => {
      const t = Array.from({ length: e.results.length }, (_, i) => e.results[i][0].transcript).join('');
      setText(t);
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recogRef.current = r;
  }, []);

  const toggleListen = () => {
    const r = recogRef.current;
    if (!r) return;
    if (listening) {
      r.stop();
    } else {
      setError(null);
      setListening(true);
      r.start();
    }
  };

  const apply = () => {
    if (!text.trim()) return;
    const parsed = parseVoiceInput(text);
    if (!parsed.amount) {
      setError('没听清金额,试试「买咖啡 26 块」');
      return;
    }
    onApply(parsed);
  };

  const parsed = text.trim() ? parseVoiceInput(text) : null;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal budget-modal" onClick={(e) => e.stopPropagation()}>
        <h3>语音记账</h3>
        {supported ? (
          <button className={`voice-btn ${listening ? 'listening' : ''}`} onClick={toggleListen}>
            {listening ? '正在聆听… 点按结束' : '🎤 点按说话'}
          </button>
        ) : (
          <p className="muted small">当前浏览器不支持语音识别(I05 端侧优先),直接输入文字解析:</p>
        )}
        <div className="field">
          <label>或输入「买咖啡 26 块」</label>
          <input value={text} onChange={(e) => { setText(e.target.value); setError(null); }} placeholder="买咖啡 26 块" />
        </div>
        {parsed && parsed.amount && (
          <div className="preview-box">
            <div>解析预览(保存前可修改):</div>
            <div className="muted small">
              {parsed.isIncome ? '收入' : '支出'} ¥{formatAmount(parsed.amount)}
              {parsed.categoryKeyword ? ` · ${parsed.categoryKeyword}` : ' · 未识别分类'}
            </div>
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        <button className="primary" disabled={!text.trim()} onClick={apply}>解析并预填</button>
        <button className="link" onClick={onClose}>取消</button>
      </div>
    </div>
  );
}
