
import { buildBudgetModel, netSavings, type BudgetModel } from '@ledgerone/ledger-core';
import { isValidAmount, parseTextLedger, reconcileTextLedger, renderTextLedger, billingCycleRange, daysUntilDue, accountBalance, isLiability, dedupeHash, buildCsv, exportFileName, budgetPeriodRange, formatAmount, newId } from '@ledgerone/domain';
import type { TransactionType } from '@ledgerone/domain';
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
import { type Tab, type Cat } from './shared';
import { styles } from './shared';
import { CreditBanner, BudgetCard } from './BudgetWidgets';

interface Tpl { id: string; name: string; type: string; amount: string; category_id: string | null; account_id: string | null }

export function RecordScreen({ onSaved }: { onSaved: () => void }) {
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
            if (!(await aiEnabledFlag())) { setMsg('已在「安全与隐私」中关闭 AI 分析'); setTimeout(() => setMsg(null), 2500); return; }
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

