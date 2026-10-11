
import { buildBudgetModel, netSavings, type BudgetModel } from '@ledgerone/ledger-core';
import { isValidAmount, parseTextLedger, reconcileTextLedger, renderTextLedger, billingCycleRange, daysUntilDue, accountBalance, isLiability, dedupeHash, buildCsv, exportFileName, budgetPeriodRange, formatAmount, newId } from '@ledgerone/domain';
import type { BudgetPeriodType } from '@ledgerone/domain';
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

export function CreditBanner() {
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

export function BudgetCard() {
  const [model, setModel] = useState<BudgetModel | null>(null);
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [catDrafts, setCatDrafts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [rollover, setRollover] = useState(false);
  // N1 预算多周期
  const [periodType, setPeriodType] = useState<BudgetPeriodType>('monthly');

  const loadModel = async (pt: BudgetPeriodType = 'monthly') => {
    await initDb();
    const ledgerId = await getActiveLedgerId();
    if (!ledgerId) return;
    const { start, end, prevStart } = budgetPeriodRange(pt);
    const [budgets, budgetItems, transactions, categories] = await Promise.all([
      db.getAllAsync<Record<string, unknown>>('SELECT * FROM budgets WHERE is_deleted = 0'),
      db.getAllAsync<Record<string, unknown>>('SELECT * FROM budget_items WHERE is_deleted = 0'),
      db.getAllAsync<Record<string, unknown>>('SELECT * FROM transactions WHERE is_deleted = 0'),
      db.getAllAsync<Record<string, unknown>>('SELECT * FROM categories WHERE is_deleted = 0'),
    ]);
    setModel(buildBudgetModel({
      budgets: budgets as never, budgetItems: budgetItems as never,
      transactions: transactions as never, categories: categories as never,
      ledgerId, periodType: pt, periodStart: start, periodEnd: end, prevPeriodStart: prevStart,
    }));
  };

  useEffect(() => { void loadModel(periodType); }, [periodType]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const b = model?.budget;
    const baseCurrency = ((await metaGet(db, 'base_currency')) as string) ?? 'CNY'; // T-02:跟随账本主币种
    const row = b
      ? { ...b, total_amount: amount, rollover, client_version: Number((b as unknown as Record<string, unknown>).client_version ?? 0) + 1, updated_at: now }
      : { id: newId(), ledger_id: ledgerId, period_type: periodType, period_start: budgetPeriodRange(periodType).start, total_amount: amount, currency: baseCurrency, rollover, client_version: 1, server_version: null, is_deleted: false, deleted_at: null, created_at: now, updated_at: now };
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
        <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
          {([['weekly', '周'], ['monthly', '月'], ['quarterly', '季'], ['yearly', '年']] as Array<[BudgetPeriodType, string]>).map(([k, label]) => (
            <Pressable key={k} onPress={() => setPeriodType(k)}
              style={{ flex: 1, paddingVertical: 6, borderRadius: 10, alignItems: 'center', backgroundColor: periodType === k ? '#4361ee' : '#eef0f6' }}>
              <Text style={{ fontSize: 12, color: periodType === k ? '#fff' : '#4a5160' }}>{label}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable onPress={() => setEditing(true)}>
          <Text style={{ color: '#8a93a5', fontSize: 13 }}>📅 设置{periodType === 'weekly' ? '周' : periodType === 'quarterly' ? '季' : periodType === 'yearly' ? '年' : '月'}预算,控制花钱节奏</Text>
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
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
        {([['weekly', '周'], ['monthly', '月'], ['quarterly', '季'], ['yearly', '年']] as Array<[BudgetPeriodType, string]>).map(([k, label]) => (
          <Pressable key={k} onPress={() => setPeriodType(k)}
            style={{ flex: 1, paddingVertical: 6, borderRadius: 10, alignItems: 'center', backgroundColor: periodType === k ? '#4361ee' : '#eef0f6' }}>
            <Text style={{ fontSize: 12, color: periodType === k ? '#fff' : '#4a5160' }}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable onPress={() => setEditing((v) => !v)}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1a1c23' }}>{periodType === 'weekly' ? '周' : periodType === 'quarterly' ? '季' : periodType === 'yearly' ? '年' : '月'}预算 ¥{formatAmount(view.total)}</Text>
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

