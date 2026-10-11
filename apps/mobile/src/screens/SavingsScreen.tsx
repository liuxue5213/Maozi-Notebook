
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

export function SavingsScreen({ onBack }: { onBack: () => void }) {
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
