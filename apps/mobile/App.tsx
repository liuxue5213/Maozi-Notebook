import './src/lib/polyfills'; // 必须最先:uuid@14 裸用全局 crypto,Hermes 没有,必须先垫上
import { buildBudgetModel, netSavings, type BudgetModel } from '@ledgerone/ledger-core';
import { isValidAmount, parseTextLedger, reconcileTextLedger, renderTextLedger, billingCycleRange, daysUntilDue, accountBalance, isLiability, dedupeHash, buildCsv, exportFileName, budgetPeriodRange, type BudgetPeriodType } from '@ledgerone/domain';
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
import { authApi, aiChat, aiInsights, aiParse, aiEnabledFlag, clearSession, getServerUrl, insecureTransportReason, isLoggedIn, logout as logoutAll, saveSession, setServerUrl, SERVER_PRESETS, resolveServerUrl, setAiEnabled, validateServerUrl } from './src/lib/api';
import { styles, type Tab } from './src/screens/shared';
import { CategoryManager } from './src/screens/CategoryManager';
import { SavingsScreen } from './src/screens/SavingsScreen';
import { ImportScreen } from './src/screens/ImportScreen';
import { RecurringScreen } from './src/screens/RecurringScreen';
import { CreditBanner, BudgetCard } from './src/screens/BudgetWidgets';
import { RecordScreen } from './src/screens/RecordScreen';
import { ListScreen } from './src/screens/ListScreen';
import { ReportScreen } from './src/screens/ReportScreen';
import { LedgerManager } from './src/screens/LedgerManager';
import { ExportLedger } from './src/screens/ExportScreen';
import { AccountsScreen } from './src/screens/AccountsScreen';
import { AccountSettings, DeadLetterScreen, SafetyScreen, MeScreen } from './src/screens/MeScreens';


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
