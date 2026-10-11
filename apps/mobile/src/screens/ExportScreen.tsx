
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

export function ExportLedger({ onBack }: { onBack: () => void }) {
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
export function CsvExportSection({ monthOffset }: { monthOffset: number }) {
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
