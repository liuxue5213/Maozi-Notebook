import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatAmount, newId, type TransactionRow, type TransactionType } from '@ledgerone/domain';
import { useSyncExternalStore } from 'react';
import { engine, scheduleSync, snapshot, startMobileAutoSync } from './src/lib/sync';
import { initDb, listRecent, saveTx, topCategories, getActiveLedgerId, metaGet, metaSet, db } from './src/lib/store';
import { prepareAfterLogin } from '@ledgerone/sqlite-sync';
import { authApi, clearSession, getServerUrl, isLoggedIn, logout as logoutAll, saveSession, setServerUrl, SERVER_PRESETS } from './src/lib/api';

type Tab = 'record' | 'list' | 'me';

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
        </View>
      );
    }
    return this.props.children;
  }
}

function AppInner() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('record');
  const [txs, setTxs] = useState<TransactionRow[]>([]);
  const sync = useSyncExternalStore(engine.subscribe, snapshot);
  const [logged, setLogged] = useState(false);
  const [loading, setLoading] = useState('加载中…');

  const refreshTxs = useCallback(async () => {
    setTxs((await listRecent()) as unknown as TransactionRow[]);
  }, []);

  useEffect(() => {
    void initDb().then(async () => {
      await refreshTxs();
      setLogged(await isLoggedIn());
      setReady(true);
      startMobileAutoSync(); // P0-2:定时兜底 + 进前台补同步
    });
  }, [refreshTxs]);

  if (!ready) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>{loading}</Text>
      </View>
    );
  }

  return (
    <View style={styles.app}>
      <Text style={styles.title}>帽子记账本</Text>
      <View style={styles.content}>
        {tab === 'record' && (
          <RecordScreen onSaved={() => void refreshTxs()} />
        )}
        {tab === 'list' && <ListScreen txs={txs} onRefresh={() => void refreshTxs()} />}
        {tab === 'me' && <MeScreen logged={logged} onLogged={(v) => setLogged(v)} syncText={`${sync.state}${sync.pending > 0 ? ` · 待同步 ${sync.pending}` : ''}`} />}
      </View>
      <View style={styles.tabbar}>
        {([
          ['record', '记账'],
          ['list', '明细'],
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

function RecordScreen({ onSaved }: { onSaved: () => void }) {
  const [type, setType] = useState<TransactionType>('expense');
  const [amount, setAmount] = useState('');
  const [cats, setCats] = useState<Cat[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void initDb().then(async () => setCats((await topCategories(type === 'income' ? 'income' : 'expense')) as unknown as Cat[]));
  }, [type]);

  const save = async () => {
    const v = Number(amount);
    if (!v || v <= 0 || !selected) return;
    const ledgerId = await getActiveLedgerId();
    if (!ledgerId) return;
    const now = Date.now();
    const tx = {
      id: newId(), ledger_id: ledgerId, user_id: 'local', member_id: null, type,
      amount: v.toFixed(2), currency: 'CNY', amount_base: v.toFixed(2), exchange_rate: null,
      category_id: selected, account_id: (await db.getAllAsync<{ id: string }>('SELECT id FROM accounts WHERE is_deleted = 0 ORDER BY sort LIMIT 1'))[0]?.id ?? '',
      to_account_id: null, happened_at: now, note: '', is_refunded: 0, refund_of_id: null,
      reimburse_status: null, exclude_from_budget: 0, attachment_count: 0, source: 'manual',
      client_version: 1, server_version: null, is_deleted: 0, deleted_at: null, created_at: now, updated_at: now,
    };
    await saveTx(tx);
    scheduleSync();
    setAmount('');
    setSelected(null);
    setMsg(`已记入 ¥${v.toFixed(2)}`);
    onSaved();
    setTimeout(() => setMsg(null), 1800);
  };

  return (
    <ScrollView contentContainerStyle={styles.form}>
      <View style={styles.typeRow}>
        {(['expense', 'income'] as TransactionType[]).map((t) => (
          <Pressable key={t} style={[styles.typeBtn, type === t && styles.typeBtnActive]} onPress={() => { setType(t); setSelected(null); }}>
            <Text style={[styles.typeText, type === t && styles.typeTextActive]}>{t === 'expense' ? '支出' : '收入'}</Text>
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
      <View style={styles.catGrid}>
        {cats.map((c) => (
          <Pressable key={c.id} style={[styles.catBtn, selected === c.id && styles.catBtnActive]} onPress={() => setSelected(c.id)}>
            <Text style={styles.catIcon}>{c.icon}</Text>
            <Text style={styles.catName}>{c.name}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable style={[styles.saveBtn, (!amount || !selected) && styles.disabled]} onPress={() => void save()}>
        <Text style={styles.saveText}>保存{amount && selected ? ` ¥${formatAmount(amount)}` : ''}</Text>
      </Pressable>
      {msg && <Text style={styles.msg}>{msg}</Text>}
    </ScrollView>
  );
}

function ListScreen({ txs, onRefresh }: { txs: TransactionRow[]; onRefresh: () => void }) {
  return (
    <ScrollView contentContainerStyle={styles.list}>
      <Pressable onPress={onRefresh}>
        <Text style={styles.muted}>下拉数据共 {txs.length} 笔 · 点此刷新</Text>
      </Pressable>
      {txs.map((t) => (
        <View key={t.id} style={styles.txRow}>
          <View style={styles.txMain}>
            <Text style={styles.txNote}>{t.note || (t.type === 'income' ? '收入' : '支出')}</Text>
            <Text style={styles.txDate}>{new Date(t.happened_at).toLocaleString('zh-CN')}</Text>
          </View>
          <Text style={[styles.txAmount, { color: t.type === 'income' ? '#1f9d6c' : '#1a1c23' }]}>
            {t.type === 'income' ? '+' : '-'}¥{formatAmount(String(t.amount))}
          </Text>
        </View>
      ))}
      {txs.length === 0 && <Text style={styles.muted}>还没有流水,去记账页记一笔</Text>}
    </ScrollView>
  );
}

function MeScreen({ logged, onLogged, syncText }: { logged: boolean; onLogged: (v: boolean) => void; syncText: string }) {
  const [server, setServer] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void initDb().then(async () => setServer(await getServerUrl()));
  }, []);

  const submit = async () => {
    if (!email || !password) return;
    setBusy(true);
    setMsg(null);
    try {
      await setServerUrl(server);
      let data = await authApi.login(email, password).catch(() => authApi.register(email, password));
      saveSession(data as never);
      // P0-1(第 27 轮):三态换号处理(明确换号清库/纯本地保留/残留清库),与 Web 同策略
      const action = await prepareAfterLogin(db, String((data as { user?: { id?: string } }).user?.id ?? ''));
      onLogged(true);
      setMsg(action === 'wiped' ? '检测到账号切换,已清空本地数据并重新同步' : '登录成功,同步已开启');
      await initDb(); // 清库后重播种/重初始化
      void engine.syncOnce();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
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
      <Text style={styles.meTitle}>{logged ? '已登录 · 云同步开启' : '未登录 · 纯本地模式'}</Text>
      <Text style={styles.muted}>离线也能记账:数据先存本机,连上服务器后自动同步</Text>
      <Text style={styles.muted}>同步状态:{syncText}</Text>
      {!logged && (
        <>
          <Text style={styles.label}>服务器</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
            {SERVER_PRESETS.map((p) => (
              <Pressable
                key={p.url}
                onPress={() => setServer(p.url)}
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
          <Text style={styles.label}>邮箱</Text>
          <TextInput style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="you@example.com" placeholderTextColor="#b4bac6" />
          <Text style={styles.label}>密码</Text>
          <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry placeholder="至少 8 位" placeholderTextColor="#b4bac6" />
          <Pressable style={[styles.saveBtn, busy && styles.disabled]} onPress={() => void submit()}>
            <Text style={styles.saveText}>{busy ? '请稍候…' : '登录(无账号自动注册)'}</Text>
          </Pressable>
        </>
      )}
      {logged && (
        <>
          <Pressable style={styles.saveBtn} onPress={() => void engine.syncOnce()}>
            <Text style={styles.saveText}>立即同步</Text>
          </Pressable>
          <Pressable style={[styles.saveBtn, styles.logout]} onPress={() => void logout()}>
            <Text style={[styles.saveText, { color: '#e5484d' }]}>退出登录(本地数据保留)</Text>
          </Pressable>
        </>
      )}
      {msg && <Text style={styles.msg}>{msg}</Text>}
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
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
