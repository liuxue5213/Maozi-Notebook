import './src/lib/polyfills'; // 必须最先:uuid@14 裸用全局 crypto,Hermes 没有,必须先垫上
import { buildBudgetModel, netSavings, type BudgetModel } from '@ledgerone/ledger-core';
import { isValidAmount, parseTextLedger, reconcileTextLedger, renderTextLedger, billingCycleRange, daysUntilDue, accountBalance, isLiability, dedupeHash, buildCsv, exportFileName } from '@ledgerone/domain';
import React, { useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { AppState, BackHandler, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatAmount, newId, type TransactionRow, type TransactionType } from '@ledgerone/domain';
import { useSyncExternalStore } from 'react';
import { engine, scheduleSync, snapshot, startMobileAutoSync } from './src/lib/sync';
import { runDueRecurring } from './src/lib/recurring';
import { evalExpr } from './src/lib/calc';
import { activeLockMode, biometricAuth, biometricAvailable, disableLock, hasPin, isBiometricDisabled, isLockEnabled, enableLock, setBiometricDisabled, setPin, verifyPin } from './src/lib/applock';
import { initDb, resetInitCache, createLedgerWithSeed, listRecent, saveTx, topCategories, getActiveLedgerId, metaGet, metaSet, db } from './src/lib/store';
import { clearSession as clearSessionLocal } from './src/lib/api';
import { resetLocalDatabase } from './src/lib/db';
import { prepareAfterLogin, saveLocal } from '@ledgerone/sqlite-sync';
import { authApi, aiChat, aiInsights, aiParse, clearSession, getServerUrl, insecureTransportReason, isLoggedIn, logout as logoutAll, saveSession, setServerUrl, SERVER_PRESETS, resolveServerUrl, validateServerUrl } from './src/lib/api';

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
          <Pressable style={{ marginTop: 16, backgroundColor: '#4361ee', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20, alignSelf: 'flex-start' }} onPress={() => this.setState({ err: null })}>
            <Text style={{ color: '#fff', fontSize: 14 }}>重试</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

/** 分类管理:重命名 / 隐藏显示(v1;排序后续)。入口在「我的」页 */
function CategoryManager({ onBack }: { onBack: () => void }) {
  const [cats, setCats] = useState<Array<Record<string, unknown>>>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState<'expense' | 'income'>('expense');

  const load = async () => {
    await initDb();
    const ledgerId = await getActiveLedgerId();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM categories WHERE is_deleted = 0 AND ledger_id = ? ORDER BY kind, sort', [ledgerId]);
    setCats(rows);
  };
  useEffect(() => { void load(); }, []);

  const persist = async (row: Record<string, unknown>) => {
    const now = Date.now();
    await saveLocal(db, 'category', { ...row, client_version: Number(row.client_version ?? 0) + 1, updated_at: now } as never);
  };

  const rename = async (row: Record<string, unknown>) => {
    const name = draft.trim().slice(0, 20);
    setEditingId(null);
    if (!name || name === row.name) return;
    await persist({ ...row, name });
    void load();
  };

  const toggleHidden = async (row: Record<string, unknown>) => {
    await persist({ ...row, is_hidden: !row.is_hidden });
    void load();
  };

  const groups = cats.filter((c) => c.kind === tab);
  return (
    <View style={{ flex: 1, backgroundColor: '#f6f7f9' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Pressable onPress={onBack}><Text style={{ fontSize: 16, color: '#4361ee' }}>‹ 返回</Text></Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: '#1a1c23' }}>分类管理</Text>
        <Text style={{ fontSize: 16, color: 'transparent' }}>‹</Text>
      </View>
      <View style={{ flexDirection: 'row', paddingHorizontal: 12, gap: 8, paddingBottom: 8 }}>
        {(['expense', 'income'] as const).map((k) => (
          <Pressable key={k} onPress={() => setTab(k)}
            style={{ paddingVertical: 6, paddingHorizontal: 14, borderRadius: 14, backgroundColor: tab === k ? '#4361ee' : '#eef0f6' }}>
            <Text style={{ fontSize: 13, color: tab === k ? '#fff' : '#4a5160' }}>{k === 'expense' ? '支出分类' : '收入分类'}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 6 }}>
        {groups.map((row) => {
          const id = String(row.id);
          const hidden = !!row.is_hidden;
          return (
            <View key={id} style={{ backgroundColor: '#fff', borderRadius: 10, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontSize: 18 }}>{String(row.icon)}</Text>
              {editingId === id ? (
                <TextInput
                  style={{ flex: 1, borderBottomWidth: 1, borderColor: '#4361ee', fontSize: 14, color: '#1a1c23', paddingVertical: 2 }}
                  value={draft} autoFocus onChangeText={(t) => setDraft(t.slice(0, 20))}
                  onSubmitEditing={() => void rename(row)} onBlur={() => void rename(row)}
                />
              ) : (
                <Text style={{ flex: 1, fontSize: 14, color: hidden ? '#b4bac6' : '#1a1c23' }}>
                  {String(row.name)}{hidden ? '(已隐藏)' : ''}
                </Text>
              )}
              {editingId !== id && (
                <Pressable onPress={() => { setEditingId(id); setDraft(String(row.name)); }}>
                  <Text style={{ color: '#4361ee', fontSize: 13 }}>重命名</Text>
                </Pressable>
              )}
              <Pressable onPress={() => void toggleHidden(row)}>
                <Text style={{ color: hidden ? '#1f9d6c' : '#8a93a5', fontSize: 13 }}>{hidden ? '显示' : '隐藏'}</Text>
              </Pressable>
            </View>
          );
        })}
        {groups.length === 0 && <Text style={{ color: '#8a93a5', fontSize: 13 }}>暂无分类</Text>}
      </ScrollView>
    </View>
  );
}

/** 存钱计划:列表 + 新建 + 进度(已存 = 期间净结余,复用 ledger-core netSavings) */
function SavingsScreen({ onBack }: { onBack: () => void }) {
  const [plans, setPlans] = useState<Array<Record<string, unknown> & { saved: number; pct: number }>>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [ptype, setPtype] = useState<'yearly' | 'monthly'>('yearly');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    await initDb();
    const ledgerId = await getActiveLedgerId();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM savings_plans WHERE is_deleted = 0 AND ledger_id = ? ORDER BY created_at DESC', [ledgerId]);
    const now = Date.now();
    const out: Array<Record<string, unknown> & { saved: number; pct: number }> = [];
    for (const p of rows) {
      const start = Number(p.period_start), end = Math.min(Number(p.period_end), now);
      const txs = await db.getAllAsync<{ type: string; amount_base: string; is_deleted: number }>(
        'SELECT type, amount_base, is_deleted FROM transactions WHERE is_deleted = 0 AND ledger_id = ? AND happened_at >= ? AND happened_at < ?',
        [ledgerId, start, end]);
      const saved = Number(netSavings(txs as never));
      const goalN = Number(p.goal_amount) || 1;
      out.push({ ...p, saved, pct: Math.min(100, Math.round((saved / goalN) * 100)) });
    }
    setPlans(out);
  };
  useEffect(() => { void load(); }, []);

  const create = async () => {
    const nm = name.trim().slice(0, 50);
    if (!nm || !isValidAmount(goal) || Number(goal) <= 0) return;
    setBusy(true);
    try {
      await initDb();
      const ledgerId = await getActiveLedgerId();
      const now = Date.now();
      const d = new Date(Number(now));
      const year = d.getFullYear();
      const period_start = new Date(year, ptype === 'yearly' ? 0 : d.getMonth(), 1).getTime();
      const period_end = ptype === 'yearly' ? new Date(year + 1, 0, 1).getTime() : new Date(year, d.getMonth() + 1, 1).getTime();
      const row = { id: newId(), ledger_id: ledgerId, name: nm, goal_amount: Number(goal).toFixed(2),
        period_type: ptype, period_start, period_end, expected_income: null, baseline_months: 6,
        allocation: 'even', promo_months: null, exclude_oneoff: false, linked_account_id: null,
        status: 'active', client_version: 1, server_version: null, is_deleted: false, deleted_at: null,
        created_at: now, updated_at: now };
      await saveLocal(db, 'savings_plan', row as never);
      setName(''); setGoal(''); setCreating(false);
      await load();
    } finally { setBusy(false); }
  };

  const setStatus = async (row: Record<string, unknown>, status: string) => {
    const now = Date.now();
    await saveLocal(db, 'savings_plan', { ...row, status, client_version: Number(row.client_version ?? 0) + 1, updated_at: now } as never);
    void load();
  };

  const removePlan = async (row: Record<string, unknown>) => {
    const now = Date.now();
    await saveLocal(db, 'savings_plan', { ...row, is_deleted: true, deleted_at: now, client_version: Number(row.client_version ?? 0) + 1, updated_at: now } as never, { op: 'delete' });
    void load();
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#f6f7f9' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Pressable onPress={onBack}><Text style={{ fontSize: 16, color: '#4361ee' }}>‹ 返回</Text></Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: '#1a1c23' }}>存钱计划</Text>
        <Pressable onPress={() => setCreating((v) => !v)}><Text style={{ fontSize: 20, color: '#4361ee' }}>＋</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 10 }}>
        {creating && (
          <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, gap: 8 }}>
            <TextInput style={styles.input} value={name} onChangeText={(t) => setName(t.slice(0, 50))} placeholder="计划名(如 三亚旅行)" placeholderTextColor="#b4bac6" />
            <TextInput style={styles.input} value={goal} onChangeText={(t) => setGoal(t.replace(/[^\\d.]/g, ''))} keyboardType="decimal-pad" placeholder="目标金额" placeholderTextColor="#b4bac6" />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {(['yearly', 'monthly'] as const).map((t) => (
                <Pressable key={t} onPress={() => setPtype(t)}
                  style={{ flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center', backgroundColor: ptype === t ? '#4361ee' : '#eef0f6' }}>
                  <Text style={{ fontSize: 13, color: ptype === t ? '#fff' : '#4a5160' }}>{t === 'yearly' ? '年度计划' : '月度计划'}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable style={[styles.saveBtn, busy && styles.disabled]} onPress={() => void create()}>
              <Text style={styles.saveText}>{busy ? '保存中…' : '创建计划'}</Text>
            </Pressable>
          </View>
        )}
        {plans.map((p) => {
          const status = String(p.status);
          return (
            <View key={String(p.id)} style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#1a1c23' }}>{String(p.name)}</Text>
                <Text style={{ fontSize: 11, color: status === 'active' ? '#1f9d6c' : '#8a93a5' }}>
                  {status === 'active' ? '进行中' : status === 'paused' ? '已暂停' : status === 'achieved' ? '已达成' : '已归档'}
                </Text>
              </View>
              <Text style={{ fontSize: 12, color: '#4a5160', marginVertical: 4 }}>
                已存 ¥{formatAmount(String(p.saved))} / 目标 ¥{formatAmount(String(p.goal_amount))} · {String(p.period_type) === 'yearly' ? '年度' : '月度'}
              </Text>
              <View style={{ height: 6, backgroundColor: '#eef0f6', borderRadius: 3 }}>
                <View style={{ height: 6, width: `${Math.max(2, Number(p.pct))}%`, backgroundColor: '#1f9d6c', borderRadius: 3 }} />
              </View>
              <View style={{ flexDirection: 'row', gap: 14, marginTop: 8 }}>
                <Pressable onPress={() => void setStatus(p, status === 'paused' ? 'active' : 'paused')}>
                  <Text style={{ fontSize: 12, color: '#4361ee' }}>{status === 'paused' ? '继续' : '暂停'}</Text>
                </Pressable>
                {p.saved && Number(p.goal_amount) > 0 && Number(p.saved) >= Number(p.goal_amount) && (
                  <Pressable onPress={() => void setStatus(p, 'achieved')}>
                    <Text style={{ fontSize: 12, color: '#1f9d6c' }}>标记达成</Text>
                  </Pressable>
                )}
                <Pressable onPress={() => void removePlan(p)}>
                  <Text style={{ fontSize: 12, color: '#d64545' }}>删除</Text>
                </Pressable>
              </View>
            </View>
          );
        })}
        {plans.length === 0 && !creating && <Text style={{ color: '#8a93a5', fontSize: 13, textAlign: 'center' }}>还没有存钱计划,点右上角 ＋ 创建</Text>}
      </ScrollView>
    </View>
  );
}


/** 导入账单:粘贴手写账文本 → parseTextLedger 解析 → 全部确认入账(共享内核三路核对) */
function ImportScreen({ onBack }: { onBack: () => void }) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<Array<{ day: number; amount: string; name: string; catId: string | null }>>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const total = parsed.reduce((a, p) => a + Number(p.amount), 0);

  const doParse = async () => {
    setParsed([]); setSummary(null); setWarn(null); setDone(null);
    const r = parseTextLedger(text);
    if (!r.ok) { setWarn(r.reason); return; }
    const d = r.data;
    if (d.entries.length === 0) { setWarn('未解析出任何条目,请检查文本格式'); return; }
    await initDb();
    const ledgerId = await getActiveLedgerId();
    const cats = await db.getAllAsync<{ id: string; name: string }>(
      'SELECT id, name FROM categories WHERE is_deleted = 0 AND ledger_id = ?', [ledgerId]);
    const rec = reconcileTextLedger(d);
    const catIdOf = (name: string): string | null => cats.find((c) => c.name === name)?.id ?? null;
    setParsed(d.entries.map((e) => ({ ...e, catId: catIdOf(e.name) })));
    const parts = [`${d.entries.length} 条 · 合计 ¥${formatAmount(d.entries.reduce((a, e) => a + Number(e.amount), 0).toFixed(2))}`];
    if (rec.unresolvedDiffs.length > 0) parts.push(`⚠ 与手写合计有 ${rec.unresolvedDiffs.length} 处差异(${rec.unresolvedDiffs.map((x) => `${x.label}差${x.diff}`).join('、')})`);
    if (d.ignoredLines > 0) parts.push(`忽略 ${d.ignoredLines} 行`);
    setSummary(parts.join(' · '));
  };

  // T-11:确认后先入待确认池(dedupe_hash 去重),池内一键入账
  const confirmAll = async () => {
    if (parsed.length === 0) return;
    setBusy(true);
    try {
      await initDb();
      const ledgerId = await getActiveLedgerId();
      const now = Date.now();
      const year = new Date().getFullYear();
      let added = 0, skipped = 0;
      for (const e of parsed) {
        const ts = new Date(year, new Date().getMonth(), e.day, 12).getTime();
        if (ts > Date.now()) { skipped++; continue; }
        const hash = await dedupeHash({ amount: e.amount, happenedAt: ts, accountId: 'import', merchant: e.name });
        const dup = await db.getAllAsync<{ id: string }>(
          'SELECT id FROM pending_transactions WHERE dedupe_hash = ? AND is_deleted = 0', [hash]);
        if (dup.length) { skipped++; continue; }
        await saveLocal(db, 'pending_transaction', {
          id: newId(), ledger_id: ledgerId, source_type: 'text_ledger',
          raw: JSON.stringify(e), parsed: JSON.stringify({ ...e, happened_at: ts }),
          confidence: 0.9, dedupe_hash: hash, status: 'pending',
          client_version: 1, server_version: null, is_deleted: false, deleted_at: null, created_at: now, updated_at: now,
        } as never);
        added++;
      }
      setParsed([]);
      setDone(added); setWarn(skipped > 0 ? `跳过 ${skipped} 条(重复或未来日期)` : null);
      await loadPool();
    } finally { setBusy(false); }
  };

  const [pool, setPool] = useState<Array<Record<string, unknown> & { parsedObj: { day: number; amount: string; name: string } }>>([]);

  const loadPool = async () => {
    await initDb();
    const ledgerId = await getActiveLedgerId();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM pending_transactions WHERE is_deleted = 0 AND ledger_id = ? AND status = ? ORDER BY created_at DESC', [ledgerId, 'pending']);
    setPool(rows.map((r) => ({ ...r, parsedObj: JSON.parse(String(r.parsed ?? '{}')) })));
  };
  useEffect(() => { void loadPool(); }, []);

  const confirmOne = async (row: Record<string, unknown>) => {
    const p = row.parsedObj as { day: number; amount: string; name: string; happened_at: number };
    const ledgerId = await getActiveLedgerId();
    const firstAcc = (await db.getAllAsync<{ id: string }>('SELECT id FROM accounts WHERE is_deleted = 0 AND ledger_id = ? ORDER BY sort LIMIT 1', [ledgerId]))[0]?.id ?? '';
    const cats = await db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM categories WHERE is_deleted = 0 AND ledger_id = ?', [ledgerId]);
    const now = Date.now();
    const baseCurrency = ((await metaGet(db, 'base_currency')) as string) ?? 'CNY'; // T-02:跟随账本主币种
    await saveLocal(db, 'transaction', { id: newId(), ledger_id: ledgerId, user_id: 'local', member_id: null, type: 'expense',
      amount: p.amount, currency: baseCurrency, amount_base: p.amount, exchange_rate: null,
      category_id: cats.find((c) => c.name === p.name)?.id ?? null, account_id: firstAcc, to_account_id: null,
      happened_at: Number(p.happened_at), note: p.name, is_refunded: 0, refund_of_id: null, reimburse_status: null,
      exclude_from_budget: 0, attachment_count: 0, source: 'import',
      client_version: 1, server_version: null, is_deleted: 0, deleted_at: null, created_at: now, updated_at: now } as never);
    await saveLocal(db, 'pending_transaction', { ...row, status: 'confirmed', client_version: Number(row.client_version ?? 0) + 1, updated_at: now } as never);
    scheduleSync();
    await loadPool();
  };

  const ignoreOne = async (row: Record<string, unknown>) => {
    await saveLocal(db, 'pending_transaction', { ...row, status: 'ignored', client_version: Number(row.client_version ?? 0) + 1, updated_at: Date.now() } as never);
    await loadPool();
  };

  const confirmAllPool = async () => {
    for (const row of pool) { await confirmOne(row); }
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#f6f7f9' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Pressable onPress={onBack}><Text style={{ fontSize: 16, color: '#4361ee' }}>‹ 返回</Text></Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: '#1a1c23' }}>导入账单</Text>
        <Text style={{ fontSize: 16, color: 'transparent' }}>‹</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 10 }}>
        <Text style={{ fontSize: 12, color: '#8a93a5' }}>粘贴手写账文本(首行需「2026 10月消费」;每行「日  金额品名」;合计行自动核对)</Text>
        <TextInput
          style={{ backgroundColor: '#fff', borderRadius: 10, padding: 10, minHeight: 140, fontSize: 12, color: '#1a1c23', textAlignVertical: 'top' }}
          value={text} onChangeText={setText} multiline
          placeholder={'2026 10月消费\n1  6.3  9.05砂纸  12面\n合计  267.48'}
          placeholderTextColor="#b4bac6"
        />
        <Pressable style={[styles.saveBtn, busy && styles.disabled]} onPress={() => void doParse()}>
          <Text style={styles.saveText}>解析</Text>
        </Pressable>
        {warn && <Text style={{ color: '#d64545', fontSize: 12 }}>{warn}</Text>}
        {summary && <Text style={{ color: '#1a1c23', fontSize: 13 }}>{summary}</Text>}
        {parsed.length > 0 && (
          <View style={{ backgroundColor: '#fff', borderRadius: 10, padding: 10 }}>
            {parsed.map((e, i) => (
              <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                <Text style={{ fontSize: 12, color: '#1a1c23' }}>{e.day}日 · {e.name || '未命名'}{e.catId ? '' : '(未匹配分类)'}</Text>
                <Text style={{ fontSize: 12, color: '#4a5160' }}>¥{e.amount}</Text>
              </View>
            ))}
          </View>
        )}
        {parsed.length > 0 && (
          <Pressable style={[styles.saveBtn, busy && styles.disabled]} onPress={() => void confirmAll()}>
            <Text style={styles.saveText}>{busy ? '入账中…' : `全部确认入账(${parsed.length} 条)`}</Text>
          </Pressable>
        )}
        {done !== null && done > 0 && <Text style={{ color: '#1f9d6c', fontSize: 13 }}>已入待确认池 {done} 笔,下方确认后正式入账</Text>}
        {pool.length > 0 && (
          <View style={{ backgroundColor: '#fff', borderRadius: 10, padding: 10, gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#1a1c23' }}>待确认池({pool.length})</Text>
              <Pressable onPress={() => void confirmAllPool()}><Text style={{ color: '#4361ee', fontSize: 12 }}>全部确认</Text></Pressable>
            </View>
            {pool.map((row) => {
              const pj = row.parsedObj as { day: number; amount: string; name: string };
              return (
              <View key={String(row.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, borderTopColor: '#f0f1f5', paddingVertical: 6 }}>
                <Text style={{ flex: 1, fontSize: 12, color: '#1a1c23' }}>
                  {Number(pj.day)}日 · {pj.name || '未命名'}
                </Text>
                <Text style={{ fontSize: 12, color: '#4a5160' }}>¥{pj.amount}</Text>
                <Pressable onPress={() => void confirmOne(row)}><Text style={{ color: '#1f9d6c', fontSize: 12 }}>确认</Text></Pressable>
                <Pressable onPress={() => void ignoreOne(row)}><Text style={{ color: '#8a93a5', fontSize: 12 }}>忽略</Text></Pressable>
              </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

/** 周期记账:规则列表 + 新建 + 打开时补跑到期生成(SQLite 版引擎) */
function RecurringScreen({ onBack }: { onBack: () => void }) {
  const [rules, setRules] = useState<Array<Record<string, unknown>>>([]);
  const [creating, setCreating] = useState(false);
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState('');
  const [freq, setFreq] = useState<'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly'>('monthly');
  const [interval, setIntervalN] = useState('1');
  const [catId, setCatId] = useState<string | null>(null);
  const [cats, setCats] = useState<Array<{ id: string; name: string; icon: string }>>([]);
  const [generated, setGenerated] = useState<number | null>(null);

  const load = async () => {
    await initDb();
    const ledgerId = await getActiveLedgerId();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM recurring_rules WHERE is_deleted = 0 AND ledger_id = ? ORDER BY created_at DESC', [ledgerId]);
    setRules(rows);
    const cs = await db.getAllAsync<{ id: string; name: string; icon: string }>(
      'SELECT id, name, icon FROM categories WHERE is_deleted = 0 AND ledger_id = ? ORDER BY kind, sort', [ledgerId]);
    setCats(cs);
    if (cs[0]) setCatId((prev) => prev ?? cs[0].id);
    const n = await runDueRecurring();
    if (n > 0) setGenerated(n);
  };
  useEffect(() => { void load(); }, []);

  const create = async () => {
    if (!isValidAmount(amount) || Number(amount) <= 0 || !catId) return;
    const ledgerId = await getActiveLedgerId();
    const now = Date.now();
    const row = { id: newId(), ledger_id: ledgerId, amount: Number(amount).toFixed(2), category_id: catId,
      account_id: (await db.getAllAsync<{ id: string }>('SELECT id FROM accounts WHERE is_deleted = 0 AND ledger_id = ? ORDER BY sort LIMIT 1', [ledgerId]))[0]?.id ?? '',
      note: note.trim() || null, frequency: freq, interval: Math.max(1, Number(interval) || 1), next_run_at: now + 86_400_000,
      paused: 0, last_run_at: null, client_version: 1, server_version: null, is_deleted: 0, deleted_at: null, created_at: now, updated_at: now };
    await saveLocal(db, 'recurring_rule', row as never);
    setNote(''); setAmount(''); setCreating(false);
    await load();
  };

  const togglePause = async (row: Record<string, unknown>) => {
    await saveLocal(db, 'recurring_rule', { ...row, paused: row.paused ? 0 : 1, client_version: Number(row.client_version ?? 0) + 1, updated_at: Date.now() } as never);
    void load();
  };

  const removeRule = async (row: Record<string, unknown>) => {
    const now = Date.now();
    await saveLocal(db, 'recurring_rule', { ...row, is_deleted: 1, deleted_at: now, client_version: Number(row.client_version ?? 0) + 1, updated_at: now } as never, { op: 'delete' });
    void load();
  };

  const FREQ_LABEL: Record<string, string> = { daily: '每天', weekly: '每周', monthly: '每月', quarterly: '每季', yearly: '每年' };
  const catOf = (id: unknown) => cats.find((c) => c.id === id);

  return (
    <View style={{ flex: 1, backgroundColor: '#f6f7f9' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Pressable onPress={onBack}><Text style={{ fontSize: 16, color: '#4361ee' }}>‹ 返回</Text></Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: '#1a1c23' }}>周期记账</Text>
        <Pressable onPress={() => setCreating((v) => !v)}><Text style={{ fontSize: 20, color: '#4361ee' }}>＋</Text></Pressable>
      </View>
      {generated !== null && generated > 0 && (
        <Text style={{ color: '#1f9d6c', fontSize: 12, paddingHorizontal: 12, paddingBottom: 6 }}>已自动补生成 {generated} 笔到期流水</Text>
      )}
      <ScrollView contentContainerStyle={{ padding: 12, gap: 10 }}>
        {creating && (
          <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, gap: 8 }}>
            <TextInput style={styles.input} value={note} onChangeText={(t) => setNote(t.slice(0, 50))} placeholder="名称(如 房租)" placeholderTextColor="#b4bac6" />
            <TextInput style={styles.input} value={amount} onChangeText={(t) => setAmount(t.replace(/[^\\d.]/g, ''))} keyboardType="decimal-pad" placeholder="金额" placeholderTextColor="#b4bac6" />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {(['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const).map((f) => (
                <Pressable key={f} onPress={() => setFreq(f)}
                  style={{ flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center', backgroundColor: freq === f ? '#4361ee' : '#eef0f6' }}>
                  <Text style={{ fontSize: 13, color: freq === f ? '#fff' : '#4a5160' }}>{FREQ_LABEL[f]}</Text>
                </Pressable>
              ))}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {cats.map((c) => (
                <Pressable key={c.id} onPress={() => setCatId(c.id)}
                  style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 12, backgroundColor: catId === c.id ? '#4361ee' : '#eef0f6' }}>
                  <Text style={{ fontSize: 12, color: catId === c.id ? '#fff' : '#4a5160' }}>{c.icon} {c.name}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput style={styles.input} value={interval} onChangeText={(t) => setIntervalN(t.replace(/[^\d]/g, '').slice(0, 3))} keyboardType="number-pad" placeholder="间隔(默认 1)" placeholderTextColor="#b4bac6" />
            <Pressable style={[styles.saveBtn, (!amount || !catId) && styles.disabled]} onPress={() => void create()}>
              <Text style={styles.saveText}>创建规则(明天开始生效)</Text>
            </Pressable>
          </View>
        )}
        {rules.map((row) => {
          const next = new Date(Number(row.next_run_at)).toLocaleDateString('zh-CN');
          const c = catOf(row.category_id);
          return (
            <View key={String(row.id)} style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#1a1c23' }}>{String(row.note || (c ? `${c.icon} ${c.name}` : '周期记账'))}</Text>
                <Text style={{ fontSize: 11, color: row.paused ? '#8a93a5' : '#1f9d6c' }}>{Number(row.paused) ? '已暂停' : '进行中'}</Text>
              </View>
              <Text style={{ fontSize: 12, color: '#4a5160', marginVertical: 4 }}>
                ¥{formatAmount(String(row.amount))} · {FREQ_LABEL[String(row.frequency)] ?? String(row.frequency)} · 下次 {next}
              </Text>
              <View style={{ flexDirection: 'row', gap: 14, marginTop: 6 }}>
                <Pressable onPress={() => void togglePause(row)}>
                  <Text style={{ fontSize: 12, color: '#4361ee' }}>{row.paused ? '继续' : '暂停'}</Text>
                </Pressable>
                <Pressable onPress={() => void removeRule(row)}>
                  <Text style={{ fontSize: 12, color: '#d64545' }}>删除</Text>
                </Pressable>
              </View>
            </View>
          );
        })}
        {rules.length === 0 && !creating && <Text style={{ color: '#8a93a5', fontSize: 13, textAlign: 'center' }}>还没有循环规则,点右上角 ＋ 创建</Text>}
      </ScrollView>
    </View>
  );
}


function LockGate({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [locked, setLocked] = useState(false);
  const [mode, setMode] = useState<'bio' | 'pin'>('pin');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pinFallback, setPinFallback] = useState(false);

  useEffect(() => {
    void (async () => {
      const on = await isLockEnabled();
      // 审查修复(P1):「已启用但没有任何可用解锁方式」的残留态(如 PIN 设置中途杀 App)
      // 会让 verifyPin 对任意输入放行 → 直接自愈为未上锁,杜绝失效开门
      if (on && (await activeLockMode()) === 'pin' && !(await hasPin())) {
        await disableLock();
        setEnabled(false);
        return;
      }
      setEnabled(on);
      if (on) {
        const mode = await activeLockMode();
        setMode(mode === 'biometric' ? 'bio' : 'pin');
        setPinFallback(await hasPin());
        setLocked(true);
        if (mode === 'biometric') void biometricAuth().then((ok) => { if (ok) setLocked(false); });
      }
    })();
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'background') {
        // 与挂载自愈同口径:「已启用但无可用解锁方式」的设置中途态不上锁,
        // 否则切回前台会进入任意 PIN 可解的锁屏
        void isLockEnabled().then(async (on) => {
          if (on && ((await activeLockMode()) === 'biometric' || (await hasPin()))) setLocked(true);
        });
      }
    });
    return () => sub.remove();
  }, []);

  const tryBio = async () => {
    const ok = await biometricAuth();
    if (ok) setLocked(false);
  };

  const tryPin = async () => {
    const r = await verifyPin(pin);
    if (r === 'ok') { setLocked(false); setPin(''); setErr(null); }
    else if (r === 'locked') setErr('失败次数过多,请 60 秒后再试');
    else { setErr('PIN 错误'); setPin(''); }
  };

  if (enabled === null || !locked) return <>{children}</>;
  return (
    <View style={{ flex: 1, backgroundColor: '#f6f7f9', justifyContent: 'center', alignItems: 'center', padding: 30 }}>
      <Text style={{ fontSize: 17, fontWeight: '700', color: '#1a1c23', marginBottom: 6 }}>帽子记账本已锁定</Text>
      <Text style={{ fontSize: 12, color: '#8a93a5', marginBottom: 20 }}>{mode === 'bio' ? '使用面容/指纹解锁' : '输入 PIN 解锁'}</Text>
      {mode === 'bio' && (
        <Pressable style={{ backgroundColor: '#4361ee', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 30, marginBottom: 12 }} onPress={() => void tryBio()}>
          <Text style={{ color: '#fff', fontSize: 15 }}>🔓 解锁</Text>
        </Pressable>
      )}
      {mode === 'pin' && (
        <View style={{ width: '100%', gap: 10 }}>
          <TextInput style={styles.input} value={pin} onChangeText={(t) => setPin(t.replace(/[^\d]/g, '').slice(0, 8))} keyboardType="number-pad" secureTextEntry placeholder="输入 PIN" placeholderTextColor="#b4bac6" onSubmitEditing={() => void tryPin()} />
          <Pressable style={styles.saveBtn} onPress={() => void tryPin()}>
            <Text style={styles.saveText}>解锁</Text>
          </Pressable>
        </View>
      )}
      {mode === 'bio' && pinFallback && (
        <Pressable onPress={() => setMode('pin')}><Text style={{ fontSize: 13, color: '#4361ee' }}>使用 PIN 解锁</Text></Pressable>
      )}
      {err && <Text style={{ color: '#d64545', fontSize: 12, marginTop: 10 }}>{err}</Text>}
    </View>
  );
}

function AppInner() {
  const insets = useSafeAreaInsets();
  const [sub, setSub] = useState<'none' | 'cats' | 'savings' | 'import' | 'recurring' | 'ledgers' | 'export' | 'accounts' | 'settings' | 'dead' | 'safety'>('none');
  const [ledgerEpoch, setLedgerEpoch] = useState(0);
  const [drillCat, setDrillCat] = useState<string | null>(null);
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

  useEffect(() => {
    const sub_ = BackHandler.addEventListener('hardwareBackPress', () => {
      if (sub !== 'none') { setSub('none'); return true; }
      if (tab !== 'record') { setTab('record'); return true; }
      return false;
    });
    return () => sub_.remove();
  }, [sub, tab]);

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
          onPress={() => { void resetLocalDatabase().finally(() => { resetInitCache(); setReady(false); setBootErr(null); void boot(); }); }}
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

  // 安卓返回键:子页→返回列表;非首页 tab→回记账;首页→系统默认(退出)
  if (sub === 'cats') return <CategoryManager onBack={() => setSub('none')} />;
  if (sub === 'savings') return <SavingsScreen onBack={() => setSub('none')} />;
  if (sub === 'import') return <ImportScreen onBack={() => setSub('none')} />;
  if (sub === 'recurring') return <RecurringScreen onBack={() => setSub('none')} />;
  if (sub === 'ledgers') return <LedgerManager onBack={() => { setSub('none'); setLedgerEpoch((e) => e + 1); }} />;
  if (sub === 'export') return <ExportLedger onBack={() => setSub('none')} />;
  if (sub === 'accounts') return <AccountsScreen onBack={() => { setSub('none'); setLedgerEpoch((e) => e + 1); }} />;
  if (sub === 'settings') return <AccountSettings onBack={() => setSub('none')} onLogged={() => { setSub('none'); setLogged(false); setLedgerEpoch((e) => e + 1); }} />;
  if (sub === 'dead') return <DeadLetterScreen onBack={() => setSub('none')} />;
  if (sub === 'safety') return <SafetyScreen onBack={() => setSub('none')} onOpenDead={() => setSub('dead')} />;
  return (
    <View style={[styles.app, { paddingTop: insets.top }]}>
      <Text style={styles.title}>帽子记账本</Text>
      <View style={styles.content}>
        {tab === 'record' && (
          <RecordScreen onSaved={() => void refreshTxs()} />
        )}
        {tab === 'list' && <ListScreen drillCat={drillCat} onClearDrill={() => setDrillCat(null)} />}
        {tab === 'report' && <ReportScreen onDrill={(catId) => { setDrillCat(catId); setTab('list'); }} />}
        {tab === 'me' && <MeScreen key={`me${ledgerEpoch}`} logged={logged} onLogged={(v) => setLogged(v)} onOpen={(p) => setSub(p)} syncText={`${sync.state === 'idle' ? '正常' : sync.state === 'syncing' ? '同步中' : `失败:${sync.lastError ?? ''}`}${sync.pending > 0 ? ` · 待同步 ${sync.pending}` : ''}`} lastSyncAt={sync.lastSyncAt} onSync={() => void engine.syncOnce()} />}
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

/** 信用卡还款提醒横幅(移植 Web M09-F06):本期账单 3 天内到期时提醒 */
function CreditBanner() {
  const [alert, setAlert] = useState<{ name: string; bill: number; dueIn: number } | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    void (async () => {
      await initDb();
      const now = new Date();
      const cards = await db.getAllAsync<Record<string, unknown>>(
        "SELECT * FROM accounts WHERE is_deleted = 0 AND is_archived = 0 AND type = 'credit_card' AND credit_due_day IS NOT NULL");
      for (const a of cards) {
        const dueDay = Number(a.credit_due_day);
        const { start } = billingCycleRange(dueDay, now);
        const txs = await db.getAllAsync<{ type: string; amount_base: string; account_id: string; to_account_id: string | null }>(
          'SELECT type, amount_base, account_id, to_account_id FROM transactions WHERE is_deleted = 0 AND happened_at >= ?', [start]);
        const onCard = txs.filter((t) => t.account_id === a.id || t.to_account_id === a.id);
        const spend = onCard.filter((t) => t.type === 'expense').reduce((acc, t) => acc + Number(t.amount_base), 0);
        const repaid = onCard.filter((t) => t.type === 'transfer' && t.to_account_id === a.id).reduce((acc, t) => acc + Number(t.amount_base), 0);
        const bill = spend - repaid;
        const dueIn = daysUntilDue(dueDay, now);
        if (bill > 0 && dueIn <= 3) {
          setAlert({ name: String(a.name), bill, dueIn });
          return;
        }
      }
      setAlert(null);
    })();
  }, []);

  if (!alert || hidden) return null;
  return (
    <View style={{ backgroundColor: '#fff8e6', borderRadius: 10, padding: 10, marginBottom: 8, flexDirection: 'row', alignItems: 'center' }}>
      <Text style={{ flex: 1, fontSize: 12, color: '#8a6d1a' }}>
        💳 {alert.name} 本期账单 ¥{formatAmount(String(alert.bill))}{alert.dueIn > 0 ? `,${alert.dueIn} 天后还款` : alert.dueIn === 0 ? ',今天还款日' : ',已过还款日'}
      </Text>
      <Pressable onPress={() => setHidden(true)}><Text style={{ fontSize: 12, color: '#8a6d1a' }}>知道了</Text></Pressable>
    </View>
  );
}

function BudgetCard() {
  const [model, setModel] = useState<BudgetModel | null>(null);
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [catDrafts, setCatDrafts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [rollover, setRollover] = useState(false);

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
    setRollover(!!(b as unknown as Record<string, unknown> | undefined)?.rollover);
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
    const baseCurrency = ((await metaGet(db, 'base_currency')) as string) ?? 'CNY'; // T-02:跟随账本主币种
    const row = b
      ? { ...b, total_amount: amount, rollover, client_version: Number((b as unknown as Record<string, unknown>).client_version ?? 0) + 1, updated_at: now }
      : { id: newId(), ledger_id: ledgerId, period_type: 'monthly', period_start: monthStart, total_amount: amount, currency: baseCurrency, rollover, client_version: 1, server_version: null, is_deleted: false, deleted_at: null, created_at: now, updated_at: now };
    await saveLocal(db, 'budget', row as never, { base: (b as unknown as Record<string, unknown>) ?? undefined }); // base=编辑前快照:三方合并防「后推者赢」恢复旧值
    for (const item of model?.items ?? []) {
      const rec = item as unknown as Record<string, unknown>;
      const cid = String(rec.category_id);
      const draft = (catDrafts[cid] ?? '').trim();
      if (draft === '') {
        await saveLocal(db, 'budget_item', { ...rec, is_deleted: true, deleted_at: now, client_version: Number(rec.client_version ?? 0) + 1, updated_at: now } as never, { op: 'delete', base: rec });
      } else if (isValidAmount(draft) && Number(draft) > 0 && rec.amount !== draft) {
        await saveLocal(db, 'budget_item', { ...rec, amount: draft, client_version: Number(rec.client_version ?? 0) + 1, updated_at: now } as never, { base: rec });
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
            <TextInput style={styles.input} value={amount} onChangeText={(t) => setAmount(t.replace(/[^\d.]/g, ''))} keyboardType="decimal-pad" placeholder="月度总预算,如 5000" placeholderTextColor="#b4bac6" />
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
          <TextInput style={styles.input} value={amount} onChangeText={(t) => setAmount(t.replace(/[^\d.]/g, ''))} keyboardType="decimal-pad" placeholder="月度总预算" placeholderTextColor="#b4bac6" />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Pressable onPress={() => setRollover((v) => !v)} style={{ width: 20, height: 20, borderRadius: 4, backgroundColor: rollover ? '#4361ee' : '#eef0f6', alignItems: 'center', justifyContent: 'center' }}>
              {rollover ? <Text style={{ color: '#fff', fontSize: 12 }}>✓</Text> : null}
            </Pressable>
            <Text style={{ fontSize: 12, color: '#4a5160' }}>结转上月剩余(超支不倒扣)</Text>
          </View>
          {(model?.items ?? []).map((it: unknown) => {
            const rec = it as unknown as Record<string, unknown>;
            const cid = String(rec.category_id);
            return (
              <View key={cid} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 12, color: '#4a5160', width: 70 }}>分类额度</Text>
                <TextInput style={{ ...styles.input, flex: 1, minHeight: 38 }} value={catDrafts[cid] ?? ''} onChangeText={(t) => setCatDrafts((d) => ({ ...d, [cid]: t.replace(/[^\d.]/g, '') }))} keyboardType="decimal-pad" placeholder="不限" placeholderTextColor="#b4bac6" />
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

interface Tpl { id: string; name: string; type: string; amount: string; category_id: string | null; account_id: string | null }

function RecordScreen({ onSaved }: { onSaved: () => void }) {
  const [type, setType] = useState<TransactionType>('expense');
  const [amount, setAmount] = useState('');
  const [cats, setCats] = useState<Cat[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newCat, setNewCat] = useState('');
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([]);
  const [fromAcc, setFromAcc] = useState<string | null>(null);
  const [toAcc, setToAcc] = useState<string | null>(null);
  const [tpls, setTpls] = useState<Array<Tpl>>([]);
  const [note, setNote] = useState('');
  const [aiTxt, setAiTxt] = useState('');
  const [aiBusyN, setAiBusyN] = useState(false);

  const refreshAccounts = async () => {
    const ledgerId = await getActiveLedgerId();
    const rows = await db.getAllAsync<{ id: string; name: string }>(
      'SELECT id, name FROM accounts WHERE is_deleted = 0 AND ledger_id = ? ORDER BY sort', [ledgerId]);
    setAccounts(rows);
    setFromAcc((prev) => prev ?? rows[0]?.id ?? null);
    await db.execAsync(
      'CREATE TABLE IF NOT EXISTS tx_templates (id TEXT PRIMARY KEY, name TEXT, type TEXT, amount TEXT, category_id TEXT, account_id TEXT, created_at INTEGER)');
    setTpls(await db.getAllAsync<Tpl>('SELECT * FROM tx_templates ORDER BY created_at DESC LIMIT 8'));
  };

  const refreshCats = async () => {
    setCats((await topCategories(type === 'income' ? 'income' : 'expense')) as unknown as Cat[]);
  };

  useEffect(() => {
    void initDb().then(async () => {
      setAdding(false);
      setNewCat('');
      await refreshCats();
      await refreshAccounts();
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
    // T-25:支持表达式(12.5+8 → 20.5)
    const ev = evalExpr(amount);
    const v = ev ?? Number(amount);
    if (!v || v <= 0) return;
    if (type === 'transfer') {
      if (!fromAcc || !toAcc || fromAcc === toAcc) return;
    } else if (!selected) return;
    const ledgerId = await getActiveLedgerId();
    if (!ledgerId) return;
    const now = Date.now();
    const tx = {
      id: newId(), ledger_id: ledgerId, user_id: 'local', member_id: null, type,
      amount: v.toFixed(2), currency: (await metaGet(db, 'base_currency') as string) ?? 'CNY', amount_base: v.toFixed(2), exchange_rate: null,
      category_id: type === 'transfer' ? null : selected,
      account_id: fromAcc ?? (await db.getAllAsync<{ id: string }>('SELECT id FROM accounts WHERE is_deleted = 0 ORDER BY sort LIMIT 1'))[0]?.id ?? '',
      to_account_id: type === 'transfer' ? toAcc : null, happened_at: now, note: '', is_refunded: 0, refund_of_id: null,
      reimburse_status: null, exclude_from_budget: 0, attachment_count: 0, source: 'manual',
      client_version: 1, server_version: null, is_deleted: 0, deleted_at: null, created_at: now, updated_at: now,
    };
    await saveTx(tx);
    scheduleSync();
    setAmount('');
    setSelected(null);
    setNote('');
    setMsg(`已记入 ¥${v.toFixed(2)}`);
    onSaved();
    setTimeout(() => setMsg(null), 1800);
  };

  return (
    <ScrollView contentContainerStyle={styles.form}>
      <CreditBanner />
      <BudgetCard />
      <View style={styles.typeRow}>
        {(['expense', 'income', 'transfer'] as TransactionType[]).map((t) => (
          <Pressable key={t} style={[styles.typeBtn, type === t && styles.typeBtnActive]} onPress={() => { setType(t); setSelected(null); }}>
            <Text style={[styles.typeText, type === t && styles.typeTextActive]}>{t === 'expense' ? '支出' : t === 'income' ? '收入' : '转账'}</Text>
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
      <TextInput style={styles.input} value={note} onChangeText={(t) => setNote(t.slice(0, 500))} placeholder="备注(可选,如 打车/工资)" placeholderTextColor="#b4bac6" />
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <TextInput
          style={{ ...styles.input, flex: 1 }}
          value={aiTxt}
          onChangeText={(t) => setAiTxt(t.slice(0, 200))}
          placeholder="🤖 文字记账:如「昨天打车25块」"
          placeholderTextColor="#b4bac6"
          onSubmitEditing={() => {
            void (async () => {
              if (!aiTxt.trim() || aiBusyN) return;
              setAiBusyN(true);
              try {
                await initDb();
                const ledgerId = await getActiveLedgerId();
                const cats = await db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM categories WHERE is_deleted = 0 AND ledger_id = ?', [ledgerId]);
                const r = await aiParse(aiTxt.trim(), cats.map((c) => c.name));
                setAmount(String(r.amount));
                setType(r.type);
                const match = cats.find((c) => c.name === r.category);
                if (match) setSelected(match.id);
                setNote(r.note);
                if (r.day) { /* day 不改当前选中日期,仅提示 */ }
                setAiTxt('');
                setMsg(`AI 已解析 ¥${r.amount}${r.category ? ` · ${r.category}` : ''},请确认后保存`);
                setTimeout(() => setMsg(null), 2500);
              } catch (e) {
                setMsg(`AI 解析失败:${e instanceof Error ? e.message : String(e)}`);
                setTimeout(() => setMsg(null), 3000);
              } finally { setAiBusyN(false); }
            })();
          }}
        />
        <Pressable style={{ ...styles.saveBtn, paddingHorizontal: 12, ...(aiBusyN && styles.disabled) }} onPress={() => {
          void (async () => {
            if (!aiTxt.trim() || aiBusyN) return;
            setAiBusyN(true);
            try {
              await initDb();
              const ledgerId = await getActiveLedgerId();
              const cats = await db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM categories WHERE is_deleted = 0 AND ledger_id = ?', [ledgerId]);
              const r = await aiParse(aiTxt.trim(), cats.map((c) => c.name));
              setAmount(String(r.amount));
              setType(r.type);
              const match = cats.find((c) => c.name === r.category);
              if (match) setSelected(match.id);
              setNote(r.note);
              setAiTxt('');
              setMsg(`AI 已解析 ¥${r.amount}${r.category ? ` · ${r.category}` : ''},请确认后保存`);
              setTimeout(() => setMsg(null), 2500);
            } catch (e) {
              setMsg(`AI 解析失败:${e instanceof Error ? e.message : String(e)}`);
              setTimeout(() => setMsg(null), 3000);
            } finally { setAiBusyN(false); }
          })();
        }}>
          <Text style={styles.saveText}>解析</Text>
        </Pressable>
      </View>
      {tpls.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }} contentContainerStyle={{ gap: 6 }}>
          {tpls.map((t) => (
            <Pressable key={t.id} style={{ backgroundColor: '#fff', borderRadius: 14, paddingVertical: 6, paddingHorizontal: 12, borderWidth: 1, borderColor: '#e3e6ee' }}
              onPress={() => {
                setType(t.type as TransactionType);
                setAmount(t.amount);
                setSelected(t.category_id);
                setFromAcc(t.account_id ?? fromAcc);
                setMsg(`已预填「${t.name}」`);
                setTimeout(() => setMsg(null), 1200);
              }}>
              <Text style={{ fontSize: 12, color: '#1a1c23' }}>⚡ {t.name} ¥{formatAmount(t.amount)}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      {type === 'transfer' ? (
        <View style={{ gap: 8, marginBottom: 8 }}>
          {([['转出账户', fromAcc, setFromAcc], ['转入账户', toAcc, setToAcc]] as const).map(([label, val, setter], idx) => (
            <View key={label}>
              <Text style={{ fontSize: 12, color: '#4a5160', marginBottom: 4 }}>{label}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {accounts.map((a) => (
                  <Pressable key={a.id} onPress={() => setter(a.id)}
                    style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 14, backgroundColor: val === a.id ? '#4361ee' : '#eef0f6' }}>
                    <Text style={{ fontSize: 12, color: val === a.id ? '#fff' : '#4a5160' }}>{a.name}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
        </View>
      ) : (
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
      )}
      <Pressable style={[styles.saveBtn, (!amount || (type !== 'transfer' && !selected) || (type === 'transfer' && (!fromAcc || fromAcc === toAcc))) && styles.disabled]} onPress={() => void save()}>
        <Text style={styles.saveText}>保存{amount ? (() => { const ev = evalExpr(amount); return ` ¥${formatAmount(String(ev ?? Number(amount)))}`; })() : ''}</Text>
      </Pressable>
      {amount && (type === 'transfer' ? fromAcc && toAcc : selected) && (
        <Pressable style={{ alignItems: 'center', padding: 6 }} onPress={() => {
          void (async () => {
            await initDb();
            const catName = cats.find((c) => c.id === selected)?.name ?? '转账';
            const tplName = `${catName}${new Date().getMonth() + 1}/${new Date().getDate()}`;
            if (!tplName) return;
            await db.execAsync('CREATE TABLE IF NOT EXISTS tx_templates (id TEXT PRIMARY KEY, name TEXT, type TEXT, amount TEXT, category_id TEXT, account_id TEXT, created_at INTEGER)');
            await db.runAsync('INSERT INTO tx_templates (id, name, type, amount, category_id, account_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [newId(), tplName, type, amount, selected, fromAcc, Date.now()]);
            await refreshAccounts(); // 复用:重新加载模板
            setMsg(`已存模板「${tplName}」`);
            setTimeout(() => setMsg(null), 1500);
          })();
        }}>
          <Text style={{ fontSize: 12, color: '#8a93a5' }}>⚡ 存为快捷模板</Text>
        </Pressable>
      )}
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

function ListScreen({ drillCat, onClearDrill }: { drillCat: string | null; onClearDrill: () => void }) {
  const [rows, setRows] = useState<Array<TransactionRow & { cat_name?: string; cat_icon?: string }>>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const [typeFilter, setTypeFilter] = useState<'all' | 'expense' | 'income'>('all');
  const [kw, setKw] = useState('');
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [monthSum, setMonthSum] = useState<{ income: number; expense: number }>({ income: 0, expense: 0 });
  const [editRow, setEditRow] = useState<TransactionRow | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editNote, setEditNote] = useState('');
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([]);
  const [view, setView] = useState<'active' | 'calendar' | 'recycled'>('active');
  const [minAmt, setMinAmt] = useState('');
  const [maxAmt, setMaxAmt] = useState('');
  const [accFilter, setAccFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showAdv, setShowAdv] = useState(false);
  const mr = monthRange(monthOffset);

  useEffect(() => { if (drillCat) void load(0, true); }, [drillCat]); // eslint-disable-line react-hooks/exhaustive-deps
  const calDays = (() => {
    const m = new Map<number, number>();
    for (const t of rows) {
      if (t.is_deleted) continue;
      const day = new Date(t.happened_at).getDate();
      m.set(day, (m.get(day) ?? 0) + Number(t.amount));
    }
    const dim = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    return Array.from({ length: dim }, (_, i) => ({ day: i + 1, spend: m.get(i + 1) ?? 0 }));
  })();

  const [calSel, setCalSel] = useState<number | null>(null);

  const load = async (off: number, replace: boolean) => {
    setBusy(true);
    try {
      await initDb();
      const ledgerId = await getActiveLedgerId();
      if (!ledgerId) return;
      void db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM accounts WHERE is_deleted = 0 AND ledger_id = ? ORDER BY sort', [ledgerId]).then(setAccounts);
      const recycled = view === 'recycled';
      const clauses = [recycled ? 't.is_deleted = 1' : 't.is_deleted = 0', 't.ledger_id = ?'];
      const params: Array<string | number> = [ledgerId];
      if (!recycled) { clauses.push('t.happened_at >= ?', 't.happened_at < ?'); params.push(mr.start, mr.end); }
      if (typeFilter !== 'all') { clauses.push('t.type = ?'); params.push(typeFilter); }
      if (kw.trim()) { clauses.push('(t.note LIKE ? OR EXISTS (SELECT 1 FROM categories cx WHERE cx.id = t.category_id AND cx.name LIKE ?))'); params.push(`%${kw.trim()}%`, `%${kw.trim()}%`); }
      if (minAmt) { clauses.push('CAST(t.amount AS REAL) >= ?'); params.push(Number(minAmt)); }
      if (maxAmt) { clauses.push('CAST(t.amount AS REAL) <= ?'); params.push(Number(maxAmt)); }
      if (accFilter !== 'all') { clauses.push('(t.account_id = ? OR t.to_account_id = ?)'); params.push(accFilter, accFilter); }
      if (dateFrom) { clauses.push('t.happened_at >= ?'); params.push(new Date(dateFrom).getTime()); }
      if (dateTo) { clauses.push('t.happened_at < ?'); params.push(new Date(dateTo).getTime() + 86_399_000); }
      if (drillCat) { clauses.push('t.category_id = ?'); params.push(drillCat); }
      const where = clauses.join(' AND ');
      // 真机 SQLCipher 对「ORDER BY + LIMIT/OFFSET」分页形状会返回空(汇总同 WHERE 却有数;
      // 上轮 JOIN 同类问题),改为 WHERE 下推 + JS 层排序分页;查询异常显式展示,不再静默空白
      let got: TransactionRow[];
      try {
        got = await db.getAllAsync<TransactionRow>(
          `SELECT t.* FROM transactions t WHERE ${where}`,
          params,
        );
      } catch (e) {
        setListErr(e instanceof Error ? e.message : String(e));
        return;
      }
      setListErr(null);
      got.sort((a, b) => Number(b.happened_at) - Number(a.happened_at));
      const page = got.slice(off, off + PAGE);
      const catRows = await db.getAllAsync<{ id: string; name: string; icon: string }>(
        'SELECT id, name, icon FROM categories WHERE is_deleted = 0 AND ledger_id = ?', [ledgerId]);
      const catMap = new Map(catRows.map((c) => [c.id, c]));
      const withCat = page.map((t) => {
        const c = t.category_id ? catMap.get(String(t.category_id)) : undefined;
        return { ...t, cat_name: c?.name, cat_icon: c?.icon };
      });
      setRows((prev) => (replace ? withCat : [...prev, ...withCat]));
      setHasMore(off + PAGE < got.length);
      if (!recycled) {
        const sums = await db.getAllAsync<{ type: string; s: number }>(
          `SELECT type, SUM(CAST(amount AS REAL)) AS s FROM transactions t WHERE ${where} GROUP BY type`, params);
        setMonthSum({
          income: Number(sums.find((r) => r.type === 'income')?.s ?? 0),
          expense: Number(sums.find((r) => r.type === 'expense')?.s ?? 0),
        });
      }
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
      <View style={{ flexDirection: 'row', paddingHorizontal: 12, paddingTop: 8, gap: 8 }}>
        {(['active', 'calendar', 'recycled'] as const).map((v) => (
          <Pressable key={v} onPress={() => setView(v)}
            style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12, backgroundColor: view === v ? '#1a1c23' : '#eef0f6' }}>
            <Text style={{ fontSize: 12, color: view === v ? '#fff' : '#4a5160' }}>{v === 'active' ? '流水' : v === 'calendar' ? '📅 日历' : '🗑 回收站'}</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => setShowAdv((v) => !v)} style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12, backgroundColor: '#eef0f6' }}>
          <Text style={{ fontSize: 12, color: '#4a5160' }}>筛选 ▾</Text>
        </Pressable>
      </View>
      {showAdv && (
        <View style={{ paddingHorizontal: 12, paddingVertical: 6, gap: 6, backgroundColor: '#fff', borderRadius: 10, marginHorizontal: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput style={{ ...styles.input, flex: 1, minHeight: 36 }} value={minAmt} onChangeText={setMinAmt} keyboardType="decimal-pad" placeholder="金额≥" placeholderTextColor="#b4bac6" />
            <TextInput style={{ ...styles.input, flex: 1, minHeight: 36 }} value={maxAmt} onChangeText={setMaxAmt} keyboardType="decimal-pad" placeholder="金额≤" placeholderTextColor="#b4bac6" />
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Pressable onPress={() => setAccFilter('all')} style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 10, backgroundColor: accFilter === 'all' ? '#4361ee' : '#eef0f6' }}>
              <Text style={{ fontSize: 11, color: accFilter === 'all' ? '#fff' : '#4a5160' }}>全部账户</Text>
            </Pressable>
            {accounts.map((a) => (
              <Pressable key={a.id} onPress={() => setAccFilter(a.id)} style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 10, backgroundColor: accFilter === a.id ? '#4361ee' : '#eef0f6' }}>
                <Text style={{ fontSize: 11, color: accFilter === a.id ? '#fff' : '#4a5160' }}>{a.name}</Text>
              </Pressable>
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput style={{ ...styles.input, flex: 1, minHeight: 36 }} value={dateFrom} onChangeText={setDateFrom} placeholder="开始日期 2026-10-01" placeholderTextColor="#b4bac6" />
            <TextInput style={{ ...styles.input, flex: 1, minHeight: 36 }} value={dateTo} onChangeText={setDateTo} placeholder="结束日期 2026-10-31" placeholderTextColor="#b4bac6" />
          </View>
        </View>
      )}
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
      {view === 'calendar' && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 8 }}>
          {calDays.map((d) => (
            <Pressable key={d.day} style={{ backgroundColor: d.spend > 0 ? '#fff' : '#f0f1f5', borderRadius: 10, padding: 12 }}
              onPress={() => setCalSel(calSel === d.day ? null : d.day)}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#1a1c23' }}>{d.day} 日</Text>
                <Text style={{ fontSize: 13, color: d.spend > 0 ? '#d64545' : '#b4bac6' }}>{d.spend > 0 ? `¥${formatAmount(String(d.spend))}` : '-'}</Text>
              </View>
              {calSel === d.day && (
                <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: '#f0f1f5', paddingTop: 6, gap: 4 }}>
                  {rows.filter((t) => new Date(t.happened_at).getDate() === d.day).map((t) => (
                    <View key={t.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 12, color: '#4a5160' }}>{t.note || t.cat_name || t.type}</Text>
                      <Text style={{ fontSize: 12, color: '#1a1c23' }}>¥{formatAmount(String(t.amount))}</Text>
                    </View>
                  ))}
                </View>
              )}
            </Pressable>
          ))}
        </ScrollView>
      )}
      {view !== 'calendar' && (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}
        scrollEventThrottle={200}
        onScroll={(e) => {
          const { y, ch, chh } = { y: e.nativeEvent.contentOffset.y, ch: e.nativeEvent.layoutMeasurement.height, chh: e.nativeEvent.contentSize.height };
          if (hasMore && !busy && y + ch >= chh - 240) { const n = offset + PAGE; setOffset(n); void load(n, false); }
        }}>
        {rows.map((t) => (
          <Pressable key={t.id} style={styles.txRow} onPress={() => { setEditRow(t); setEditAmount(String(t.amount)); setEditNote(String(t.note ?? '')); }}>
            <View style={styles.txMain}>
              <Text style={styles.txNote}>{t.note || t.cat_name || (t.type === 'income' ? '收入' : t.type === 'transfer' ? '转账' : '支出')}{t.type === 'transfer' ? ' → ' + (accounts.find((a) => a.id === t.to_account_id)?.name ?? '') : ''}</Text>
              <Text style={styles.txDate}>{new Date(t.happened_at).toLocaleString('zh-CN')}{t.cat_name ? ` · ${t.cat_name}` : ''}</Text>
            </View>
            {view === 'recycled' ? (
              <Pressable onPress={() => { void (async () => { await saveLocal(db, 'transaction', { ...t, is_deleted: false, deleted_at: null, client_version: Number(t.client_version ?? 0) + 1, updated_at: Date.now() } as never); setOffset(0); void load(0, true); scheduleSync(); })(); }}>
                <Text style={{ color: '#1f9d6c', fontSize: 13 }}>恢复</Text>
              </Pressable>
            ) : (
            <Text style={[styles.txAmount, { color: t.type === 'income' ? '#1f9d6c' : '#1a1c23' }]}>
              {t.type === 'income' ? '+' : '-'}¥{formatAmount(String(t.amount))}
            </Text>
            )}
          </Pressable>
        ))}
        {rows.length === 0 && !busy && <Text style={listErr ? { color: '#d64545', fontSize: 12 } : styles.muted}>{listErr ? `列表查询失败:${listErr}` : '本月暂无流水'}</Text>}
        {hasMore && (
          <Pressable style={{ alignItems: 'center', padding: 10 }} onPress={() => { const n = offset + PAGE; setOffset(n); void load(n, false); }}>
            <Text style={{ color: '#4361ee', fontSize: 13 }}>加载更多</Text>
          </Pressable>
        )}
      </ScrollView>
      )}
      {editRow && (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: '#fff', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, gap: 10 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#1a1c23' }}>编辑流水</Text>
            {editRow.type !== 'transfer' && (
              <TextInput style={styles.input} value={editAmount} onChangeText={(t) => setEditAmount(t.replace(/[^\d.]/g, ''))} keyboardType="decimal-pad" placeholder="金额" placeholderTextColor="#b4bac6" />
            )}
            <TextInput style={styles.input} value={editNote} onChangeText={(t) => setEditNote(t)} placeholder="备注" placeholderTextColor="#b4bac6" />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable style={{ ...styles.saveBtn, flex: 1 }}
                onPress={() => {
                  const now = Date.now();
                  const patch: Record<string, unknown> = { client_version: Number(editRow.client_version ?? 0) + 1, updated_at: now };
                  if (editRow.type !== 'transfer' && isValidAmount(editAmount) && Number(editAmount) > 0) {
                    patch.amount = Number(editAmount).toFixed(2); patch.amount_base = Number(editAmount).toFixed(2);
                  }
                  patch.note = editNote;
                  void (async () => {
                    await saveLocal(db, 'transaction', { ...editRow, ...patch } as never);
                    setEditRow(null); setOffset(0); void load(0, true); scheduleSync();
                  })();
                }}>
                <Text style={styles.saveText}>保存</Text>
              </Pressable>
              <Pressable style={{ ...styles.saveBtn, flex: 1, backgroundColor: '#d64545' }}
                onPress={() => {
                  const now = Date.now();
                  void (async () => {
                    await saveLocal(db, 'transaction', { ...editRow, is_deleted: true, deleted_at: now, client_version: Number(editRow.client_version ?? 0) + 1, updated_at: now } as never, { op: 'delete' });
                    setEditRow(null); setOffset(0); void load(0, true); scheduleSync();
                  })();
                }}>
                <Text style={styles.saveText}>删除</Text>
              </Pressable>
              <Pressable style={{ ...styles.saveBtn, flex: 1, backgroundColor: '#eef0f6' }} onPress={() => setEditRow(null)}>
                <Text style={{ ...styles.saveText, color: '#1a1c23' }}>取消</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

function ReportScreen({ onDrill }: { onDrill: (catId: string) => void }) {
  const [aiText, setAiText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  // N5 对话式查询「问一问」
  const [askText, setAskText] = useState('');
  const [askAnswer, setAskAnswer] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [monthOffset, setMonthOffset] = useState(0);
  const [sum, setSum] = useState({ income: 0, expense: 0 });
  const [byCat, setByCat] = useState<Array<{ name: string; icon: string; total: number; pct: number; catId: string | null }>>([]);
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
      const cats = await db.getAllAsync<{ name: string; icon: string; s: number; catId: string | null }>(
        `SELECT COALESCE(c.name, '未分类') AS name, COALESCE(c.icon, '📦') AS icon, t.category_id AS catId,
                SUM(CAST(t.amount AS REAL)) AS s
         FROM transactions t LEFT JOIN categories c ON t.category_id = c.id
         WHERE ${base} AND t.type = 'expense' GROUP BY t.category_id ORDER BY s DESC LIMIT 10`, bparams);
      const max = Number(cats[0]?.s ?? 0) || 1;
      setByCat(cats.map((r) => ({ name: r.name, icon: r.icon, total: Number(r.s), pct: Math.round((Number(r.s) / max) * 100), catId: r.catId })));
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
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: '#1a1c23' }}>支出分类排行 Top10</Text>
            <Pressable style={{ backgroundColor: '#eef0f6', borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8 }}
              onPress={() => {
                setAiBusy(true); setAiText('');
                void (async () => {
                  try {
                    const r = await aiInsights({
                      month: monthOffset === 0 ? '本月' : mr.label,
                      income: String(sum.income), expense: String(sum.expense),
                      budget: null,
                      topCategories: byCat.slice(0, 10).map((c) => ({ name: c.name, amount: String(c.total) })),
                      recentTxs: [],
                    });
                    setAiText(r.text);
                  } catch (e) { setAiText(`分析失败:${e instanceof Error ? e.message : String(e)}`); }
                  finally { setAiBusy(false); }
                })();
              }}>
              <Text style={{ fontSize: 12, color: '#4361ee' }}>{aiBusy ? '分析中…' : '🤖 AI 分析'}</Text>
            </Pressable>
          </View>
          {aiText && <Text style={{ fontSize: 12, color: '#1a1c23', lineHeight: 18, marginBottom: 10, backgroundColor: '#f6f7ff', borderRadius: 8, padding: 8 }}>{aiText}</Text>}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
            <TextInput
              style={{ ...styles.input, flex: 1, minHeight: 36 }}
              value={askText}
              onChangeText={(t) => setAskText(t.slice(0, 200))}
              placeholder="🤖 问一问:如「这个月吃饭花多少」"
              placeholderTextColor="#b4bac6"
              onSubmitEditing={() => {
                void (async () => {
                  const q = askText.trim();
                  if (!q || askBusy) return;
                  setAskBusy(true); setAskAnswer('');
                  try {
                    const top = byCat.slice(0, 10).map((c) => `${c.name} ${c.total}元`).join('、');
                    const ctx = `记账数据(${monthOffset === 0 ? '本月' : mr.label}):收入 ${sum.income} 元,支出 ${sum.expense} 元。支出分类排行: ${top || '无'}。`;
                    const r = await aiChat(`${ctx}\n用户问题: ${q}`);
                    setAskAnswer(r.text);
                  } catch (e) { setAskAnswer(`问答失败:${e instanceof Error ? e.message : String(e)}`); }
                  finally { setAskBusy(false); }
                })();
              }}
            />
            <Pressable style={{ backgroundColor: askBusy || !askText.trim() ? '#b4bac6' : '#4361ee', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, justifyContent: 'center' }}
              disabled={askBusy || !askText.trim()}
              onPress={() => {
                void (async () => {
                  const q = askText.trim();
                  if (!q || askBusy) return;
                  setAskBusy(true); setAskAnswer('');
                  try {
                    const top = byCat.slice(0, 10).map((c) => `${c.name} ${c.total}元`).join('、');
                    const ctx = `记账数据(${monthOffset === 0 ? '本月' : mr.label}):收入 ${sum.income} 元,支出 ${sum.expense} 元。支出分类排行: ${top || '无'}。`;
                    const r = await aiChat(`${ctx}\n用户问题: ${q}`);
                    setAskAnswer(r.text);
                  } catch (e) { setAskAnswer(`问答失败:${e instanceof Error ? e.message : String(e)}`); }
                  finally { setAskBusy(false); }
                })();
              }}>
              <Text style={{ color: '#fff', fontSize: 12 }}>{askBusy ? '思考中…' : '提问'}</Text>
            </Pressable>
          </View>
          {askAnswer && <Text style={{ fontSize: 12, color: '#1a1c23', lineHeight: 18, marginBottom: 10, backgroundColor: '#f6f7ff', borderRadius: 8, padding: 8 }}>{askAnswer}</Text>}
          {byCat.length === 0 && <Text style={{ color: '#8a93a5', fontSize: 12 }}>本月暂无支出</Text>}
          {byCat.map((c, i) => (
            <Pressable key={c.name + i} style={{ marginBottom: 10 }} onPress={() => onDrill(String(c.catId ?? ''))}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={{ fontSize: 12, color: '#1a1c23' }}>{c.icon} {c.name}</Text>
                <Text style={{ fontSize: 12, color: '#4a5160' }}>¥{formatAmount(String(c.total))}</Text>
              </View>
              <View style={{ height: 6, backgroundColor: '#eef0f6', borderRadius: 3 }}>
                <View style={{ height: 6, width: `${Math.max(4, c.pct)}%`, backgroundColor: i === 0 ? '#4361ee' : '#8fa3f5', borderRadius: 3 }} />
              </View>
            </Pressable>
          ))}
          {busy && <Text style={{ color: '#8a93a5', fontSize: 12 }}>加载中…</Text>}
        </View>
      </ScrollView>
    </View>
  );
}

/** 账本管理:多账本切换 / 新建 / 重命名 */
function LedgerManager({ onBack }: { onBack: () => void }) {
  const [ledgers, setLedgers] = useState<Array<Record<string, unknown> & { active?: number }>>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [delTarget, setDelTarget] = useState<Record<string, unknown> | null>(null);
  const [delPreview, setDelPreview] = useState<Record<string, number>>({});

  const load = async () => {
    await initDb();
    const active = await getActiveLedgerId();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM ledgers WHERE is_deleted = 0 ORDER BY created_at ASC');
    setLedgers(rows.map((r) => ({ ...r, active: String(r.id) === String(active) ? 1 : 0 })));
    // 级联影响预览(T-14):每账本统计将随之软删的实体数
    const ledgerId = active;
    void ledgerId;
    for (const r of rows) {
      const lid = String(r.id);
      const n = await db.getAllAsync<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM transactions WHERE ledger_id = ? AND is_deleted = 0)
              + (SELECT COUNT(*) FROM categories WHERE ledger_id = ? AND is_deleted = 0)
              + (SELECT COUNT(*) FROM accounts WHERE ledger_id = ? AND is_deleted = 0) AS n`, [lid, lid, lid]);
      setDelPreview((prev) => ({ ...prev, [lid]: Number(n[0]?.n ?? 0) }));
    }
  };
  useEffect(() => { void load(); }, []);

  const switchTo = async (id: string) => {
    await metaSet(db, 'active_ledger', id);
    onBack();
  };

  const create = async () => {
    const nm = name.trim().slice(0, 30);
    if (!nm) return;
    const id = await createLedgerWithSeed(nm); // T-03:播种默认分类与账户,修复新账本无分类可用
    await metaSet(db, 'active_ledger', id);
    setName(''); setCreating(false);
    onBack();
  };

  const rename = async (row: Record<string, unknown>) => {
    const nm = draft.trim().slice(0, 30);
    setEditingId(null);
    if (!nm || nm === row.name) return;
    const now = Date.now();
    await saveLocal(db, 'ledger', { ...row, name: nm, client_version: Number(row.client_version ?? 0) + 1, updated_at: now } as never);
    void load();
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#f6f7f9' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Pressable onPress={onBack}><Text style={{ fontSize: 16, color: '#4361ee' }}>‹ 返回</Text></Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: '#1a1c23' }}>账本管理</Text>
        <Pressable onPress={() => setCreating((v) => !v)}><Text style={{ fontSize: 20, color: '#4361ee' }}>＋</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
        {ledgers.map((row) => {
          const id = String(row.id);
          return (
            <View key={id} style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, borderWidth: row.active ? 2 : 0, borderColor: '#4361ee' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 18 }}>{String(row.icon ?? '📒')}</Text>
                {editingId === id ? (
                  <TextInput
                    style={{ flex: 1, borderBottomWidth: 1, borderColor: '#4361ee', fontSize: 14, color: '#1a1c23', paddingVertical: 2 }}
                    value={draft} autoFocus onChangeText={(t) => setDraft(t.slice(0, 30))}
                    onSubmitEditing={() => void rename(row)} onBlur={() => void rename(row)}
                  />
                ) : (
                  <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: '#1a1c23' }}>
                    {String(row.name)}{row.active ? ' · 当前' : ''}
                  </Text>
                )}
                {editingId !== id && (
                  <Pressable onPress={() => { setEditingId(id); setDraft(String(row.name)); }}>
                    <Text style={{ color: '#4361ee', fontSize: 13 }}>重命名</Text>
                  </Pressable>
                )}
              </View>
              {!row.active && (
                <>
                  <Pressable style={{ marginTop: 8, backgroundColor: '#eef0f6', borderRadius: 8, paddingVertical: 6, alignItems: 'center' }}
                    onPress={() => void switchTo(id)}>
                    <Text style={{ fontSize: 12, color: '#1a1c23' }}>切换到此账本</Text>
                  </Pressable>
                  <Pressable style={{ marginTop: 6 }} onPress={() => setDelTarget({ ...row, ...delPreview })}>
                    <Text style={{ color: '#d64545', fontSize: 12 }}>删除此账本</Text>
                  </Pressable>
                </>
              )}
            </View>
          );
        })}
        {creating && (
          <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, gap: 8 }}>
            <TextInput style={styles.input} value={name} onChangeText={(t) => setName(t.slice(0, 30))} placeholder="新账本名称" placeholderTextColor="#b4bac6" autoFocus />
            <Pressable style={[styles.saveBtn, !name && styles.disabled]} onPress={() => void create()}>
              <Text style={styles.saveText}>创建并切换</Text>
            </Pressable>
          </View>
        )}
        <Text style={{ fontSize: 11, color: '#8a93a5', textAlign: 'center' }}>切换账本后,记账/明细/报表都会显示所选账本的数据</Text>
      </ScrollView>
      {delTarget && (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center' }}>
          <View style={{ backgroundColor: '#fff', borderRadius: 12, margin: 24, padding: 16, gap: 10 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#d64545' }}>删除账本「{String(delTarget.name)}」?</Text>
            <Text style={{ fontSize: 12, color: '#4a5160' }}>
              将级联软删除该账本下约 {delPreview[String(delTarget.id)] ?? 0} 条记录(流水/分类/账户等)。此操作可从回收站恢复部分数据,但默认不可见。
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable style={{ ...styles.saveBtn, flex: 1, backgroundColor: '#eef0f6' }} onPress={() => setDelTarget(null)}>
                <Text style={{ ...styles.saveText, color: '#1a1c23' }}>取消</Text>
              </Pressable>
              <Pressable style={{ ...styles.saveBtn, flex: 2, backgroundColor: '#d64545' }}
                onPress={() => {
                  void (async () => {
                    const lid = String(delTarget.id);
                    const now = Date.now();
                    const tables: Array<[string, string]> = [
                      ['transactions', 'ledger_id'], ['categories', 'ledger_id'], ['accounts', 'ledger_id'],
                      ['budgets', 'ledger_id'], ['budget_items', 'ledger_id'],
                      ['recurring_rules', 'ledger_id'], ['savings_plans', 'ledger_id'],
                    ];
                    for (const [t, col] of tables) {
                      const rowsToDel = await db.getAllAsync<Record<string, unknown>>(
                        `SELECT * FROM ${t} WHERE ${col} = ? AND is_deleted = 0`, [lid]);
                      for (const r of rowsToDel) {
                        await saveLocal(db, t === 'transactions' ? 'transaction' : t === 'categories' ? 'category' : t === 'accounts' ? 'account' : t === 'budgets' ? 'budget' : t === 'budget_items' ? 'budget_item' : t === 'recurring_rules' ? 'recurring_rule' : 'savings_plan',
                          { ...r, is_deleted: true, deleted_at: now, client_version: Number(r.client_version ?? 0) + 1, updated_at: now } as never, { op: 'delete' });
                      }
                    }
                    await saveLocal(db, 'ledger', { ...delTarget, is_deleted: true, deleted_at: now, client_version: Number(delTarget.client_version ?? 0) + 1, updated_at: now } as never, { op: 'delete' });
                    setDelTarget(null);
                    scheduleSync();
                    await load();
                  })();
                }}>
                <Text style={styles.saveText}>确认删除</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

/** 手写账导出:选月份 → 生成手写账文本 → 分享/复制 */
function ExportLedger({ onBack }: { onBack: () => void }) {
  const [monthOffset, setMonthOffset] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const mr = monthRange(monthOffset);
  const d0 = new Date();
  d0.setMonth(d0.getMonth() - monthOffset);
  const year = d0.getFullYear(), month = d0.getMonth() + 1;

  const load = async () => {
    setBusy(true);
    try {
      await initDb();
      const ledgerId = await getActiveLedgerId();
      const cats = await db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM categories WHERE is_deleted = 0 AND ledger_id = ?', [ledgerId]);
      const catNameOf = (cid: string | null | undefined) => cats.find((c) => c.id === cid)?.name ?? '';
      const txs = await db.getAllAsync<never>('SELECT * FROM transactions WHERE is_deleted = 0 AND ledger_id = ?', [ledgerId]);
      setText(renderTextLedger(txs as never, year, month, catNameOf));
    } finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [monthOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ flex: 1, backgroundColor: '#f6f7f9' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Pressable onPress={onBack}><Text style={{ fontSize: 16, color: '#4361ee' }}>‹ 返回</Text></Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: '#1a1c23' }}>导出与备份</Text>
        <Text style={{ fontSize: 16, color: 'transparent' }}>‹</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingBottom: 6 }}>
        <Pressable onPress={() => setMonthOffset((m) => m + 1)}><Text style={{ fontSize: 18, color: '#4a5160' }}>‹</Text></Pressable>
        <Text style={{ fontWeight: '700', color: '#1a1c23' }}>{mr.label}</Text>
        {monthOffset > 0
          ? <Pressable onPress={() => setMonthOffset((m) => Math.max(0, m - 1))}><Text style={{ fontSize: 18, color: '#4a5160' }}>›</Text></Pressable>
          : <Text style={{ fontSize: 18, color: 'transparent' }}>›</Text>}
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 10 }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 10, padding: 10 }}>
          <Text style={{ fontSize: 12, color: '#1a1c23', fontFamily: 'monospace' }}>{text || (busy ? '生成中…' : '本月无支出')}</Text>
        </View>
        <Text style={{ fontSize: 12, fontWeight: '700', color: '#1a1c23' }}>📄 手写账文本</Text>
        <Pressable style={styles.saveBtn} onPress={() => { void import('react-native').then((rn) => void rn.Share.share({ message: text })); }}>
          <Text style={styles.saveText}>分享 / 复制文本</Text>
        </Pressable>
        <Text style={{ fontSize: 11, color: '#8a93a5', textAlign: 'center' }}>分享面板里可选择"拷贝到备忘录"等实现复制</Text>
        <CsvExportSection monthOffset={monthOffset} />
      </ScrollView>
    </View>
  );
}


/** CSV 导出(T-23):列与 Web buildCsv 完全一致(BOM/转义/公式注入防护下沉 @ledgerone/domain 共享);
 *  经系统分享面板交付(免原生文件依赖),文件名规范同 Web。 */
function CsvExportSection({ monthOffset }: { monthOffset: number }) {
  const [scope, setScope] = useState<'month' | 'all'>('month');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  // 审查修复(P2):Android Share 走 Intent EXTRA_TEXT,超 binder ~1MB 限制会抛
  // TransactionTooLargeException 崩应用 —— 超阈值拦截并提示分月导出
  const SHARE_MAX_CHARS = 500_000;
  const share = (name: string, csv: string) => {
    if (csv.length > SHARE_MAX_CHARS) {
      setDone(`⚠️ ${name} 数据量过大(${(csv.length / 1024 / 1024).toFixed(1)}MB),系统分享通道放不下——请切换「本月」分月导出`);
      return;
    }
    void import('react-native').then((rn) => void rn.Share.share({ message: csv, title: name }));
    setDone(name);
  };

  const exportCsv = (kind: 'tx' | 'acc' | 'cat') => {
    void (async () => {
      setBusy(true);
      try {
        await initDb();
        const ledgerId = await getActiveLedgerId();
        const ledger = (await db.getAllAsync<{ name: string }>('SELECT name FROM ledgers WHERE id = ?', [ledgerId]))[0];
        const ledgerName = String(ledger?.name ?? '账本');
        const mr = monthRange(monthOffset);
        const start = scope === 'month' ? mr.start : 0;
        const end = scope === 'month' ? mr.end : Date.now() + 86_399_000;
        const rn = await import('react-native');
        if (kind === 'tx') {
          const cats = await db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM categories WHERE is_deleted = 0');
          const accs = await db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM accounts WHERE is_deleted = 0');
          const catMap = new Map(cats.map((c) => [c.id, c.name]));
          const accMap = new Map(accs.map((a) => [a.id, a.name]));
          const rows = await db.getAllAsync<{ happened_at: number; type: string; amount: string; currency: string; amount_base: string; category_id: string | null; account_id: string | null; to_account_id: string | null; note: string | null; source: string }>(
            'SELECT happened_at, type, amount, currency, amount_base, category_id, account_id, to_account_id, note, source FROM transactions WHERE is_deleted = 0 AND ledger_id = ? AND happened_at >= ? AND happened_at < ? ORDER BY happened_at', [ledgerId, start, end]);
          const csv = buildCsv(
            ['时间', '类型', '金额', '币种', '折算金额', '分类', '账户', '转账目标账户', '备注', '来源'],
            rows.map((t) => [
              new Date(Number(t.happened_at)).toLocaleString('zh-CN'),
              t.type === 'expense' ? '支出' : t.type === 'income' ? '收入' : '转账',
              t.amount, t.currency, t.amount_base,
              t.category_id ? (catMap.get(t.category_id) ?? '') : '',
              t.account_id ? (accMap.get(t.account_id) ?? '') : '',
              t.to_account_id ? (accMap.get(t.to_account_id) ?? '') : '',
              t.note ?? '', t.source,
            ]));
          share(exportFileName(ledgerName, start, end - 1), csv);
        } else if (kind === 'acc') {
          const accs = await db.getAllAsync<{ id: string; name: string; type: string; initial_balance: string; currency: string; include_in_net: number | boolean; is_archived: number | boolean }>(
            'SELECT id, name, type, initial_balance, currency, include_in_net, is_archived FROM accounts WHERE is_deleted = 0 AND ledger_id = ? ORDER BY sort', [ledgerId]);
          const txs = await db.getAllAsync<never>('SELECT * FROM transactions WHERE is_deleted = 0 AND ledger_id = ?', [ledgerId]);
          const TYPE_NAME: Record<string, string> = { cash: '现金', debit_card: '储蓄卡', credit_card: '信用卡', payable: '应付款' };
          const csv = buildCsv(
            ['名称', '类型', '初始余额', '当前余额', '币种', '计入净值', '已归档'],
            accs.map((a) => [
              a.name, TYPE_NAME[a.type] ?? a.type, a.initial_balance,
              accountBalance(String(a.initial_balance ?? '0'), String(a.id), txs),
              a.currency,
              (a.include_in_net ? 1 : 0) === 1 ? '是' : '否',
              (a.is_archived ? 1 : 0) === 1 ? '是' : '否',
            ]));
          share(exportFileName(`${ledgerName}_账户`, start, end - 1), csv);
        } else {
          const cats = await db.getAllAsync<{ name: string; parent_id: string | null; kind: string; icon: string | null }>(
            'SELECT name, parent_id, kind, icon FROM categories WHERE is_deleted = 0 AND ledger_id = ? ORDER BY sort', [ledgerId]);
          const csv = buildCsv(
            ['名称', '层级', '收支', '图标'],
            cats.map((c) => [c.name, c.parent_id ? '二级' : '一级', c.kind === 'expense' ? '支出' : '收入', c.icon ?? '']));
          share(exportFileName(`${ledgerName}_分类`, start, end - 1), csv);
        }
      } finally { setBusy(false); }
    })();
  };

  const Chip = ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) => (
    <Pressable onPress={onPress} style={{ flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center', backgroundColor: active ? '#4361ee' : '#eef0f6' }}>
      <Text style={{ fontSize: 12, color: active ? '#fff' : '#4a5160' }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ backgroundColor: '#fff', borderRadius: 10, padding: 10, gap: 8 }}>
      <Text style={{ fontSize: 12, fontWeight: '700', color: '#1a1c23' }}>📊 CSV 导出(与 Web 同格式)</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Chip label="本月" active={scope === 'month'} onPress={() => setScope('month')} />
        <Chip label="全部" active={scope === 'all'} onPress={() => setScope('all')} />
      </View>
      <Pressable style={[styles.saveBtn, busy && styles.disabled]} disabled={busy} onPress={() => exportCsv('tx')}>
        <Text style={styles.saveText}>导出流水 CSV</Text>
      </Pressable>
      <Pressable style={[styles.saveBtn, busy && styles.disabled]} disabled={busy} onPress={() => exportCsv('acc')}>
        <Text style={styles.saveText}>导出账户 CSV</Text>
      </Pressable>
      <Pressable style={[styles.saveBtn, busy && styles.disabled]} disabled={busy} onPress={() => exportCsv('cat')}>
        <Text style={styles.saveText}>导出分类 CSV</Text>
      </Pressable>
      {done && <Text style={{ fontSize: 11, color: '#8a93a5', textAlign: 'center' }}>已生成 {done},在分享面板选择保存/拷贝目标</Text>}
    </View>
  );
}

/** 账户与资产(T-16/T-28):列表+余额、新增/编辑、净值汇总、信用卡一键还款(transfer) */
function AccountsScreen({ onBack }: { onBack: () => void }) {
  const stamp = () => ({ client_version: 1, server_version: null, is_deleted: false, deleted_at: null, created_at: Date.now(), updated_at: Date.now() });
  const [rows, setRows] = useState<Array<Record<string, unknown> & { balance: number }>>([]);
  const [net, setNet] = useState<{ assets: number; liabilities: number; net: number }>({ assets: 0, liabilities: 0, net: 0 });
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'cash', initial: '', bill_day: '', due_day: '', limit: '' });
  const [repayFor, setRepayFor] = useState<Record<string, unknown> | null>(null);
  const [repayAmt, setRepayAmt] = useState('');

  const load = async () => {
    await initDb();
    const ledgerId = await getActiveLedgerId();
    const accs = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM accounts WHERE is_deleted = 0 AND ledger_id = ? ORDER BY sort', [ledgerId]);
    const txs = await db.getAllAsync<never>('SELECT * FROM transactions WHERE is_deleted = 0 AND ledger_id = ?', [ledgerId]);
    let assets = 0, liabilities = 0;
    const withBal = accs.map((a) => {
      const bal = Number(accountBalance(String(a.initial_balance ?? '0'), String(a.id), txs as never));
      if (!a.is_archived && a.include_in_net) { if (isLiability(String(a.type) as never)) liabilities += bal; else assets += bal; }
      return { ...a, balance: bal };
    });
    setRows(withBal);
    setNet({ assets, liabilities, net: assets - liabilities });
  };
  useEffect(() => { void load(); }, []);

  const openForm = (a: Record<string, unknown> | null) => {
    setEditing(a); setCreating(!a);
    setForm(a ? {
      name: String(a.name), type: String(a.type), initial: String(a.initial_balance ?? '0'),
      bill_day: a.credit_bill_day ? String(a.credit_bill_day) : '',
      due_day: a.credit_due_day ? String(a.credit_due_day) : '',
      limit: a.credit_limit ? String(a.credit_limit) : '',
    } : { name: '', type: 'cash', initial: '', bill_day: '', due_day: '', limit: '' });
  };

  const save = async () => {
    if (!form.name.trim()) return;
    const ledgerId = await getActiveLedgerId();
    const now = Date.now();
    const base = editing ?? { id: newId(), ledger_id: ledgerId, sort: now, ...{ balance: 0 } };
    const row = {
      id: String(base.id), ledger_id: String(base.ledger_id ?? ledgerId), name: form.name.trim(), type: form.type,
      initial_balance: isValidAmount(form.initial) ? Number(form.initial).toFixed(2) : '0', initial_date: now,
      currency: (await metaGet(db, 'base_currency') as string) ?? 'CNY',
      include_in_net: true, is_archived: false, sort: Number(base.sort ?? now),
      credit_bill_day: form.type === 'credit_card' && form.bill_day ? Number(form.bill_day) : null,
      credit_due_day: form.type === 'credit_card' && form.due_day ? Number(form.due_day) : null,
      credit_limit: form.type === 'credit_card' && form.limit ? Number(form.limit).toFixed(2) : null,
      balance_cached: null, ...stamp(),
      client_version: editing ? Number(editing.client_version ?? 0) + 1 : 1,
      created_at: editing ? Number(editing.created_at ?? now) : now,
    };
    await saveLocal(db, 'account', row as never);
    setEditing(null); setCreating(false);
    await load();
  };

  const repay = async () => {
    if (!repayFor || !isValidAmount(repayAmt) || Number(repayAmt) <= 0) return;
    const ledgerId = await getActiveLedgerId();
    const now = Date.now();
    const from = rows.find((r) => !isLiability(String(r.type) as never));
    if (!from) return;
    const baseCurrency = ((await metaGet(db, 'base_currency')) as string) ?? 'CNY'; // T-02:跟随账本主币种
    await saveLocal(db, 'transaction', { id: newId(), ledger_id: ledgerId, user_id: 'local', member_id: null,
      type: 'transfer', amount: Number(repayAmt).toFixed(2), currency: baseCurrency, amount_base: Number(repayAmt).toFixed(2),
      exchange_rate: null, category_id: null, account_id: from.id, to_account_id: repayFor.id,
      happened_at: now, note: `还款 · ${String(repayFor.name)}`, is_refunded: 0, refund_of_id: null,
      reimburse_status: null, exclude_from_budget: 0, attachment_count: 0, source: 'manual',
      client_version: 1, server_version: null, is_deleted: 0, deleted_at: null, created_at: now, updated_at: now } as never);
    setRepayFor(null); setRepayAmt('');
    scheduleSync();
    await load();
  };

  const TYPE_ICON: Record<string, string> = { cash: '💵', debit_card: '💳', credit_card: '🏦', payable: '🧾' };
  const TYPE_NAME: Record<string, string> = { cash: '现金', debit_card: '储蓄卡', credit_card: '信用卡', payable: '应付款' };

  return (
    <View style={{ flex: 1, backgroundColor: '#f6f7f9' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Pressable onPress={onBack}><Text style={{ fontSize: 16, color: '#4361ee' }}>‹ 返回</Text></Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: '#1a1c23' }}>账户与资产</Text>
        <Pressable onPress={() => openForm(null)}><Text style={{ fontSize: 20, color: '#4361ee' }}>＋</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 10 }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, flexDirection: 'row', justifyContent: 'space-around' }}>
          <View><Text style={{ fontSize: 11, color: '#8a93a5' }}>资产</Text><Text style={{ fontSize: 15, fontWeight: '700', color: '#1f9d6c' }}>¥{formatAmount(String(net.assets))}</Text></View>
          <View><Text style={{ fontSize: 11, color: '#8a93a5' }}>负债</Text><Text style={{ fontSize: 15, fontWeight: '700', color: '#d64545' }}>¥{formatAmount(String(net.liabilities))}</Text></View>
          <View><Text style={{ fontSize: 11, color: '#8a93a5' }}>净值</Text><Text style={{ fontSize: 15, fontWeight: '700', color: '#1a1c23' }}>¥{formatAmount(String(net.net))}</Text></View>
        </View>
        {rows.map((a) => (
          <View key={String(a.id)} style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14 }}>
            <Pressable onPress={() => openForm(a)}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#1a1c23' }}>{TYPE_ICON[String(a.type)] ?? '💵'} {String(a.name)}{a.credit_bill_day ? ` · 账单日${a.credit_bill_day}` : ''}</Text>
                <Text style={{ fontSize: 14, fontWeight: '700', color: a.balance < 0 ? '#d64545' : '#1a1c23' }}>¥{formatAmount(String(a.balance))}</Text>
              </View>
              <Text style={{ fontSize: 11, color: '#8a93a5', marginTop: 2 }}>{TYPE_NAME[String(a.type)] ?? String(a.type)}</Text>
            </Pressable>
            {String(a.type) === 'credit_card' && (
              <Pressable style={{ marginTop: 8, backgroundColor: '#eef0f6', borderRadius: 8, paddingVertical: 6, alignItems: 'center' }}
                onPress={() => { setRepayFor(a); setRepayAmt(String(Math.abs(a.balance).toFixed(2))); }}>
                <Text style={{ fontSize: 12, color: '#4361ee' }}>💳 一键还款</Text>
              </Pressable>
            )}
          </View>
        ))}
        {rows.length === 0 && <Text style={{ color: '#8a93a5', fontSize: 13, textAlign: 'center' }}>还没有账户,点右上角 ＋ 添加</Text>}
      </ScrollView>
      {(creating || editing) && (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: '#fff', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, gap: 10 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#1a1c23' }}>{editing ? '编辑账户' : '新增账户'}</Text>
            <TextInput style={styles.input} value={form.name} onChangeText={(t) => setForm({ ...form, name: t.slice(0, 30) })} placeholder="账户名称" placeholderTextColor="#b4bac6" />
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {(['cash', 'debit_card', 'credit_card'] as const).map((t) => (
                <Pressable key={t} onPress={() => setForm({ ...form, type: t })}
                  style={{ flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center', backgroundColor: form.type === t ? '#4361ee' : '#eef0f6' }}>
                  <Text style={{ fontSize: 12, color: form.type === t ? '#fff' : '#4a5160' }}>{TYPE_NAME[t]}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput style={styles.input} value={form.initial} onChangeText={(t) => setForm({ ...form, initial: t.replace(/[^\\d.]/g, '') })} keyboardType="decimal-pad" placeholder="初始余额(信用卡填欠款用负数)" placeholderTextColor="#b4bac6" />
            {form.type === 'credit_card' && (
              <>
                <TextInput style={styles.input} value={form.bill_day} onChangeText={(t) => setForm({ ...form, bill_day: t.replace(/[^\\d]/g, '').slice(0, 2) })} keyboardType="number-pad" placeholder="账单日(1-31)" placeholderTextColor="#b4bac6" />
                <TextInput style={styles.input} value={form.due_day} onChangeText={(t) => setForm({ ...form, due_day: t.replace(/[^\\d]/g, '').slice(0, 2) })} keyboardType="number-pad" placeholder="还款日(1-31)" placeholderTextColor="#b4bac6" />
                <TextInput style={styles.input} value={form.limit} onChangeText={(t) => setForm({ ...form, limit: t.replace(/[^\\d.]/g, '') })} keyboardType="decimal-pad" placeholder="额度(可选)" placeholderTextColor="#b4bac6" />
              </>
            )}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable style={{ ...styles.saveBtn, flex: 1, backgroundColor: '#eef0f6' }} onPress={() => { setEditing(null); setCreating(false); }}>
                <Text style={{ ...styles.saveText, color: '#1a1c23' }}>取消</Text>
              </Pressable>
              <Pressable style={{ ...styles.saveBtn, flex: 2, ...((!form.name) && styles.disabled) }} onPress={() => void save()}>
                <Text style={styles.saveText}>保存</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}
      {repayFor && (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: '#fff', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, gap: 10 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#1a1c23' }}>还款 · {String(repayFor.name)}</Text>
            <Text style={{ fontSize: 12, color: '#8a93a5' }}>将从你的第一个资产账户转入该信用卡</Text>
            <TextInput style={styles.input} value={repayAmt} onChangeText={(t) => setRepayAmt(t.replace(/[^\\d.]/g, ''))} keyboardType="decimal-pad" placeholder="还款金额" placeholderTextColor="#b4bac6" />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable style={{ ...styles.saveBtn, flex: 1, backgroundColor: '#eef0f6' }} onPress={() => setRepayFor(null)}>
                <Text style={{ ...styles.saveText, color: '#1a1c23' }}>取消</Text>
              </Pressable>
              <Pressable style={{ ...styles.saveBtn, flex: 2 }} onPress={() => void repay()}>
                <Text style={styles.saveText}>确认还款</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}


/** 账号设置(T-17):昵称 / 主币种 / 注销账号(密码二次确认 + 本地清库) */
function AccountSettings({ onBack, onLogged }: { onBack: () => void; onLogged: () => void }) {
  const [nickname, setNickname] = useState('');
  const [currency, setCurrency] = useState('CNY');
  const [delPwd, setDelPwd] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const u = (await authApi.me()) as { nickname?: string; base_currency?: string };
        setNickname(u.nickname ?? '');
        setCurrency(u.base_currency ?? 'CNY');
      } catch { /* 静默 */ }
    })();
  }, []);

  const saveProfile = async () => {
    setBusy(true);
    try {
      await authApi.updateMe({ nickname: nickname.trim().slice(0, 30), base_currency: currency });
      await metaSet(db, 'base_currency', currency);
      setMsg('已保存');
      setTimeout(() => setMsg(null), 1500);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const deleteAccount = async () => {
    if (!isValidAmount('1')) return; // noop guard
    setBusy(true);
    try {
      // 注销:服务端二次校验密码;成功后本地清库回未登录态
      await authApi.deleteMe(delPwd);
      await resetLocalDatabase();
      resetInitCache();
      await clearSession();
      onLogged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#f6f7f9' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Pressable onPress={onBack}><Text style={{ fontSize: 16, color: '#4361ee' }}>‹ 返回</Text></Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: '#1a1c23' }}>账号设置</Text>
        <Text style={{ fontSize: 16, color: 'transparent' }}>‹</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 10 }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, gap: 10 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1a1c23' }}>个人资料</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontSize: 12, color: '#4a5160', width: 60 }}>昵称</Text>
            <TextInput style={{ ...styles.input, flex: 1 }} value={nickname} onChangeText={(t) => setNickname(t.slice(0, 30))} placeholder="昵称" placeholderTextColor="#b4bac6" />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontSize: 12, color: '#4a5160', width: 60 }}>主币种</Text>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {(['CNY', 'USD', 'EUR', 'JPY'] as const).map((c) => (
                <Pressable key={c} onPress={() => setCurrency(c)}
                  style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 10, backgroundColor: currency === c ? '#4361ee' : '#eef0f6' }}>
                  <Text style={{ fontSize: 12, color: currency === c ? '#fff' : '#4a5160' }}>{c}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <Pressable style={[styles.saveBtn, busy && styles.disabled]} onPress={() => void saveProfile()}>
            <Text style={styles.saveText}>保存</Text>
          </Pressable>
        </View>
        <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, gap: 10 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#d64545' }}>危险区 · 注销账号</Text>
          <Text style={{ fontSize: 11, color: '#8a93a5' }}>将删除服务器账号与云端数据,并清空本机全部记录,不可恢复</Text>
          <TextInput style={styles.input} value={delPwd} onChangeText={setDelPwd} secureTextEntry placeholder="输入密码确认" placeholderTextColor="#b4bac6" />
          <Pressable style={{ ...styles.saveBtn, backgroundColor: '#d64545', ...(!delPwd && styles.disabled) }} onPress={() => void deleteAccount()}>
            <Text style={styles.saveText}>注销账号</Text>
          </Pressable>
        </View>
        {msg && <Text style={{ fontSize: 12, color: msg.includes('失败') || msg.includes('错误') ? '#d64545' : '#1f9d6c' }}>{msg}</Text>}
      </ScrollView>
    </View>
  );
}


/** 同步诊断(T-32):死信列表 + 清空(deadletter 表) */
function DeadLetterScreen({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);

  const load = async () => {
    await initDb();
    try {
      const r = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM deadletter ORDER BY created_at DESC LIMIT 200');
      setRows(r);
    } catch { setRows([]); }
  };
  useEffect(() => { void load(); }, []);

  return (
    <View style={{ flex: 1, backgroundColor: '#f6f7f9' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Pressable onPress={onBack}><Text style={{ fontSize: 16, color: '#4361ee' }}>‹ 返回</Text></Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: '#1a1c23' }}>同步诊断(死信)</Text>
        <Text style={{ fontSize: 14, color: '#4361ee' }}>{rows.length}</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
        {rows.map((r, i) => (
          <View key={String(r.id ?? i)} style={{ backgroundColor: '#fff', borderRadius: 10, padding: 10 }}>
            <Text style={{ fontSize: 12, color: '#1a1c23' }}>{String(r.entity ?? '?')} · {String(r.reason ?? '').slice(0, 60)}</Text>
            <Text style={{ fontSize: 10, color: '#8a93a5' }}>{String(r.created_at ?? '')}</Text>
          </View>
        ))}
        {rows.length === 0 && <Text style={{ color: '#8a93a5', fontSize: 13, textAlign: 'center' }}>没有死信,同步一切正常</Text>}
        {rows.length > 0 && (
          <Pressable style={{ ...styles.saveBtn, backgroundColor: '#d64545' }}
            onPress={() => { void (async () => { await db.execAsync('DELETE FROM deadletter'); await load(); })(); }}>
            <Text style={styles.saveText}>清空死信</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}


/** 安全与隐私(与 Web 安全页对齐):应用锁/生物识别/PIN、隐私开关、同步诊断入口 */
function SafetyScreen({ onBack, onOpenDead }: { onBack: () => void; onOpenDead: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [lockOn, setLockOn] = useState(false);
  const [lockMode, setLockMode] = useState<'pin' | 'biometric'>('pin');
  const [bioAvail, setBioAvail] = useState(false);
  const [bioOff, setBioOff] = useState(false);
  const [pinExists, setPinExists] = useState(false);
  const [pinMode, setPinMode] = useState<'setup' | 'change'>('setup');
  const [pinOld, setPinOld] = useState('');
  const [pinNew, setPinNew] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinSetup, setPinSetup] = useState(false);
  const [privStat, setPrivStat] = useState(false);
  const [privCrash, setPrivCrash] = useState(false);

  useEffect(() => {
    void (async () => {
      setLockOn(await isLockEnabled());
      setBioAvail(await biometricAvailable());
      setBioOff(await isBiometricDisabled());
      setPinExists(await hasPin());
      setLockMode(await activeLockMode());
      setPrivStat((await SecureStore.getItemAsync('priv_stat')) === '1');
      setPrivCrash((await SecureStore.getItemAsync('priv_crash')) === '1');
    })();
  }, []);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3000); };
  const msgIsErr = msg ? /错误|过多|失败/.test(msg) : false;

  return (
    <ScrollView contentContainerStyle={styles.form}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Pressable onPress={onBack}><Text style={{ fontSize: 16, color: '#4361ee' }}>‹ 返回</Text></Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: '#1a1c23' }}>安全与隐私</Text>
        <Text style={{ fontSize: 16, color: 'transparent' }}>‹</Text>
      </View>
      <Pressable style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 }}
        onPress={() => {
          void (async () => {
            if (await isLockEnabled()) {
              await disableLock(); setPinSetup(false); setLockOn(false); flash('应用锁已关闭');
            } else {
              await enableLock();
              const mode = await activeLockMode();
              setLockOn(true); setLockMode(mode);
              if (mode === 'biometric') flash('应用锁已开启(面容/指纹),可在下方自由切换或关闭');
              else { setPinMode('setup'); setPinSetup(true); return; }
            }
          })();
        }}>
        <Text style={{ fontSize: 13, color: '#1a1c23' }}>🔒 应用锁(生物识别 / PIN)</Text>
        <Text style={{ fontSize: 12, color: lockOn ? '#1f9d6c' : '#8a93a5' }}>{lockOn ? `开启中(${lockMode === 'biometric' ? '指纹/面容' : 'PIN'})` : '点按开启'}</Text>
      </Pressable>
      {lockOn && bioAvail && (
        <Pressable style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 }}
          onPress={() => {
            void (async () => {
              if (!bioOff) {
                await setBiometricDisabled(true); setBioOff(true); setLockMode('pin');
                if (!(await hasPin())) { setPinMode('setup'); setPinSetup(true); }
                flash('生物识别已关闭,改用 PIN 解锁');
              } else {
                await setBiometricDisabled(false); setBioOff(false); setLockMode('biometric');
                flash('生物识别已开启,下次解锁生效');
              }
            })();
          }}>
          <Text style={{ fontSize: 13, color: '#1a1c23' }}>☝️ 生物识别(指纹/面容)</Text>
          <Text style={{ fontSize: 12, color: bioOff ? '#8a93a5' : '#1f9d6c' }}>{bioOff ? '已关闭 · 用 PIN' : '已开启 · 点按关闭'}</Text>
        </Pressable>
      )}
      {lockOn && (
        <Pressable style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 }}
          onPress={() => { setPinMode(pinExists ? 'change' : 'setup'); setPinOld(''); setPinNew(''); setPinConfirm(''); setPinSetup(true); }}>
          <Text style={{ fontSize: 13, color: '#1a1c23' }}>🔑 {pinExists ? '修改 PIN' : '设置 PIN'}</Text>
          <Text style={{ fontSize: 12, color: '#8a93a5' }}>{pinExists ? '需验证当前 PIN' : '4–8 位数字'}</Text>
        </Pressable>
      )}
      {pinSetup && (
        <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, gap: 8 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1a1c23' }}>{pinMode === 'change' ? '修改 PIN' : '设置应用锁 PIN(4–8 位数字)'}</Text>
          {pinMode === 'change' && (
            <TextInput style={styles.input} value={pinOld} onChangeText={(t) => setPinOld(t.replace(/[^\d]/g, '').slice(0, 8))} keyboardType="number-pad" secureTextEntry placeholder="输入当前 PIN" placeholderTextColor="#b4bac6" />
          )}
          <TextInput style={styles.input} value={pinNew} onChangeText={(t) => setPinNew(t.replace(/[^\d]/g, '').slice(0, 8))} keyboardType="number-pad" secureTextEntry placeholder="输入新 PIN" placeholderTextColor="#b4bac6" />
          <TextInput style={styles.input} value={pinConfirm} onChangeText={(t) => setPinConfirm(t.replace(/[^\d]/g, '').slice(0, 8))} keyboardType="number-pad" secureTextEntry placeholder="再次输入确认" placeholderTextColor="#b4bac6" />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable
              style={{ flex: 1, backgroundColor: pinNew.length >= 4 && pinNew === pinConfirm ? '#4361ee' : '#eef0f6', borderRadius: 10, paddingVertical: 10, alignItems: 'center', opacity: pinNew.length >= 4 && pinNew === pinConfirm ? 1 : 0.5 }}
              disabled={pinNew.length < 4 || pinNew !== pinConfirm}
              onPress={() => {
                void (async () => {
                  if (pinMode === 'change') {
                    const r = await verifyPin(pinOld);
                    if (r === 'wrong') { flash('当前 PIN 错误'); return; }
                    if (r === 'locked') { flash('失败次数过多,请 60 秒后再试'); return; }
                  }
                  await setPin(pinNew);
                  setPinSetup(false); setPinNew(''); setPinConfirm(''); setPinOld('');
                  setPinExists(true); setLockMode('pin'); setLockOn(true);
                  flash(pinMode === 'change' ? 'PIN 已修改' : '应用锁已开启(PIN)');
                })();
              }}>
              <Text style={{ fontSize: 13, color: pinNew.length >= 4 && pinNew === pinConfirm ? '#fff' : '#8a93a5' }}>确认</Text>
            </Pressable>
            <Pressable
              style={{ flex: 1, backgroundColor: '#eef0f6', borderRadius: 10, paddingVertical: 10, alignItems: 'center' }}
              onPress={() => {
                void (async () => {
                  if (pinMode === 'setup' && !(await hasPin())) await disableLock();
                  setLockOn(await isLockEnabled());
                  setPinSetup(false); setPinNew(''); setPinConfirm(''); setPinOld('');
                })();
              }}>
              <Text style={{ fontSize: 13, color: '#4a5160' }}>取消</Text>
            </Pressable>
          </View>
        </View>
      )}
      <Text style={{ fontSize: 13, fontWeight: '700', color: '#1a1c23', marginTop: 8 }}>隐私开关</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 }}>
        <Text style={{ fontSize: 13, color: '#1a1c23' }}>行为统计</Text>
        <Switch value={privStat} onValueChange={(v) => { setPrivStat(v); void SecureStore.setItemAsync('priv_stat', v ? '1' : '0'); }} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 }}>
        <Text style={{ fontSize: 13, color: '#1a1c23' }}>崩溃上报</Text>
        <Switch value={privCrash} onValueChange={(v) => { setPrivCrash(v); void SecureStore.setItemAsync('priv_crash', v ? '1' : '0'); }} />
      </View>
      <Text style={{ fontSize: 11, color: '#8a93a5' }}>两项暂未接入统计/上报 SDK,开关仅记录偏好(与 Web 口径一致)</Text>
      <Pressable style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, marginTop: 8 }}
        onPress={onOpenDead}>
        <Text style={{ fontSize: 13, color: '#1a1c23' }}>🩺 同步诊断(死信)</Text>
        <Text style={{ fontSize: 12, color: '#8a93a5' }}>导出 · 清空 ›</Text>
      </Pressable>
      {msg && <Text style={{ fontSize: 12, color: msgIsErr ? '#d64545' : '#1f9d6c' }}>{msg}</Text>}
    </ScrollView>
  );
}

function MeScreen({ logged, onLogged, syncText, lastSyncAt, onSync, onOpen }: { logged: boolean; onLogged: (v: boolean) => void; syncText: string; lastSyncAt: number | null; onSync: () => void; onOpen: (p: 'cats' | 'savings' | 'import' | 'recurring' | 'ledgers' | 'export' | 'accounts' | 'settings' | 'dead' | 'safety') => void }) {
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
          const u = (await authApi.me()) as { email?: string; nickname?: string; base_currency?: string };
          setMe({ email: u.email, nickname: u.nickname });
          if (u.base_currency) await metaSet(db, 'base_currency', u.base_currency); // T-02:主币种跟随账号
        } catch { /* token 失效等场景静默,下轮刷新 */ }
      } else {
        setMe(null);
      }
    });
  }, [logged]);

  const submit = async () => {
    if (!email || !password) return;
    // T-05:协议白名单,非法地址直接拒绝,不再进故障转移链
    const invalid = validateServerUrl(server);
    if (invalid) { setMsg(invalid); return; }
    setBusy(true);
    setMsg(null);
    try {
      // 故障转移链:用户所选地址优先 → 公网 frp → 局域网 → 全断时报错并保持离线
      const reachable = await resolveServerUrl(server.trim() || undefined);
      setServer(reachable);
      await setServerUrl(reachable);
      let data;
      try {
        data = await authApi.login(email, password);
      } catch (loginErr) {
        const ls = String(loginErr instanceof Error ? loginErr.message : loginErr);
        // 密码错误(401)不该触发注册兜底
        if (ls.includes('密码错误') || ls.includes('邮箱或密码错误')) throw loginErr;
        console.log('[auth] login 失败,转注册:', ls);
        data = await authApi.register(email, password);
      }
      console.log('[auth] 成功,服务器:', reachable);
      saveSession(data as never);
      // P0-1(第 27 轮):三态换号处理(明确换号清库/纯本地保留/残留清库),与 Web 同策略
      const action = await prepareAfterLogin(db, String((data as { user?: { id?: string } }).user?.id ?? ''));
      if (action === 'wiped') {
        // wipeAllTables 不清 meta:seeded/active_ledger 残留会让新账号掉进"幽灵账本"
        await metaSet(db, 'seeded', null);
        await metaSet(db, 'active_ledger', null);
        resetInitCache();
      }
      onLogged(true);
      await initDb(); // 清库后重播种/重初始化
      await engine.syncOnce();
      // 首登收敛:登录同步完成后,当前账本一律对齐到该账号「最早创建的已同步账本」
      // (与 Web 端默认口径一致)。否则手机本地 seed 的新账本一旦 push 上云就永远不会切换,
      // 造成同账号两端各看各的空账本。
      const active = await getActiveLedgerId();
      const earliest = await db.getAllAsync<{ id: string; created_at: number }>(
        'SELECT id, created_at FROM ledgers WHERE server_version IS NOT NULL AND is_deleted = 0 ORDER BY created_at ASC LIMIT 1');
      const earliestRow = await db.getAllAsync<{ created_at: number }>(
        'SELECT created_at FROM ledgers WHERE id = ?', [active]);
      if (earliest[0]?.id && earliest[0].id !== active
          && (!earliestRow[0] || earliest[0].created_at < Number(earliestRow[0].created_at))) {
        await metaSet(db, 'active_ledger', earliest[0].id);
        console.log('[auth] 账本对齐到最早服务器账本:', earliest[0].id);
      }
      setMsg(action === 'wiped' ? '检测到账号切换,已清空本地数据并重新同步' : '登录成功,同步已开启');
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      console.log('[auth] 登录/注册失败:', m);
      const network = /fetch failed|Connect|TIMEDOUT|timeout|不可达/i.test(m);
      setMsg(network
        ? '连接服务器失败(公网与局域网均不可达)——已保持离线模式,本地记账不受影响;网络恢复后请重试登录'
        : m);
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
      {/* 菜单与 Web「我的」页同构(顺序/命名/副标题一致) */}
      {([
        ['待确认池 📥', '导入账单 · 去重确认', 'import'],
        ['存钱计划 🐷', '目标 · 净结余进度', 'savings'],
        ['账本管理 📚', '多账本 · 切换 · 新建', 'ledgers'],
        ['分类管理 🏷️', '自定义 · 隐藏 · 删除', 'cats'],
        ['周期记账 🔁', '房租工资自动记', 'recurring'],
        ['账户与资产 💼', '余额 · 净值', 'accounts'],
        ['账号设置 ⚙️', '昵称 · 主币种 · 注销', 'settings'],
        ['导出与备份 📄', '手写账 · CSV', 'export'],
        ['安全与隐私 🔒', '应用锁 · 隐私 · 死信', 'safety'],
      ] as Array<[string, string, 'import' | 'savings' | 'ledgers' | 'cats' | 'recurring' | 'accounts' | 'settings' | 'export' | 'safety']>).map(([label, hint, key]) => (
        <Pressable key={key} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 2 }}
          onPress={() => onOpen(key)}>
          <Text style={{ fontSize: 13, color: '#1a1c23' }}>{label}</Text>
          <Text style={{ fontSize: 12, color: '#8a93a5' }}>{hint} ›</Text>
        </Pressable>
      ))}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, marginTop: 8 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 13, color: '#1a1c23' }}>同步状态</Text>
          <Text style={{ fontSize: 11, color: '#8a93a5', marginTop: 2 }} numberOfLines={1}>{syncText}{lastSyncAt ? ` · 上次 ${new Date(lastSyncAt).toLocaleTimeString('zh-CN')}` : ''}</Text>
        </View>
        <Pressable style={{ backgroundColor: '#4361ee', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 14 }} onPress={onSync}>
          <Text style={{ color: '#fff', fontSize: 12 }}>立即同步</Text>
        </Pressable>
      </View>
      {!logged && (
        <>
          <Text style={styles.label}>服务器</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
            {SERVER_PRESETS.map((p) => (
              <Pressable
                key={p.url}
                onPress={() => { setServer(p.url); void setServerUrl(p.url); }}
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
          {insecureTransportReason(server) && (
            <Text style={{ fontSize: 11, color: '#e67e22', marginBottom: 6 }}>{insecureTransportReason(server)}</Text>
          )}
          <Text style={styles.label}>邮箱</Text>
          <TextInput style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="you@example.com" placeholderTextColor="#b4bac6" />
          <Text style={styles.label}>密码</Text>
          <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry placeholder="至少 8 位" placeholderTextColor="#b4bac6" />
          {msg && <Text style={{ fontSize: 12, color: /失败|错误|不可达/.test(msg) ? '#d64545' : '#1f9d6c', marginTop: 4 }}>{msg}</Text>}
          <Pressable style={[styles.saveBtn, busy && styles.disabled]} onPress={() => void submit()}>
            <Text style={styles.saveText}>{busy ? '请稍候…' : '登录(无账号自动注册)'}</Text>
          </Pressable>
        </>
      )}
      {logged && (
        <>
          <Pressable style={[styles.saveBtn, styles.logout]} onPress={() => void logout()}>
            <Text style={[styles.saveText, { color: '#e5484d' }]}>退出登录(本地数据保留)</Text>
          </Pressable>
        </>
      )}
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
        <LockGate>
          <AppInner />
        </LockGate>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
