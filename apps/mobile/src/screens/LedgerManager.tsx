
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

export function LedgerManager({ onBack }: { onBack: () => void }) {
  const [ledgers, setLedgers] = useState<Array<Record<string, unknown> & { active?: number }>>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [delTarget, setDelTarget] = useState<Record<string, unknown> | null>(null);
  const [delPreview, setDelPreview] = useState<Record<string, number>>({});

  const load = async () => {
    await initDb();
    const active = await getActiveLedgerId();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM ledgers WHERE is_deleted = 0 ORDER BY created_at ASC');
    setLedgers(rows.map((r) => ({ ...r, active: String(r.id) === String(active) ? 1 : 0 })));
    // 级联影响预览(T-14):每账本统计将随之软删的实体数
    const ledgerId = active;
    void ledgerId;
    for (const r of rows) {
      const lid = String(r.id);
      const n = await db.getAllAsync<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM transactions WHERE ledger_id = ? AND is_deleted = 0)
              + (SELECT COUNT(*) FROM categories WHERE ledger_id = ? AND is_deleted = 0)
              + (SELECT COUNT(*) FROM accounts WHERE ledger_id = ? AND is_deleted = 0) AS n`, [lid, lid, lid]);
      setDelPreview((prev) => ({ ...prev, [lid]: Number(n[0]?.n ?? 0) }));
    }
  };
  useEffect(() => { void load(); }, []);

  const switchTo = async (id: string) => {
    await metaSet(db, 'active_ledger', id);
    onBack();
  };

  const create = async () => {
    const nm = name.trim().slice(0, 30);
    if (!nm) return;
    const id = await createLedgerWithSeed(nm); // T-03:播种默认分类与账户,修复新账本无分类可用
    await metaSet(db, 'active_ledger', id);
    setName(''); setCreating(false);
    onBack();
  };

  const rename = async (row: Record<string, unknown>) => {
    const nm = draft.trim().slice(0, 30);
    setEditingId(null);
    if (!nm || nm === row.name) return;
    const now = Date.now();
    await saveLocal(db, 'ledger', { ...row, name: nm, client_version: Number(row.client_version ?? 0) + 1, updated_at: now } as never);
    void load();
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#f6f7f9' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Pressable onPress={onBack}><Text style={{ fontSize: 16, color: '#4361ee' }}>‹ 返回</Text></Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: '#1a1c23' }}>账本管理</Text>
        <Pressable onPress={() => setCreating((v) => !v)}><Text style={{ fontSize: 20, color: '#4361ee' }}>＋</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
        {ledgers.map((row) => {
          const id = String(row.id);
          return (
            <View key={id} style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, borderWidth: row.active ? 2 : 0, borderColor: '#4361ee' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 18 }}>{String(row.icon ?? '📒')}</Text>
                {editingId === id ? (
                  <TextInput
                    style={{ flex: 1, borderBottomWidth: 1, borderColor: '#4361ee', fontSize: 14, color: '#1a1c23', paddingVertical: 2 }}
                    value={draft} autoFocus onChangeText={(t) => setDraft(t.slice(0, 30))}
                    onSubmitEditing={() => void rename(row)} onBlur={() => void rename(row)}
                  />
                ) : (
                  <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: '#1a1c23' }}>
                    {String(row.name)}{row.active ? ' · 当前' : ''}
                  </Text>
                )}
                {editingId !== id && (
                  <Pressable onPress={() => { setEditingId(id); setDraft(String(row.name)); }}>
                    <Text style={{ color: '#4361ee', fontSize: 13 }}>重命名</Text>
                  </Pressable>
                )}
              </View>
              {!row.active && (
                <>
                  <Pressable style={{ marginTop: 8, backgroundColor: '#eef0f6', borderRadius: 8, paddingVertical: 6, alignItems: 'center' }}
                    onPress={() => void switchTo(id)}>
                    <Text style={{ fontSize: 12, color: '#1a1c23' }}>切换到此账本</Text>
                  </Pressable>
                  <Pressable style={{ marginTop: 6 }} onPress={() => setDelTarget({ ...row, ...delPreview })}>
                    <Text style={{ color: '#d64545', fontSize: 12 }}>删除此账本</Text>
                  </Pressable>
                </>
              )}
            </View>
          );
        })}
        {creating && (
          <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, gap: 8 }}>
            <TextInput style={styles.input} value={name} onChangeText={(t) => setName(t.slice(0, 30))} placeholder="新账本名称" placeholderTextColor="#b4bac6" autoFocus />
            <Pressable style={[styles.saveBtn, !name && styles.disabled]} onPress={() => void create()}>
              <Text style={styles.saveText}>创建并切换</Text>
            </Pressable>
          </View>
        )}
        <Text style={{ fontSize: 11, color: '#8a93a5', textAlign: 'center' }}>切换账本后,记账/明细/报表都会显示所选账本的数据</Text>
      </ScrollView>
      {delTarget && (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center' }}>
          <View style={{ backgroundColor: '#fff', borderRadius: 12, margin: 24, padding: 16, gap: 10 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#d64545' }}>删除账本「{String(delTarget.name)}」?</Text>
            <Text style={{ fontSize: 12, color: '#4a5160' }}>
              将级联软删除该账本下约 {delPreview[String(delTarget.id)] ?? 0} 条记录(流水/分类/账户等)。此操作可从回收站恢复部分数据,但默认不可见。
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable style={{ ...styles.saveBtn, flex: 1, backgroundColor: '#eef0f6' }} onPress={() => setDelTarget(null)}>
                <Text style={{ ...styles.saveText, color: '#1a1c23' }}>取消</Text>
              </Pressable>
              <Pressable style={{ ...styles.saveBtn, flex: 2, backgroundColor: '#d64545' }}
                onPress={() => {
                  void (async () => {
                    const lid = String(delTarget.id);
                    const now = Date.now();
                    const tables: Array<[string, string]> = [
                      ['transactions', 'ledger_id'], ['categories', 'ledger_id'], ['accounts', 'ledger_id'],
                      ['budgets', 'ledger_id'], ['budget_items', 'ledger_id'],
                      ['recurring_rules', 'ledger_id'], ['savings_plans', 'ledger_id'],
                    ];
                    for (const [t, col] of tables) {
                      const rowsToDel = await db.getAllAsync<Record<string, unknown>>(
                        `SELECT * FROM ${t} WHERE ${col} = ? AND is_deleted = 0`, [lid]);
                      for (const r of rowsToDel) {
                        await saveLocal(db, t === 'transactions' ? 'transaction' : t === 'categories' ? 'category' : t === 'accounts' ? 'account' : t === 'budgets' ? 'budget' : t === 'budget_items' ? 'budget_item' : t === 'recurring_rules' ? 'recurring_rule' : 'savings_plan',
                          { ...r, is_deleted: true, deleted_at: now, client_version: Number(r.client_version ?? 0) + 1, updated_at: now } as never, { op: 'delete' });
                      }
                    }
                    await saveLocal(db, 'ledger', { ...delTarget, is_deleted: true, deleted_at: now, client_version: Number(delTarget.client_version ?? 0) + 1, updated_at: now } as never, { op: 'delete' });
                    setDelTarget(null);
                    scheduleSync();
                    await load();
                  })();
                }}>
                <Text style={styles.saveText}>确认删除</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

/** 手写账导出:选月份 → 生成手写账文本 → 分享/复制 */
