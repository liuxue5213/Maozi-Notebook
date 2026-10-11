
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

export function AccountsScreen({ onBack }: { onBack: () => void }) {
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
