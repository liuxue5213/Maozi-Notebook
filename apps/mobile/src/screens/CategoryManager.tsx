
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

/** 分类管理:重命名 / 隐藏显示(v1;排序后续)。入口在「我的」页 */
export function CategoryManager({ onBack }: { onBack: () => void }) {
  const [cats, setCats] = useState<Array<Record<string, unknown>>>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState<'expense' | 'income'>('expense');

  const load = async () => {
    await initDb();
    const ledgerId = await getActiveLedgerId();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM categories WHERE is_deleted = 0 AND ledger_id = ? ORDER BY kind, sort', [ledgerId]);
    setCats(rows);
  };
  useEffect(() => { void load(); }, []);

  const persist = async (row: Record<string, unknown>) => {
    const now = Date.now();
    await saveLocal(db, 'category', { ...row, client_version: Number(row.client_version ?? 0) + 1, updated_at: now } as never);
  };

  const rename = async (row: Record<string, unknown>) => {
    const name = draft.trim().slice(0, 20);
    setEditingId(null);
    if (!name || name === row.name) return;
    await persist({ ...row, name });
    void load();
  };

  const toggleHidden = async (row: Record<string, unknown>) => {
    await persist({ ...row, is_hidden: !row.is_hidden });
    void load();
  };

  const groups = cats.filter((c) => c.kind === tab);
  return (
    <View style={{ flex: 1, backgroundColor: '#f6f7f9' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Pressable onPress={onBack}><Text style={{ fontSize: 16, color: '#4361ee' }}>‹ 返回</Text></Pressable>
        <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: '#1a1c23' }}>分类管理</Text>
        <Text style={{ fontSize: 16, color: 'transparent' }}>‹</Text>
      </View>
      <View style={{ flexDirection: 'row', paddingHorizontal: 12, gap: 8, paddingBottom: 8 }}>
        {(['expense', 'income'] as const).map((k) => (
          <Pressable key={k} onPress={() => setTab(k)}
            style={{ paddingVertical: 6, paddingHorizontal: 14, borderRadius: 14, backgroundColor: tab === k ? '#4361ee' : '#eef0f6' }}>
            <Text style={{ fontSize: 13, color: tab === k ? '#fff' : '#4a5160' }}>{k === 'expense' ? '支出分类' : '收入分类'}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 6 }}>
        {groups.map((row) => {
          const id = String(row.id);
          const hidden = !!row.is_hidden;
          return (
            <View key={id} style={{ backgroundColor: '#fff', borderRadius: 10, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontSize: 18 }}>{String(row.icon)}</Text>
              {editingId === id ? (
                <TextInput
                  style={{ flex: 1, borderBottomWidth: 1, borderColor: '#4361ee', fontSize: 14, color: '#1a1c23', paddingVertical: 2 }}
                  value={draft} autoFocus onChangeText={(t) => setDraft(t.slice(0, 20))}
                  onSubmitEditing={() => void rename(row)} onBlur={() => void rename(row)}
                />
              ) : (
                <Text style={{ flex: 1, fontSize: 14, color: hidden ? '#b4bac6' : '#1a1c23' }}>
                  {String(row.name)}{hidden ? '(已隐藏)' : ''}
                </Text>
              )}
              {editingId !== id && (
                <Pressable onPress={() => { setEditingId(id); setDraft(String(row.name)); }}>
                  <Text style={{ color: '#4361ee', fontSize: 13 }}>重命名</Text>
                </Pressable>
              )}
              <Pressable onPress={() => void toggleHidden(row)}>
                <Text style={{ color: hidden ? '#1f9d6c' : '#8a93a5', fontSize: 13 }}>{hidden ? '显示' : '隐藏'}</Text>
              </Pressable>
            </View>
          );
        })}
        {groups.length === 0 && <Text style={{ color: '#8a93a5', fontSize: 13 }}>暂无分类</Text>}
      </ScrollView>
    </View>
  );
}

/** 存钱计划:列表 + 新建 + 进度(已存 = 期间净结余,复用 ledger-core netSavings) */
