
import { buildBudgetModel, netSavings, type BudgetModel } from '@ledgerone/ledger-core';
import { isValidAmount, parseTextLedger, reconcileTextLedger, renderTextLedger, billingCycleRange, daysUntilDue, accountBalance, isLiability, dedupeHash, buildCsv, exportFileName, budgetPeriodRange, formatAmount, newId } from '@ledgerone/domain';
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
import { monthRange, type Tab } from './shared';
import { styles } from './shared';

export function RecurringScreen({ onBack }: { onBack: () => void }) {
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


