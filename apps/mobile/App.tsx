import './src/lib/polyfills';
import { buildBudgetModel, type BudgetModel } from '@ledgerone/ledger-core';
import { isValidAmount } from '@ledgerone/domain'; // 必须最先:uuid@14 裸用全局 crypto,Hermes 没有,必须先垫上
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatAmount, newId, type TransactionRow, type TransactionType } from '@ledgerone/domain';
import { useSyncExternalStore } from 'react';
import { engine, scheduleSync, snapshot, startMobileAutoSync } from './src/lib/sync';
import { initDb, listRecent, saveTx, topCategories, getActiveLedgerId, metaGet, metaSet, db } from './src/lib/store';
import { resetLocalDatabase } from './src/lib/db';
import { prepareAfterLogin, saveLocal } from '@ledgerone/sqlite-sync';
import { authApi, clearSession, getServerUrl, isLoggedIn, logout as logoutAll, saveSession, setServerUrl, SERVER_PRESETS, resolveServerUrl } from './src/lib/api';

type Tab = 'record' | 'list' | 'report' | 'me';

interface Cat {
  id: string;
  name: string;
  icon: string;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <View style={{ flex: 1, padding: 24, paddingTop: 60, backgroundColor: '#fff' }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: '#c0392b', marginBottom: 12 }}>启动出错</Text>
          <Text style={{ fontSize: 12, color: '#333', fontFamily: 'monospace' }}>{String(this.state.err.stack || this.state.err.message || this.state.err)}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

function AppInner() {
  const insets = useSafeAreaInsets();
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('record');
  const [txs, setTxs] = useState<TransactionRow[]>([]);
  const sync = useSyncExternalStore(engine.subscribe, snapshot);
  const [logged, setLogged] = useState(false);
  const [loading, setLoading] = useState('加载中…');

  const refreshTxs = useCallback(async () => {
    setTxs((await listRecent()) as unknown as TransactionRow[]);
  }, []);

  const [bootErr, setBootErr] = useState<string | null>(null);

  const boot = useCallback(async () => {
    setBootErr(null);
    setLoading('加载中…');
    const watchdog = setTimeout(() => setBootErr('初始化超时(20秒)——请点「重试」;若反复出现,请重启手机(系统安全区无响应)或「重置本地数据」'), 20000);
    try {
      await initDb();
      await refreshTxs();
      setLogged(await isLoggedIn());
      setReady(true);
      startMobileAutoSync(); // P0-2:定时兜底 + 进前台补同步
    } catch (e) {
      setBootErr(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(watchdog);
    }
  }, [refreshTxs]);

  useEffect(() => { void boot(); }, [boot]);

  if (bootErr) {
    return (
      <View style={styles.center}>
        <Text style={{ color: '#c0392b', fontSize: 15, fontWeight: '700', marginBottom: 10 }}>初始化失败</Text>
        <Text style={{ ...styles.muted, textAlign: 'center', paddingHorizontal: 24, fontSize: 11 }}>{bootErr}</Text>
        <Pressable style={{ ...styles.saveBtn, marginTop: 16, minWidth: 180 }} onPress={() => void boot()}>
          <Text style={styles.saveText}>重试</Text>
        </Pressable>
        <Pressable
          style={{ marginTop: 10 }}
          onPress={() => { void resetLocalDatabase().finally(() => { setReady(false); void boot(); }); }}
        >
          <Text style={{ color: '#c0392b', fontSize: 13 }}>重置本地数据(清除全部离线记录)</Text>
        </Pressable>
      </View>
    );
  }

  if (!ready) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>{loading}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.app, { paddingTop: insets.top }]}>
      <Text style={styles.title}>帽子记账本</Text>
      <View style={styles.content}>
        {tab === 'record' && (
          <RecordScreen onSaved={() => void refreshTxs()} />
        )}
        {tab === 'list' && <ListScreen />}
        {tab === 'report' && <ReportScreen />}
        {tab === 'me' && <MeScreen logged={logged} onLogged={(v) => setLogged(v)} syncText={`${sync.state}${sync.pending > 0 ? ` · 待同步 ${sync.pending}` : ''}`} />}
      </View>
      <View style={[styles.tabbar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {([
          ['record', '记账'],
          ['list', '明细'],
          ['report', '报表'],
          ['me', '我的'],
        ] as Array<[Tab, string]>).map(([key, label]) => (
          <Pressable key={key} style={[styles.tabBtn, tab === key && styles.tabBtnActive]} onPress={() => setTab(key)}>
            <Text style={[styles.tabLabel, tab === key && styles.tabLabelActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function BudgetCard() {
  const [model, setModel] = useState<BudgetModel | null>(null);
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [catDrafts, setCatDrafts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const loadModel = async () => {
    await initDb();
    const ledgerId = await getActiveLedgerId();
    if (!ledgerId) return;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
    const [budgets, budgetItems, transactions, categories] = await Promise.all([
      db.getAllAsync<Record<string, unknown>>('SELECT * FROM budgets WHERE is_deleted = 0'),
      db.getAllAsync<Record<string, unknown>>('SELECT * FROM budget_items WHERE is_deleted = 0'),
      db.getAllAsync<Record<string, unknown>>('SELECT * FROM transactions WHERE is_deleted = 0'),
      db.getAllAsync<Record<string, unknown>>('SELECT * FROM categories WHERE is_deleted = 0'),
    ]);
    setModel(buildBudgetModel({
      budgets: budgets as never, budgetItems: budgetItems as never,
      transactions: transactions as never, categories: categories as never,
      ledgerId, periodStart: start, periodEnd: end, prevPeriodStart: prevStart,
    }));
  };

  useEffect(() => { void loadModel(); }, []);

  const openEdit = () => {
    const b = model?.budget;
    setAmount(b?.total_amount ?? '');
    setCatDrafts(Object.fromEntries((model?.items ?? []).map((i: unknown) => {
      const rec = i as unknown as Record<string, unknown>;
      return [String(rec.category_id), String(rec.amount)];
    })));
    setEditing(true);
  };

  const saveEdit = async () => {
    const ledgerId = await getActiveLedgerId();
    if (!ledgerId || !isValidAmount(amount) || Number(amount) <= 0) return;
    const now = Date.now();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    const b = model?.budget;
    const row = b
      ? { ...b, total_amount: amount, client_version: Number((b as unknown as Record<string, unknown>).client_version ?? 0) + 1, updated_at: now }
      : { id: newId(), ledger_id: ledgerId, period_type: 'monthly', period_start: monthStart, total_amount: amount, currency: 'CNY', rollover: false, client_version: 1, server_version: null, is_deleted: false, deleted_at: null, created_at: now, updated_at: now };
    await saveLocal(db, 'budget', row as never);
    for (const item of model?.items ?? []) {
      const rec = item as unknown as Record<string, unknown>;
      const cid = String(rec.category_id);
      const draft = (catDrafts[cid] ?? '').trim();
      if (draft === '') {
        await saveLocal(db, 'budget_item', { ...rec, is_deleted: true, deleted_at: now, client_version: Number(rec.client_version ?? 0) + 1, updated_at: now } as never, { op: 'delete' });
      } else if (isValidAmount(draft) && Number(draft) > 0 && rec.amount !== draft) {
        await saveLocal(db, 'budget_item', { ...rec, amount: draft, client_version: Number(rec.client_version ?? 0) + 1, updated_at: now } as never);
      }
    }
    setEditing(false);
    setMsg('预算已更新');
    setTimeout(() => setMsg(null), 1500);
    await loadModel();
  };

  const view = model?.adjusted;
  if (!view) {
    return (
      <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 10 }}>
        <Pressable onPress={() => setEditing(true)}>
          <Text style={{ color: '#8a93a5', fontSize: 13 }}>📅 设置本月预算,控制花钱节奏</Text>
        </Pressable>
        {editing && (
          <View style={{ marginTop: 10, gap: 8 }}>
            <TextInput style={styles.input} value={amount} onChangeText={(t) => setAmount(t.replace(/[^\\d.]/g, ''))} keyboardType="decimal-pad" placeholder="月度总预算,如 5000" placeholderTextColor="#b4bac6" />
            <Pressable style={[styles.saveBtn, !amount && styles.disabled]} onPress={() => void saveEdit()}>
              <Text style={styles.saveText}>保存预算</Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  }
  return (
    <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 10 }}>
      <Pressable onPress={() => setEditing((v) => !v)}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1a1c23' }}>本月预算 ¥{formatAmount(view.total)}</Text>
          <Text style={{ fontSize: 12, color: view.level === 'over' ? '#d64545' : view.level === 'warn' ? '#e67e22' : '#1f9d6c' }}>{view.pct}%</Text>
        </View>
        <View style={{ height: 6, backgroundColor: '#eef0f6', borderRadius: 3, marginVertical: 6 }}>
          <View style={{ height: 6, width: `${Math.min(view.pct, 100)}%`, backgroundColor: view.level === 'over' ? '#d64545' : view.level === 'warn' ? '#e67e22' : '#1f9d6c', borderRadius: 3 }} />
        </View>
        <Text style={{ fontSize: 11, color: '#8a93a5' }}>已用 ¥{formatAmount(view.used)} · 剩余 ¥{formatAmount(view.remaining)} · 点此编辑</Text>
      </Pressable>
      {editing && (
        <View style={{ marginTop: 10, gap: 8 }}>
          <TextInput style={styles.input} value={amount} onChangeText={(t) => setAmount(t.replace(/[^\\d.]/g, ''))} keyboardType="decimal-pad" placeholder="月度总预算" placeholderTextColor="#b4bac6" />
          {(model?.items ?? []).map((it: unknown) => {
            const rec = it as unknown as Record<string, unknown>;
            const cid = String(rec.category_id);
            return (
              <View key={cid} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 12, color: '#4a5160', width: 70 }}>分类额度</Text>
                <TextInput style={{ ...styles.input, flex: 1, minHeight: 38 }} value={catDrafts[cid] ?? ''} onChangeText={(t) => setCatDrafts((d) => ({ ...d, [cid]: t.replace(/[^\\d.]/g, '') }))} keyboardType="decimal-pad" placeholder="不限" placeholderTextColor="#b4bac6" />
              </View>
            );
          })}
          <Pressable style={styles.saveBtn} onPress={() => void saveEdit()}>
            <Text style={styles.saveText}>保存预算</Text>
          </Pressable>
        </View>
      )}
      {msg && <Text style={{ fontSize: 11, color: '#1f9d6c', marginTop: 6 }}>{msg}</Text>}
    </View>
  );
}

function RecordScreen({ onSaved }: { onSaved: () => void }) {
  const [type, setType] = useState<TransactionType>('expense');
  const [amount, setAmount] = useState('');
  const [cats, setCats] = useState<Cat[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newCat, setNewCat] = useState('');

  const refreshCats = async () => {
    setCats((await topCategories(type === 'income' ? 'income' : 'expense')) as unknown as Cat[]);
  };

  useEffect(() => {
    void initDb().then(async () => {
      setAdding(false);
      setNewCat('');
      await refreshCats();
    });
  }, [type]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 快速新增分类:输入名字即存(本地即时生效,联网经 outbox 自动同步),并自动选中 */
  const addCategory = async () => {
    const name = newCat.trim().slice(0, 20);
    if (!name) { setAdding(false); return; }
    await initDb();
    const ledgerId = await getActiveLedgerId();
    if (!ledgerId) return;
    const dup = cats.find((c) => c.name === name);
    if (dup) { setSelected(dup.id); setNewCat(''); setAdding(false); return; }
    const now = Date.now();
    const row = {
      id: newId(), ledger_id: ledgerId, parent_id: null, name, kind: type === 'income' ? 'income' : 'expense',
      icon: '🏷️', color: null, sort: now, is_hidden: false, is_preset: false,
      client_version: 1, server_version: null, is_deleted: false, deleted_at: null, created_at: now, updated_at: now,
    };
    await saveLocal(db, 'category', row as never);
    await refreshCats();
    setSelected(row.id);
    setNewCat('');
    setAdding(false);
    scheduleSync();
  };

  const save = async () => {
    const v = Number(amount);
    if (!v || v <= 0 || !selected) return;
    const ledgerId = await getActiveLedgerId();
    if (!ledgerId) return;
    const now = Date.now();
    const tx = {
      id: newId(), ledger_id: ledgerId, user_id: 'local', member_id: null, type,
      amount: v.toFixed(2), currency: 'CNY', amount_base: v.toFixed(2), exchange_rate: null,
      category_id: selected, account_id: (await db.getAllAsync<{ id: string }>('SELECT id FROM accounts WHERE is_deleted = 0 ORDER BY sort LIMIT 1'))[0]?.id ?? '',
      to_account_id: null, happened_at: now, note: '', is_refunded: 0, refund_of_id: null,
      reimburse_status: null, exclude_from_budget: 0, attachment_count: 0, source: 'manual',
      client_version: 1, server_version: null, is_deleted: 0, deleted_at: null, created_at: now, updated_at: now,
    };
    await saveTx(tx);
    scheduleSync();
    setAmount('');
    setSelected(null);
    setMsg(`已记入 ¥${v.toFixed(2)}`);
    onSaved();
    setTimeout(() => setMsg(null), 1800);
  };

  return (
    <ScrollView contentContainerStyle={styles.form}>
      <View style={styles.typeRow}>
        {(['expense', 'income'] as TransactionType[]).map((t) => (
          <Pressable key={t} style={[styles.typeBtn, type === t && styles.typeBtnActive]} onPress={() => { setType(t); setSelected(null); }}>
            <Text style={[styles.typeText, type === t && styles.typeTextActive]}>{t === 'expense' ? '支出' : '收入'}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        style={styles.amountInput}
        value={amount}
        onChangeText={(t) => setAmount(t.replace(/[^\d.]/g, ''))}
        keyboardType="decimal-pad"
        placeholder="0.00"
        placeholderTextColor="#b4bac6"
      />
      <View style={styles.catGrid}>
        {cats.map((c) => (
          <Pressable key={c.id} style={[styles.catBtn, selected === c.id && styles.catBtnActive]} onPress={() => setSelected(c.id)}>
            <Text style={styles.catIcon}>{c.icon}</Text>
            <Text style={styles.catName}>{c.name}</Text>
          </Pressable>
        ))}
        {!adding ? (
          <Pressable style={styles.catBtn} onPress={() => setAdding(true)}>
            <Text style={styles.catIcon}>＋</Text>
            <Text style={styles.catName}>新增</Text>
          </Pressable>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginVertical: 6 }}>
            <TextInput
              style={{ ...styles.input, flex: 1, minHeight: 40 }}
              value={newCat}
              autoFocus
              onChangeText={(t) => setNewCat(t.slice(0, 20))}
              placeholder="新分类名(如 宠物医疗)"
              placeholderTextColor="#b4bac6"
              onSubmitEditing={() => void addCategory()}
            />
            <Pressable style={{ ...styles.saveBtn, paddingHorizontal: 14, paddingVertical: 8 }} onPress={() => void addCategory()}>
              <Text style={styles.saveText}>保存</Text>
            </Pressable>
          </View>
        )}
      </View>
      <Pressable style={[styles.saveBtn, (!amount || !selected) && styles.disabled]} onPress={() => void save()}>
        <Text style={styles.saveText}>保存{amount && selected ? ` ¥${formatAmount(amount)}` : ''}</Text>
      </Pressable>
      {msg && <Text style={styles.msg}>{msg}</Text>}
    </ScrollView>
  );
}

function monthRange(offset: number): { start: number; end: number; label: string } {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - offset);
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  const label = `${d.getFullYear()}年${d.getMonth() + 1}月`;
  return { start, end, label };
}

const PAGE = 50;

function ListScreen() {
  const [rows, setRows] = useState<Array<TransactionRow & { cat_name?: string; cat_icon?: string }>>([]);
  const [offset, setOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const [typeFilter, setTypeFilter] = useState<'all' | 'expense' | 'income'>('all');
  const [kw, setKw] = useState('');
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [monthSum, setMonthSum] = useState<{ income: number; expense: number }>({ income: 0, expense: 0 });
  const mr = monthRange(monthOffset);

  const load = async (off: number, replace: boolean) => {
    setBusy(true);
    try {
      await initDb();
      const ledgerId = await getActiveLedgerId();
      if (!ledgerId) return;
      const clauses = ['t.is_deleted = 0', 't.ledger_id = ?', 't.happened_at >= ?', 't.happened_at < ?'];
      const params: Array<string | number> = [ledgerId, mr.start, mr.end];
      if (typeFilter !== 'all') { clauses.push('t.type = ?'); params.push(typeFilter); }
      if (kw.trim()) { clauses.push('(t.note LIKE ? OR c.name LIKE ?)'); params.push(`%${kw.trim()}%`, `%${kw.trim()}%`); }
      const where = clauses.join(' AND ');
      const got = await db.getAllAsync<TransactionRow & { cat_name?: string; cat_icon?: string }>(
        `SELECT t.*, c.name AS cat_name, c.icon AS cat_icon FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id WHERE ${where}
         ORDER BY t.happened_at DESC LIMIT ? OFFSET ?`,
        [...params, off, PAGE],
      );
      setRows((prev) => (replace ? got : [...prev, ...got]));
      setHasMore(got.length === PAGE);
      const sums = await db.getAllAsync<{ type: string; s: number }>(
        `SELECT type, SUM(CAST(amount AS REAL)) AS s FROM transactions t WHERE ${where} GROUP BY type`, params);
      setMonthSum({
        income: Number(sums.find((r) => r.type === 'income')?.s ?? 0),
        expense: Number(sums.find((r) => r.type === 'expense')?.s ?? 0),
      });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { setOffset(0); void load(0, true); }, [monthOffset, typeFilter, kw]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 8 }}>
        <Pressable onPress={() => setMonthOffset((m) => m + 1)}><Text style={{ fontSize: 18, color: '#4a5160' }}>‹</Text></Pressable>
        <Text style={{ fontWeight: '700', color: '#1a1c23' }}>{monthOffset === 0 ? '本月' : mr.label}</Text>
        {monthOffset > 0
          ? <Pressable onPress={() => setMonthOffset((m) => Math.max(0, m - 1))}><Text style={{ fontSize: 18, color: '#4a5160' }}>›</Text></Pressable>
          : <Text style={{ fontSize: 18, color: 'transparent' }}>›</Text>}
      </View>
      <View style={{ flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 6, gap: 8 }}>
        {(['all', 'expense', 'income'] as const).map((t) => (
          <Pressable key={t} onPress={() => setTypeFilter(t)}
            style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12, backgroundColor: typeFilter === t ? '#4361ee' : '#eef0f6' }}>
            <Text style={{ fontSize: 12, color: typeFilter === t ? '#fff' : '#4a5160' }}>{t === 'all' ? '全部' : t === 'expense' ? '支出' : '收入'}</Text>
          </Pressable>
        ))}
        <TextInput
          style={{ flex: 1, minHeight: 30, backgroundColor: '#eef0f6', borderRadius: 12, paddingHorizontal: 10, fontSize: 12, color: '#1a1c23', paddingVertical: 4 }}
          value={kw} onChangeText={(t) => setKw(t)} placeholder="搜备注/分类" placeholderTextColor="#b4bac6"
        />
      </View>
      <View style={{ flexDirection: 'row', paddingHorizontal: 14, paddingBottom: 6, gap: 16 }}>
        <Text style={{ fontSize: 12, color: '#1f9d6c' }}>收 ¥{formatAmount(String(monthSum.income))}</Text>
        <Text style={{ fontSize: 12, color: '#d64545' }}>支 ¥{formatAmount(String(monthSum.expense))}</Text>
        {busy && <Text style={{ fontSize: 12, color: '#8a93a5' }}>加载中…</Text>}
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}>
        {rows.map((t) => (
          <View key={t.id} style={styles.txRow}>
            <View style={styles.txMain}>
              <Text style={styles.txNote}>{t.note || t.cat_name || (t.type === 'income' ? '收入' : '支出')}</Text>
              <Text style={styles.txDate}>{new Date(t.happened_at).toLocaleString('zh-CN')}{t.cat_name ? ` · ${t.cat_name}` : ''}</Text>
            </View>
            <Text style={[styles.txAmount, { color: t.type === 'income' ? '#1f9d6c' : '#1a1c23' }]}>
              {t.type === 'income' ? '+' : '-'}¥{formatAmount(String(t.amount))}
            </Text>
          </View>
        ))}
        {rows.length === 0 && !busy && <Text style={styles.muted}>本月暂无流水</Text>}
        {hasMore && (
          <Pressable style={{ alignItems: 'center', padding: 10 }} onPress={() => { const n = offset + PAGE; setOffset(n); void load(n, false); }}>
            <Text style={{ color: '#4361ee', fontSize: 13 }}>加载更多</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

function ReportScreen() {
  const [monthOffset, setMonthOffset] = useState(0);
  const [sum, setSum] = useState({ income: 0, expense: 0 });
  const [byCat, setByCat] = useState<Array<{ name: string; icon: string; total: number; pct: number }>>([]);
  const [busy, setBusy] = useState(false);
  const mr = monthRange(monthOffset);

  const load = async () => {
    setBusy(true);
    try {
      await initDb();
      const ledgerId = await getActiveLedgerId();
      if (!ledgerId) return;
      const base = 't.is_deleted = 0 AND t.ledger_id = ? AND t.happened_at >= ? AND t.happened_at < ?';
      const bparams: Array<string | number> = [ledgerId, mr.start, mr.end];
      const sums = await db.getAllAsync<{ type: string; s: number }>(
        `SELECT type, SUM(CAST(amount AS REAL)) AS s FROM transactions t WHERE ${base} GROUP BY type`, bparams);
      setSum({
        income: Number(sums.find((r) => r.type === 'income')?.s ?? 0),
        expense: Number(sums.find((r) => r.type === 'expense')?.s ?? 0),
      });
      const cats = await db.getAllAsync<{ name: string; icon: string; s: number }>(
        `SELECT COALESCE(c.name, '未分类') AS name, COALESCE(c.icon, '📦') AS icon,
                SUM(CAST(t.amount AS REAL)) AS s
         FROM transactions t LEFT JOIN categories c ON t.category_id = c.id
         WHERE ${base} AND t.type = 'expense' GROUP BY t.category_id ORDER BY s DESC LIMIT 10`, bparams);
      const max = Number(cats[0]?.s ?? 0) || 1;
      setByCat(cats.map((r) => ({ name: r.name, icon: r.icon, total: Number(r.s), pct: Math.round((Number(r.s) / max) * 100) })));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void load(); }, [monthOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 }}>
        <Pressable onPress={() => setMonthOffset((m) => m + 1)}><Text style={{ fontSize: 18, color: '#4a5160' }}>‹</Text></Pressable>
        <Text style={{ fontWeight: '700', color: '#1a1c23', fontSize: 15 }}>{monthOffset === 0 ? '本月报表' : `${mr.label}报表`}</Text>
        {monthOffset > 0
          ? <Pressable onPress={() => setMonthOffset((m) => Math.max(0, m - 1))}><Text style={{ fontSize: 18, color: '#4a5160' }}>›</Text></Pressable>
          : <Text style={{ fontSize: 18, color: 'transparent' }}>›</Text>}
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 10 }}>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1, backgroundColor: '#eafaf1', borderRadius: 12, padding: 14 }}>
            <Text style={{ fontSize: 12, color: '#1f9d6c' }}>本月收入</Text>
            <Text style={{ fontSize: 18, fontWeight: '800', color: '#1f9d6c', marginTop: 4 }}>¥{formatAmount(String(sum.income))}</Text>
          </View>
          <View style={{ flex: 1, backgroundColor: '#fdeeee', borderRadius: 12, padding: 14 }}>
            <Text style={{ fontSize: 12, color: '#d64545' }}>本月支出</Text>
            <Text style={{ fontSize: 18, fontWeight: '800', color: '#d64545', marginTop: 4 }}>¥{formatAmount(String(sum.expense))}</Text>
          </View>
        </View>
        <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14 }}>
          <Text style={{ fontSize: 12, color: '#4a5160', marginBottom: 8 }}>本月结余</Text>
          <Text style={{ fontSize: 20, fontWeight: '800', color: '#1a1c23' }}>
            ¥{formatAmount(String(sum.income - sum.expense))}
          </Text>
        </View>
        <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1a1c23', marginBottom: 10 }}>支出分类排行 Top10</Text>
          {byCat.length === 0 && <Text style={{ color: '#8a93a5', fontSize: 12 }}>本月暂无支出</Text>}
          {byCat.map((c, i) => (
            <View key={c.name + i} style={{ marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={{ fontSize: 12, color: '#1a1c23' }}>{c.icon} {c.name}</Text>
                <Text style={{ fontSize: 12, color: '#4a5160' }}>¥{formatAmount(String(c.total))}</Text>
              </View>
              <View style={{ height: 6, backgroundColor: '#eef0f6', borderRadius: 3 }}>
                <View style={{ height: 6, width: `${Math.max(4, c.pct)}%`, backgroundColor: i === 0 ? '#4361ee' : '#8fa3f5', borderRadius: 3 }} />
              </View>
            </View>
          ))}
          {busy && <Text style={{ color: '#8a93a5', fontSize: 12 }}>加载中…</Text>}
        </View>
      </ScrollView>
    </View>
  );
}

function MeScreen({ logged, onLogged, syncText }: { logged: boolean; onLogged: (v: boolean) => void; syncText: string }) {
  const [server, setServer] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [me, setMe] = useState<{ email?: string | null; nickname?: string | null } | null>(null);

  useEffect(() => {
    void initDb().then(async () => {
      setServer(await getServerUrl());
      if (logged) {
        try {
          const u = (await authApi.me()) as { email?: string; nickname?: string };
          setMe({ email: u.email, nickname: u.nickname });
        } catch { /* token 失效等场景静默,下轮刷新 */ }
      } else {
        setMe(null);
      }
    });
  }, [logged]);

  const submit = async () => {
    if (!email || !password) return;
    setBusy(true);
    setMsg(null);
    try {
      // 故障转移链:公网 frp → 局域网 → 全断时报错并保持离线(本地记账不受影响)
      const reachable = await resolveServerUrl();
      setServer(reachable);
      await setServerUrl(reachable);
      let data = await authApi.login(email, password).catch((e) => {
        console.log('[auth] login 失败,转注册:', String(e));
        return authApi.register(email, password);
      });
      console.log('[auth] 成功,服务器:', reachable);
      saveSession(data as never);
      // P0-1(第 27 轮):三态换号处理(明确换号清库/纯本地保留/残留清库),与 Web 同策略
      const action = await prepareAfterLogin(db, String((data as { user?: { id?: string } }).user?.id ?? ''));
      onLogged(true);
      await initDb(); // 清库后重播种/重初始化
      await engine.syncOnce();
      // 首登收敛:若当前 active 账本是本地新建(从未上云),而服务器已有同步过的账本,
      // 则采纳服务器的账本作为当前账本——否则两端同账号却各看各的空账本
      const active = await getActiveLedgerId();
      const activeSynced = await db.getAllAsync<{ n: number }>(
        'SELECT COUNT(*) AS n FROM ledgers WHERE id = ? AND server_version IS NOT NULL', [active]);
      if (!Number(activeSynced[0]?.n)) {
        const srvLedger = await db.getAllAsync<{ id: string }>(
          'SELECT id FROM ledgers WHERE server_version IS NOT NULL AND is_deleted = 0 ORDER BY created_at LIMIT 1');
        if (srvLedger[0]?.id && srvLedger[0].id !== active) {
          await metaSet(db, 'active_ledger', srvLedger[0].id);
          console.log('[auth] 采纳服务器账本:', srvLedger[0].id);
        }
      }
      setMsg(action === 'wiped' ? '检测到账号切换,已清空本地数据并重新同步' : '登录成功,同步已开启');
    } catch (e) {
      console.log('[auth] 登录/注册失败:', String(e));
      setMsg('连接服务器失败(公网与局域网均不可达)——已保持离线模式,本地记账不受影响;网络恢复后请重试登录');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await logoutAll(); // 服务端吊销全部会话(F-08)
    onLogged(false);
    setMsg('已退出(本地数据保留)');
  };

  return (
    <ScrollView contentContainerStyle={styles.form}>
      <Text style={styles.meTitle}>{logged ? `${me?.nickname || me?.email || '已登录'} · 云同步开启` : '未登录 · 纯本地模式'}</Text>
      <Text style={styles.muted}>离线也能记账:数据先存本机,连上服务器后自动同步</Text>
      <Text style={styles.muted}>同步状态:{syncText}</Text>
      {!logged && (
        <>
          <Text style={styles.label}>服务器</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
            {SERVER_PRESETS.map((p) => (
              <Pressable
                key={p.url}
                onPress={() => setServer(p.url)}
                style={{
                  flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center',
                  backgroundColor: server === p.url ? '#4361ee' : '#eef0f6',
                }}
              >
                <Text style={{ color: server === p.url ? '#fff' : '#4a5160', fontSize: 12 }}>{p.label}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput style={styles.input} value={server} onChangeText={setServer} autoCapitalize="none" placeholder="http://192.168.x.x:60505" placeholderTextColor="#b4bac6" />
          <Text style={styles.label}>邮箱</Text>
          <TextInput style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="you@example.com" placeholderTextColor="#b4bac6" />
          <Text style={styles.label}>密码</Text>
          <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry placeholder="至少 8 位" placeholderTextColor="#b4bac6" />
          <Pressable style={[styles.saveBtn, busy && styles.disabled]} onPress={() => void submit()}>
            <Text style={styles.saveText}>{busy ? '请稍候…' : '登录(无账号自动注册)'}</Text>
          </Pressable>
        </>
      )}
      {logged && (
        <>
          <Pressable style={styles.saveBtn} onPress={() => void engine.syncOnce()}>
            <Text style={styles.saveText}>立即同步</Text>
          </Pressable>
          <Pressable style={[styles.saveBtn, styles.logout]} onPress={() => void logout()}>
            <Text style={[styles.saveText, { color: '#e5484d' }]}>退出登录(本地数据保留)</Text>
          </Pressable>
        </>
      )}
      {msg && <Text style={styles.msg}>{msg}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: '#f1f2f7', paddingTop: 54 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f1f2f7' },
  title: { fontSize: 22, fontWeight: '800', paddingHorizontal: 20, paddingBottom: 8, color: '#1a1c23' },
  content: { flex: 1 },
  form: { padding: 16, gap: 12 },
  typeRow: { flexDirection: 'row', backgroundColor: '#e6e8ef', borderRadius: 12, padding: 3 },
  typeBtn: { flex: 1, padding: 9, borderRadius: 10, alignItems: 'center' },
  typeBtnActive: { backgroundColor: '#ffffff' },
  typeText: { color: '#8a919f' },
  typeTextActive: { color: '#1a1c23', fontWeight: '700' },
  amountInput: { fontSize: 34, fontWeight: '800', textAlign: 'center', padding: 10, backgroundColor: '#ffffff', borderRadius: 16, color: '#1a1c23' },
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  catBtn: { width: '23%', backgroundColor: '#ffffff', borderRadius: 14, padding: 10, alignItems: 'center' },
  catBtnActive: { backgroundColor: '#edf0fe', borderWidth: 2, borderColor: '#4361ee' },
  catIcon: { fontSize: 22 },
  catName: { fontSize: 12, marginTop: 4, color: '#1a1c23' },
  saveBtn: { backgroundColor: '#4361ee', borderRadius: 14, padding: 15, alignItems: 'center' },
  saveText: { color: '#ffffff', fontWeight: '700', fontSize: 15 },
  disabled: { opacity: 0.4 },
  msg: { textAlign: 'center', color: '#4361ee', fontSize: 13 },
  list: { padding: 16, gap: 10 },
  txRow: { flexDirection: 'row', backgroundColor: '#ffffff', borderRadius: 14, padding: 14, alignItems: 'center' },
  txMain: { flex: 1 },
  txNote: { fontSize: 14, fontWeight: '600', color: '#1a1c23' },
  txDate: { fontSize: 12, color: '#8a919f', marginTop: 2 },
  txAmount: { fontSize: 15, fontWeight: '700' },
  meTitle: { fontSize: 17, fontWeight: '800', color: '#1a1c23' },
  label: { fontSize: 12, color: '#8a919f' },
  input: { backgroundColor: '#ffffff', borderRadius: 12, padding: 12, fontSize: 14, color: '#1a1c23' },
  logout: { backgroundColor: '#feefef' },
  muted: { color: '#8a919f', fontSize: 13 },
  tabbar: { flexDirection: 'row', backgroundColor: '#ffffff', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#e8eaee' },
  tabBtn: { flex: 1, alignItems: 'center', padding: 14 },
  tabBtnActive: { backgroundColor: '#edf0fe' },
  tabLabel: { color: '#8a919f', fontSize: 13 },
  tabLabelActive: { color: '#4361ee', fontWeight: '700' },
});

export default function App() {
  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <AppInner />
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
