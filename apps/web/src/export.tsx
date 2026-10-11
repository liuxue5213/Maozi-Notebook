import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ACCOUNT_TYPE_LABELS, computeNetWorth, formatAmount, renderTextLedger,
  type AccountType,
} from '@ledgerone/domain';
import { db } from './db/db';
import { getActiveLedgerId } from './db/seed';
import { buildCsv, downloadText, exportFileName } from './utils/csv';
import { periodRange } from './utils/period';

type Scope = 'all' | 'month' | 'pick';

/** 文本草账(iCloud):生成手写账格式文本,复制进备忘录或下载 .txt 存 iCloud Drive */
function TextLedgerSection({ txs }: { txs: Array<{ happened_at: number }> }) {
  const now = new Date();
  const [ym, setYm] = useState(`${now.getFullYear()}-${now.getMonth() + 1}`);
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const months = (() => {
    const set = new Set<string>([`${now.getFullYear()}-${now.getMonth() + 1}`]);
    for (const t of txs) {
      const d = new Date(t.happened_at);
      set.add(`${d.getFullYear()}-${d.getMonth() + 1}`);
    }
    return [...set].sort().reverse();
  })();

  const generate = () => {
    const [y, m] = ym.split('-').map(Number);
    void (async () => {
      // O5:月份范围下推(单行表原全表扫)
      const ledgerId = await getActiveLedgerId();
      const monthStart = new Date(y, m - 1, 1).getTime();
      const monthEnd = new Date(y, m, 1).getTime();
      const [rows, cats] = await Promise.all([
        db.transactions.where('[ledger_id+happened_at]').between([ledgerId, monthStart], [ledgerId, monthEnd]).toArray(),
        db.categories.where('ledger_id').equals(ledgerId).toArray(),
      ]);
      const catMap = new Map(cats.map((c) => [c.id, c]));
      const text = renderTextLedger(rows, y, m, (id) => catMap.get(id ?? '')?.name ?? '');
      setText(text);
      setCopied(false);
    })();
  };

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      setCopied(true);
    }
  };

  const download = () => {
    if (!text) return;
    const [y, m] = ym.split('-').map(Number);
    downloadText(`${y}年${m}月消费.txt`, text, 'text/plain;charset=utf-8');
  };

  return (
    <div className="me-section">
      <div className="me-row static-row">
        <span>文本草账(手写账格式)</span>
        <span className="muted">按周小计 · 手写账同款</span>
      </div>
      <div className="me-row static-row">
        <span>月份</span>
        <select className="inline-select" value={ym} onChange={(e) => setYm(e.target.value)}>
          {months.map((m) => (
            <option key={m} value={m}>{m.replace('-', ' 年 ')} 月</option>
          ))}
        </select>
      </div>
      <div className="me-row static-row">
        <button className="mini" onClick={generate}>生成文本</button>
        {text && (
          <>
            <button className="mini" onClick={() => void copy()}>{copied ? '已复制 ✓' : '复制全文'}</button>
            <button className="mini" onClick={download}>下载 .txt</button>
          </>
        )}
      </div>
      {text && (
        <textarea className="text-preview" readOnly value={text} rows={14} onFocus={(e) => e.currentTarget.select()} />
      )}
      <div className="me-row static-row">
        <span className="muted small">下载后存入「文件」App(iCloud Drive)即自动同步;或复制后粘贴到备忘录。</span>
      </div>
    </div>
  );
}

/** 导出与备份(M08-F01,P0):CSV 全量导出,永久免费不降级;命名规范见 PRD 流程 F */
export function ExportPage({ onBack }: { onBack: () => void }) {
  const [scope, setScope] = useState<Scope>('all');
  const [pickYm, setPickYm] = useState<string | null>(null);
  const [includeTx, setIncludeTx] = useState(true);
  const [includeAccounts, setIncludeAccounts] = useState(true);
  const [includeCats, setIncludeCats] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const model = useLiveQuery(async () => {
    const ledgerId = await getActiveLedgerId();
    const ledger = await db.ledgers.get(ledgerId);
    // P1-4:导出内容与文件名的账本一致(修复前文件名是当前账本、内容含其它账本);P1-5:软删账户不计净值
    const txs = (await db.transactions.where('ledger_id').equals(ledgerId).toArray()).filter((t) => !t.is_deleted);
    const cats = await db.categories.where('ledger_id').equals(ledgerId).toArray();
    const accounts = (await db.accounts.where('ledger_id').equals(ledgerId).toArray()).filter((a) => !a.is_deleted);
    const summary = computeNetWorth(accounts, txs);
    const times = txs.map((t) => t.happened_at);
    const months: string[] = [];
    const seen = new Set<string>();
    for (const ts of [...times].sort((a, b) => b - a)) {
      const d = new Date(ts);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
      if (!seen.has(key)) {
        seen.add(key);
        months.push(key);
      }
    }
    return {
      ledgerName: ledger?.name ?? '账本',
      txCount: txs.length,
      accountCount: accounts.filter((a) => !a.is_archived).length,
      catCount: cats.length,
      firstAt: times.length ? Math.min(...times) : Date.now(),
      balances: summary.balances,
      txs: txs.map((t) => ({ happened_at: t.happened_at })),
      months,
    };
  });

  if (!model) return <div className="muted loading">加载中…</div>;
  const { months } = model;

  const resolveRange = (): { start: number; end: number } => {
    if (scope === 'month') return periodRange('month');
    if (scope === 'pick') {
      const [y, m] = (pickYm ?? months[0] ?? `${new Date().getFullYear()}-${new Date().getMonth() + 1}`).split('-').map(Number);
      return { start: new Date(y, m - 1, 1).getTime(), end: new Date(y, m, 1).getTime() };
    }
    return { start: model.firstAt, end: Date.now() };
  };

  const doExport = async () => {
    const { start, end } = resolveRange(); // end 为排他上界(下月 1 日 00:00 / 当前时刻)
    const files: string[] = [];
    if (includeTx) {
      const cats = await db.categories.toArray();
      const accounts = await db.accounts.toArray();
      const catMap = new Map(cats.map((c) => [c.id, c]));
      const accMap = new Map(accounts.map((a) => [a.id, a]));
      const rows = (await db.transactions.toArray())
        .filter((t) => !t.is_deleted && t.happened_at >= start && t.happened_at < end)
        .sort((a, b) => a.happened_at - b.happened_at);
      const csv = buildCsv(
        ['时间', '类型', '金额', '币种', '折算金额', '分类', '账户', '转账目标账户', '备注', '来源'],
        rows.map((t) => [
          new Date(t.happened_at).toLocaleString('zh-CN'),
          t.type === 'expense' ? '支出' : t.type === 'income' ? '收入' : '转账',
          t.amount,
          t.currency,
          t.amount_base,
          catMap.get(t.category_id ?? '')?.name ?? '',
          accMap.get(t.account_id)?.name ?? '',
          t.to_account_id ? accMap.get(t.to_account_id)?.name ?? '' : '',
          t.note ?? '',
          t.source,
        ]),
      );
      const name = exportFileName(model.ledgerName, start, end - 1);
      downloadText(name, csv);
      files.push(`${name}(${rows.length} 笔流水)`);
    }
    if (includeAccounts) {
      const accounts = await db.accounts.toArray();
      const csv = buildCsv(
        ['名称', '类型', '初始余额', '当前余额', '币种', '计入净值', '已归档'],
        accounts.map((a) => [
          a.name,
          ACCOUNT_TYPE_LABELS[a.type as AccountType] ?? a.type,
          a.initial_balance,
          model.balances.get(a.id) ?? '0',
          a.currency,
          a.include_in_net ? '是' : '否',
          a.is_archived ? '是' : '否',
        ]),
      );
      const name = exportFileName(`${model.ledgerName}_账户`, start, end - 1);
      downloadText(name, csv);
      files.push(`${name}(${accounts.length} 个账户)`);
    }
    if (includeCats) {
      const cats = await db.categories.toArray();
      const csv = buildCsv(
        ['名称', '层级', '收支', '图标'],
        cats.map((c) => [
          c.name,
          c.parent_id ? '二级' : '一级',
          c.kind === 'expense' ? '支出' : '收入',
          c.icon,
        ]),
      );
      const name = exportFileName(`${model.ledgerName}_分类`, start, end - 1);
      downloadText(name, csv);
      files.push(`${name}(${cats.length} 个分类)`);
    }
    setResult(files.length ? `已生成 ${files.length} 个文件:${files.join('; ')}` : '未选择导出内容');
  };

  return (
    <div className="me-tab">
      <button className="link back" onClick={onBack}>‹ 返回</button>
      <TextLedgerSection txs={model.txs ?? []} />
      <div className="me-section">
        <div className="me-row static-row">
          <span>导出与备份</span>
          <span className="muted">CSV 标准格式</span>
        </div>
        <div className="me-row static-row">
          <span className="muted small">当前账本「{model.ledgerName}」:{model.txCount} 笔流水 · {model.accountCount} 个账户 · {model.catCount} 个分类</span>
        </div>
      </div>
      <div className="me-section">
        <div className="me-row static-row">
          <span>导出范围</span>
          <select className="inline-select" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="all">全部数据</option>
            <option value="month">本月</option>
            <option value="pick">指定月份</option>
          </select>
        </div>
        {scope === 'pick' && (
          <div className="me-row static-row">
            <span>选择月份</span>
            <select className="inline-select" value={pickYm ?? months[0] ?? ''} onChange={(e) => setPickYm(e.target.value)}>
              {months.map((m) => (
                <option key={m} value={m}>{m.replace('-', ' 年 ')} 月</option>
              ))}
            </select>
          </div>
        )}
        <label className="me-row check-row">
          <input type="checkbox" checked={includeTx} onChange={(e) => setIncludeTx(e.target.checked)} />
          流水明细
        </label>
        <label className="me-row check-row">
          <input type="checkbox" checked={includeAccounts} onChange={(e) => setIncludeAccounts(e.target.checked)} />
          账户与余额
        </label>
        <label className="me-row check-row">
          <input type="checkbox" checked={includeCats} onChange={(e) => setIncludeCats(e.target.checked)} />
          分类体系
        </label>
      </div>
      <button className="primary" disabled={!includeTx && !includeAccounts && !includeCats} onClick={() => void doExport()}>
        导出 CSV
      </button>
      {result && <p className="muted small">{result}</p>}
    </div>
  );
}

export function formatAmountForTest(a: string): string {
  return formatAmount(a);
}
