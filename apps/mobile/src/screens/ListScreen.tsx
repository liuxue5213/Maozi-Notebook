
import { buildBudgetModel, netSavings, type BudgetModel } from '@ledgerone/ledger-core';
import { isValidAmount, parseTextLedger, reconcileTextLedger, renderTextLedger, billingCycleRange, daysUntilDue, accountBalance, isLiability, dedupeHash, buildCsv, exportFileName, budgetPeriodRange, formatAmount, newId } from '@ledgerone/domain';
import type { TransactionRow } from '@ledgerone/domain';
import React, { useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { AppState, BackHandler, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSyncExternalStore } from 'react';
import { engine, scheduleSync, snapshot, startMobileAutoSync } from '../lib/sync';
import { runDueRecurring } from '../lib/recurring';
import { evalExpr } from '../lib/calc';
import { activeLockMode, biometricAuth, biometricAvailable, disableLock, hasPin, isBiometricDisabled, isLockEnabled, enableLock, setBiometricDisabled, setPin, verifyPin } from '../lib/applock';
import { initDb, resetInitCache, createLedgerWithSeed, listRecent, saveTx, topCategories, getActiveLedgerId, metaGet, metaSet, db } from '../lib/store';
import { clearSession as clearSessionLocal } from '../lib/api';
import { resetLocalDatabase } from '../lib/db';
import { prepareAfterLogin, saveLocal } from '@ledgerone/sqlite-sync';
import { authApi, aiChat, aiInsights, aiParse, aiEnabledFlag, clearSession, getServerUrl, insecureTransportReason, isLoggedIn, logout as logoutAll, saveSession, setServerUrl, SERVER_PRESETS, resolveServerUrl, setAiEnabled, validateServerUrl } from '../lib/api';
import { monthRange, PAGE, type Tab } from './shared';
import { styles } from './shared';


export function ListScreen({ drillCat, onClearDrill }: { drillCat: string | null; onClearDrill: () => void }) {
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

