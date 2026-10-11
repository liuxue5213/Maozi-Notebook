
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

export function AccountSettings({ onBack, onLogged }: { onBack: () => void; onLogged: () => void }) {
  const [nickname, setNickname] = useState('');
  const [currency, setCurrency] = useState('CNY');
  const [delPwd, setDelPwd] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const u = (await authApi.me()) as { nickname?: string; base_currency?: string };
        setNickname(u.nickname ?? '');
        setCurrency(u.base_currency ?? 'CNY');
      } catch { /* 静默 */ }
    })();
  }, []);

  const saveProfile = async () => {
    setBusy(true);
    try {
      await authApi.updateMe({ nickname: nickname.trim().slice(0, 30), base_currency: currency });
      await metaSet(db, 'base_currency', currency);
      setMsg('已保存');
      setTimeout(() => setMsg(null), 1500);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const deleteAccount = async () => {
    if (!isValidAmount('1')) return; // noop guard
    setBusy(true);
    try {
      // 注销:服务端二次校验密码;成功后本地清库回未登录态
      await authApi.deleteMe(delPwd);
      await resetLocalDatabase();
      resetInitCache();
      await clearSession();
      onLogged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#f6f7f9' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Pressable onPress={onBack}><Text style={{ fontSize: 16, color: '#4361ee' }}>‹ 返回</Text></Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: '#1a1c23' }}>账号设置</Text>
        <Text style={{ fontSize: 16, color: 'transparent' }}>‹</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 10 }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, gap: 10 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1a1c23' }}>个人资料</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontSize: 12, color: '#4a5160', width: 60 }}>昵称</Text>
            <TextInput style={{ ...styles.input, flex: 1 }} value={nickname} onChangeText={(t) => setNickname(t.slice(0, 30))} placeholder="昵称" placeholderTextColor="#b4bac6" />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontSize: 12, color: '#4a5160', width: 60 }}>主币种</Text>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {(['CNY', 'USD', 'EUR', 'JPY'] as const).map((c) => (
                <Pressable key={c} onPress={() => setCurrency(c)}
                  style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 10, backgroundColor: currency === c ? '#4361ee' : '#eef0f6' }}>
                  <Text style={{ fontSize: 12, color: currency === c ? '#fff' : '#4a5160' }}>{c}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <Pressable style={[styles.saveBtn, busy && styles.disabled]} onPress={() => void saveProfile()}>
            <Text style={styles.saveText}>保存</Text>
          </Pressable>
        </View>
        <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, gap: 10 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#d64545' }}>危险区 · 注销账号</Text>
          <Text style={{ fontSize: 11, color: '#8a93a5' }}>将删除服务器账号与云端数据,并清空本机全部记录,不可恢复</Text>
          <TextInput style={styles.input} value={delPwd} onChangeText={setDelPwd} secureTextEntry placeholder="输入密码确认" placeholderTextColor="#b4bac6" />
          <Pressable style={{ ...styles.saveBtn, backgroundColor: '#d64545', ...(!delPwd && styles.disabled) }} onPress={() => void deleteAccount()}>
            <Text style={styles.saveText}>注销账号</Text>
          </Pressable>
        </View>
        {msg && <Text style={{ fontSize: 12, color: msg.includes('失败') || msg.includes('错误') ? '#d64545' : '#1f9d6c' }}>{msg}</Text>}
      </ScrollView>
    </View>
  );
}


/** 同步诊断(T-32):死信列表 + 清空(deadletter 表) */
export function DeadLetterScreen({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);

  const load = async () => {
    await initDb();
    try {
      const r = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM deadletter ORDER BY created_at DESC LIMIT 200');
      setRows(r);
    } catch { setRows([]); }
  };
  useEffect(() => { void load(); }, []);

  return (
    <View style={{ flex: 1, backgroundColor: '#f6f7f9' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Pressable onPress={onBack}><Text style={{ fontSize: 16, color: '#4361ee' }}>‹ 返回</Text></Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: '#1a1c23' }}>同步诊断(死信)</Text>
        <Text style={{ fontSize: 14, color: '#4361ee' }}>{rows.length}</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
        {rows.map((r, i) => (
          <View key={String(r.id ?? i)} style={{ backgroundColor: '#fff', borderRadius: 10, padding: 10 }}>
            <Text style={{ fontSize: 12, color: '#1a1c23' }}>{String(r.entity ?? '?')} · {String(r.reason ?? '').slice(0, 60)}</Text>
            <Text style={{ fontSize: 10, color: '#8a93a5' }}>{String(r.created_at ?? '')}</Text>
          </View>
        ))}
        {rows.length === 0 && <Text style={{ color: '#8a93a5', fontSize: 13, textAlign: 'center' }}>没有死信,同步一切正常</Text>}
        {rows.length > 0 && (
          <Pressable style={{ ...styles.saveBtn, backgroundColor: '#d64545' }}
            onPress={() => { void (async () => { await db.execAsync('DELETE FROM deadletter'); await load(); })(); }}>
            <Text style={styles.saveText}>清空死信</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}


/** 安全与隐私(与 Web 安全页对齐):应用锁/生物识别/PIN、隐私开关、同步诊断入口 */
export function SafetyScreen({ onBack, onOpenDead }: { onBack: () => void; onOpenDead: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [lockOn, setLockOn] = useState(false);
  const [lockMode, setLockMode] = useState<'pin' | 'biometric'>('pin');
  const [bioAvail, setBioAvail] = useState(false);
  const [bioOff, setBioOff] = useState(false);
  const [pinExists, setPinExists] = useState(false);
  const [pinMode, setPinMode] = useState<'setup' | 'change'>('setup');
  const [pinOld, setPinOld] = useState('');
  const [pinNew, setPinNew] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinSetup, setPinSetup] = useState(false);
  const [privStat, setPrivStat] = useState(false);
  const [privCrash, setPrivCrash] = useState(false);
  const [aiOn, setAiOn] = useState(true);

  useEffect(() => {
    void (async () => {
      setLockOn(await isLockEnabled());
      setBioAvail(await biometricAvailable());
      setBioOff(await isBiometricDisabled());
      setPinExists(await hasPin());
      setLockMode(await activeLockMode());
      setPrivStat((await SecureStore.getItemAsync('priv_stat')) === '1');
      setPrivCrash((await SecureStore.getItemAsync('priv_crash')) === '1');
      setAiOn(await aiEnabledFlag());
    })();
  }, []);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3000); };
  const msgIsErr = msg ? /错误|过多|失败/.test(msg) : false;

  return (
    <ScrollView contentContainerStyle={styles.form}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Pressable onPress={onBack}><Text style={{ fontSize: 16, color: '#4361ee' }}>‹ 返回</Text></Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: '#1a1c23' }}>安全与隐私</Text>
        <Text style={{ fontSize: 16, color: 'transparent' }}>‹</Text>
      </View>
      <Pressable style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 }}
        onPress={() => {
          void (async () => {
            if (await isLockEnabled()) {
              await disableLock(); setPinSetup(false); setLockOn(false); flash('应用锁已关闭');
            } else {
              await enableLock();
              const mode = await activeLockMode();
              setLockOn(true); setLockMode(mode);
              if (mode === 'biometric') flash('应用锁已开启(面容/指纹),可在下方自由切换或关闭');
              else { setPinMode('setup'); setPinSetup(true); return; }
            }
          })();
        }}>
        <Text style={{ fontSize: 13, color: '#1a1c23' }}>🔒 应用锁(生物识别 / PIN)</Text>
        <Text style={{ fontSize: 12, color: lockOn ? '#1f9d6c' : '#8a93a5' }}>{lockOn ? `开启中(${lockMode === 'biometric' ? '指纹/面容' : 'PIN'})` : '点按开启'}</Text>
      </Pressable>
      {lockOn && bioAvail && (
        <Pressable style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 }}
          onPress={() => {
            void (async () => {
              if (!bioOff) {
                await setBiometricDisabled(true); setBioOff(true); setLockMode('pin');
                if (!(await hasPin())) { setPinMode('setup'); setPinSetup(true); }
                flash('生物识别已关闭,改用 PIN 解锁');
              } else {
                await setBiometricDisabled(false); setBioOff(false); setLockMode('biometric');
                flash('生物识别已开启,下次解锁生效');
              }
            })();
          }}>
          <Text style={{ fontSize: 13, color: '#1a1c23' }}>☝️ 生物识别(指纹/面容)</Text>
          <Text style={{ fontSize: 12, color: bioOff ? '#8a93a5' : '#1f9d6c' }}>{bioOff ? '已关闭 · 用 PIN' : '已开启 · 点按关闭'}</Text>
        </Pressable>
      )}
      {lockOn && (
        <Pressable style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 }}
          onPress={() => { setPinMode(pinExists ? 'change' : 'setup'); setPinOld(''); setPinNew(''); setPinConfirm(''); setPinSetup(true); }}>
          <Text style={{ fontSize: 13, color: '#1a1c23' }}>🔑 {pinExists ? '修改 PIN' : '设置 PIN'}</Text>
          <Text style={{ fontSize: 12, color: '#8a93a5' }}>{pinExists ? '需验证当前 PIN' : '4–8 位数字'}</Text>
        </Pressable>
      )}
      {pinSetup && (
        <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, gap: 8 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1a1c23' }}>{pinMode === 'change' ? '修改 PIN' : '设置应用锁 PIN(4–8 位数字)'}</Text>
          {pinMode === 'change' && (
            <TextInput style={styles.input} value={pinOld} onChangeText={(t) => setPinOld(t.replace(/[^\d]/g, '').slice(0, 8))} keyboardType="number-pad" secureTextEntry placeholder="输入当前 PIN" placeholderTextColor="#b4bac6" />
          )}
          <TextInput style={styles.input} value={pinNew} onChangeText={(t) => setPinNew(t.replace(/[^\d]/g, '').slice(0, 8))} keyboardType="number-pad" secureTextEntry placeholder="输入新 PIN" placeholderTextColor="#b4bac6" />
          <TextInput style={styles.input} value={pinConfirm} onChangeText={(t) => setPinConfirm(t.replace(/[^\d]/g, '').slice(0, 8))} keyboardType="number-pad" secureTextEntry placeholder="再次输入确认" placeholderTextColor="#b4bac6" />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable
              style={{ flex: 1, backgroundColor: pinNew.length >= 4 && pinNew === pinConfirm ? '#4361ee' : '#eef0f6', borderRadius: 10, paddingVertical: 10, alignItems: 'center', opacity: pinNew.length >= 4 && pinNew === pinConfirm ? 1 : 0.5 }}
              disabled={pinNew.length < 4 || pinNew !== pinConfirm}
              onPress={() => {
                void (async () => {
                  if (pinMode === 'change') {
                    const r = await verifyPin(pinOld);
                    if (r === 'wrong') { flash('当前 PIN 错误'); return; }
                    if (r === 'locked') { flash('失败次数过多,请 60 秒后再试'); return; }
                  }
                  await setPin(pinNew);
                  setPinSetup(false); setPinNew(''); setPinConfirm(''); setPinOld('');
                  setPinExists(true); setLockMode('pin'); setLockOn(true);
                  flash(pinMode === 'change' ? 'PIN 已修改' : '应用锁已开启(PIN)');
                })();
              }}>
              <Text style={{ fontSize: 13, color: pinNew.length >= 4 && pinNew === pinConfirm ? '#fff' : '#8a93a5' }}>确认</Text>
            </Pressable>
            <Pressable
              style={{ flex: 1, backgroundColor: '#eef0f6', borderRadius: 10, paddingVertical: 10, alignItems: 'center' }}
              onPress={() => {
                void (async () => {
                  if (pinMode === 'setup' && !(await hasPin())) await disableLock();
                  setLockOn(await isLockEnabled());
                  setPinSetup(false); setPinNew(''); setPinConfirm(''); setPinOld('');
                })();
              }}>
              <Text style={{ fontSize: 13, color: '#4a5160' }}>取消</Text>
            </Pressable>
          </View>
        </View>
      )}
      <Text style={{ fontSize: 13, fontWeight: '700', color: '#1a1c23', marginTop: 8 }}>隐私开关</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 }}>
        <Text style={{ fontSize: 13, color: '#1a1c23', flex: 1 }}>允许 AI 分析我的数据(统计摘要+备注前8字出域;关闭即零出域)</Text>
        <Switch value={aiOn} onValueChange={(v) => { setAiOn(v); void setAiEnabled(v); }} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 }}>
        <Text style={{ fontSize: 13, color: '#1a1c23' }}>行为统计</Text>
        <Switch value={privStat} onValueChange={(v) => { setPrivStat(v); void SecureStore.setItemAsync('priv_stat', v ? '1' : '0'); }} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 }}>
        <Text style={{ fontSize: 13, color: '#1a1c23' }}>崩溃上报</Text>
        <Switch value={privCrash} onValueChange={(v) => { setPrivCrash(v); void SecureStore.setItemAsync('priv_crash', v ? '1' : '0'); }} />
      </View>
      <Text style={{ fontSize: 11, color: '#8a93a5' }}>两项暂未接入统计/上报 SDK,开关仅记录偏好(与 Web 口径一致)</Text>
      <Pressable style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, marginTop: 8 }}
        onPress={onOpenDead}>
        <Text style={{ fontSize: 13, color: '#1a1c23' }}>🩺 同步诊断(死信)</Text>
        <Text style={{ fontSize: 12, color: '#8a93a5' }}>导出 · 清空 ›</Text>
      </Pressable>
      {msg && <Text style={{ fontSize: 12, color: msgIsErr ? '#d64545' : '#1f9d6c' }}>{msg}</Text>}
    </ScrollView>
  );
}

export function MeScreen({ logged, onLogged, syncText, lastSyncAt, onSync, onOpen }: { logged: boolean; onLogged: (v: boolean) => void; syncText: string; lastSyncAt: number | null; onSync: () => void; onOpen: (p: 'cats' | 'savings' | 'import' | 'recurring' | 'ledgers' | 'export' | 'accounts' | 'settings' | 'dead' | 'safety') => void }) {
  const [server, setServer] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [me, setMe] = useState<{ email?: string | null; nickname?: string | null } | null>(null);

  useEffect(() => {
    void initDb().then(async () => {
      setServer(await getServerUrl());
      if (logged) {
        try {
          const u = (await authApi.me()) as { email?: string; nickname?: string; base_currency?: string };
          setMe({ email: u.email, nickname: u.nickname });
          if (u.base_currency) await metaSet(db, 'base_currency', u.base_currency); // T-02:主币种跟随账号
        } catch { /* token 失效等场景静默,下轮刷新 */ }
      } else {
        setMe(null);
      }
    });
  }, [logged]);

  const submit = async () => {
    if (!email || !password) return;
    // T-05:协议白名单,非法地址直接拒绝,不再进故障转移链
    const invalid = validateServerUrl(server);
    if (invalid) { setMsg(invalid); return; }
    setBusy(true);
    setMsg(null);
    try {
      // 故障转移链:用户所选地址优先 → 公网 frp → 局域网 → 全断时报错并保持离线
      const reachable = await resolveServerUrl(server.trim() || undefined);
      setServer(reachable);
      await setServerUrl(reachable);
      let data;
      try {
        data = await authApi.login(email, password);
      } catch (loginErr) {
        const ls = String(loginErr instanceof Error ? loginErr.message : loginErr);
        // 密码错误(401)不该触发注册兜底
        if (ls.includes('密码错误') || ls.includes('邮箱或密码错误')) throw loginErr;
        console.log('[auth] login 失败,转注册:', ls);
        data = await authApi.register(email, password);
      }
      console.log('[auth] 成功,服务器:', reachable);
      saveSession(data as never);
      // P0-1(第 27 轮):三态换号处理(明确换号清库/纯本地保留/残留清库),与 Web 同策略
      const action = await prepareAfterLogin(db, String((data as { user?: { id?: string } }).user?.id ?? ''));
      if (action === 'wiped') {
        // wipeAllTables 不清 meta:seeded/active_ledger 残留会让新账号掉进"幽灵账本"
        await metaSet(db, 'seeded', null);
        await metaSet(db, 'active_ledger', null);
        resetInitCache();
      }
      onLogged(true);
      await initDb(); // 清库后重播种/重初始化
      // 幽灵账本工厂关闭(2026-10-09):全新安装/换号后本地游标为 0 时改「先拉后推」,
      // 并在推送前丢弃从未上行的空种子账本(有真实流水的离线账本不受影响),
      // 否则种子必被推上云,服务端持续滋生同名幽灵账本、两端各锁各的账本
      const freshInstall = Number((await metaGet(db, 'sync_cursor')) ?? 0) === 0;
      await engine.syncOnce({
        pullFirst: freshInstall,
        beforePush: async () => {
          const unsynced = await db.getAllAsync<{ id: string }>(
            'SELECT id FROM ledgers WHERE server_version IS NULL AND is_deleted = 0');
          const hasServer = await db.getAllAsync<{ id: string }>(
            'SELECT id FROM ledgers WHERE server_version IS NOT NULL AND is_deleted = 0 LIMIT 1');
          if (!unsynced.length || !hasServer.length) return;
          for (const l of unsynced) {
            const hasTx = await db.getAllAsync<{ n: number }>(
              'SELECT COUNT(*) AS n FROM transactions WHERE ledger_id = ?', [l.id]);
            if (Number(hasTx[0]?.n ?? 0) > 0) continue; // 有流水的离线账本是真实数据,保留
            for (const t of ['transactions', 'categories', 'accounts', 'budgets', 'budget_items', 'recurring_rules', 'savings_plans']) {
              await db.runAsync(`DELETE FROM ${t} WHERE ledger_id = ?`, [l.id]);
            }
            await db.runAsync('DELETE FROM ledgers WHERE id = ?', [l.id]);
            // 关键:连同其 outbox 残留操作一并清除,否则种子操作仍会上行再造幽灵(审查修复)
            await db.runAsync('DELETE FROM outbox WHERE payload LIKE ?', [`%${l.id}%`]);
          }
          await metaSet(db, 'active_ledger', null);
          resetInitCache();
        },
      });
      // 首登收敛:登录同步完成后,当前账本一律对齐到该账号「最早创建的已同步账本」
      // (与 Web 端默认口径一致)。否则手机本地 seed 的新账本一旦 push 上云就永远不会切换,
      // 造成同账号两端各看各的空账本。
      const active = await getActiveLedgerId();
      const earliest = await db.getAllAsync<{ id: string; created_at: number }>(
        'SELECT id, created_at FROM ledgers WHERE server_version IS NOT NULL AND is_deleted = 0 ORDER BY created_at ASC LIMIT 1');
      const earliestRow = await db.getAllAsync<{ created_at: number }>(
        'SELECT created_at FROM ledgers WHERE id = ?', [active]);
      if (earliest[0]?.id && earliest[0].id !== active
          && (!earliestRow[0] || earliest[0].created_at < Number(earliestRow[0].created_at))) {
        await metaSet(db, 'active_ledger', earliest[0].id);
        console.log('[auth] 账本对齐到最早服务器账本:', earliest[0].id);
      }
      setMsg(action === 'wiped' ? '检测到账号切换,已清空本地数据并重新同步' : '登录成功,同步已开启');
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      console.log('[auth] 登录/注册失败:', m);
      const network = /fetch failed|Connect|TIMEDOUT|timeout|不可达/i.test(m);
      setMsg(network
        ? '连接服务器失败(公网与局域网均不可达)——已保持离线模式,本地记账不受影响;网络恢复后请重试登录'
        : m);
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
      <Text style={styles.meTitle}>{logged ? `${me?.nickname || me?.email || '已登录'} · 云同步开启` : '未登录 · 纯本地模式'}</Text>
      <Text style={styles.muted}>离线也能记账:数据先存本机,连上服务器后自动同步</Text>
      {/* 菜单与 Web「我的」页同构(顺序/命名/副标题一致) */}
      {([
        ['待确认池 📥', '导入账单 · 去重确认', 'import'],
        ['存钱计划 🐷', '目标 · 净结余进度', 'savings'],
        ['账本管理 📚', '多账本 · 切换 · 新建', 'ledgers'],
        ['分类管理 🏷️', '自定义 · 隐藏 · 删除', 'cats'],
        ['周期记账 🔁', '房租工资自动记', 'recurring'],
        ['账户与资产 💼', '余额 · 净值', 'accounts'],
        ['账号设置 ⚙️', '昵称 · 主币种 · 注销', 'settings'],
        ['导出与备份 📄', '手写账 · CSV', 'export'],
        ['安全与隐私 🔒', '应用锁 · 隐私 · 死信', 'safety'],
      ] as Array<[string, string, 'import' | 'savings' | 'ledgers' | 'cats' | 'recurring' | 'accounts' | 'settings' | 'export' | 'safety']>).map(([label, hint, key]) => (
        <Pressable key={key} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 2 }}
          onPress={() => onOpen(key)}>
          <Text style={{ fontSize: 13, color: '#1a1c23' }}>{label}</Text>
          <Text style={{ fontSize: 12, color: '#8a93a5' }}>{hint} ›</Text>
        </Pressable>
      ))}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, marginTop: 8 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 13, color: '#1a1c23' }}>同步状态</Text>
          <Text style={{ fontSize: 11, color: '#8a93a5', marginTop: 2 }} numberOfLines={1}>{syncText}{lastSyncAt ? ` · 上次 ${new Date(lastSyncAt).toLocaleTimeString('zh-CN')}` : ''}</Text>
        </View>
        <Pressable style={{ backgroundColor: '#4361ee', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 14 }} onPress={onSync}>
          <Text style={{ color: '#fff', fontSize: 12 }}>立即同步</Text>
        </Pressable>
      </View>
      {!logged && (
        <>
          <Text style={styles.label}>服务器</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
            {SERVER_PRESETS.map((p) => (
              <Pressable
                key={p.url}
                onPress={() => { setServer(p.url); void setServerUrl(p.url); }}
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
          {insecureTransportReason(server) && (
            <Text style={{ fontSize: 11, color: '#e67e22', marginBottom: 6 }}>{insecureTransportReason(server)}</Text>
          )}
          <Text style={styles.label}>邮箱</Text>
          <TextInput style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="you@example.com" placeholderTextColor="#b4bac6" />
          <Text style={styles.label}>密码</Text>
          <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry placeholder="至少 8 位" placeholderTextColor="#b4bac6" />
          {msg && <Text style={{ fontSize: 12, color: /失败|错误|不可达/.test(msg) ? '#d64545' : '#1f9d6c', marginTop: 4 }}>{msg}</Text>}
          <Pressable style={[styles.saveBtn, busy && styles.disabled]} onPress={() => void submit()}>
            <Text style={styles.saveText}>{busy ? '请稍候…' : '登录(无账号自动注册)'}</Text>
          </Pressable>
        </>
      )}
      {logged && (
        <>
          <Pressable style={[styles.saveBtn, styles.logout]} onPress={() => void logout()}>
            <Text style={[styles.saveText, { color: '#e5484d' }]}>退出登录(本地数据保留)</Text>
          </Pressable>
        </>
      )}
    </ScrollView>
  );
}

