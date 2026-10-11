
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

export function ImportScreen({ onBack }: { onBack: () => void }) {
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
