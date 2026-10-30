
import { buildBudgetModel, netSavings, type BudgetModel } from '@ledgerone/ledger-core';
import { isValidAmount, parseTextLedger, reconcileTextLedger, renderTextLedger, billingCycleRange, daysUntilDue, accountBalance, isLiability, dedupeHash, buildCsv, exportFileName, budgetPeriodRange, formatAmount, newId, type TransactionRow } from '@ledgerone/domain';
import React, { useCallback, useEffect, useRef, useState } from 'react';
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

export function ReportScreen({ onDrill }: { onDrill: (catId: string, monthOffset: number) => void }) {
  const [aiText, setAiText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  // N5 对话式查询「问一问」
  const [askText, setAskText] = useState('');
  const [askAnswer, setAskAnswer] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [monthOffset, setMonthOffset] = useState(0);
  const [sum, setSum] = useState({ income: 0, expense: 0 });
  const [byCat, setByCat] = useState<Array<{ name: string; icon: string; total: number; pct: number; catId: string | null }>>([]);
  const [busy, setBusy] = useState(false);
  const [selectedCat, setSelectedCat] = useState<string | null | undefined>(undefined);
  const [detailRows, setDetailRows] = useState<TransactionRow[]>([]);
  const [detailCount, setDetailCount] = useState(0);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequest = useRef(0);
  const mr = monthRange(monthOffset);

  const load = async () => {
    setBusy(true);
    try {
      await initDb();
      const ledgerId = await getActiveLedgerId();
      if (!ledgerId) return;
      const base = 't.is_deleted = 0 AND t.ledger_id = ? AND t.happened_at >= ? AND t.happened_at < ?';
      const bparams: Array<string | number> = [ledgerId, mr.start, mr.end];
      const sums = await db.getAllAsync<{ type: string; s: number }>(
        `SELECT type, SUM(CAST(amount AS REAL)) AS s FROM transactions t WHERE ${base} GROUP BY type`, bparams);
      setSum({
        income: Number(sums.find((r) => r.type === 'income')?.s ?? 0),
        expense: Number(sums.find((r) => r.type === 'expense')?.s ?? 0),
      });
      const cats = await db.getAllAsync<{ name: string; icon: string; s: number; catId: string | null }>(
        `SELECT COALESCE(c.name, '未分类') AS name, COALESCE(c.icon, '📦') AS icon, t.category_id AS catId,
                SUM(CAST(t.amount AS REAL)) AS s
         FROM transactions t LEFT JOIN categories c ON t.category_id = c.id
         WHERE ${base} AND t.type = 'expense' GROUP BY t.category_id ORDER BY s DESC LIMIT 10`, bparams);
      const max = Number(cats[0]?.s ?? 0) || 1;
      setByCat(cats.map((r) => ({ name: r.name, icon: r.icon, total: Number(r.s), pct: Math.round((Number(r.s) / max) * 100), catId: r.catId })));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    detailRequest.current += 1;
    setSelectedCat(undefined);
    setDetailRows([]);
    setDetailCount(0);
    setDetailBusy(false);
    void load();
  }, [monthOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  const showDetails = async (catId: string | null) => {
    const request = ++detailRequest.current;
    if (selectedCat === catId) { setSelectedCat(undefined); setDetailRows([]); setDetailCount(0); setDetailBusy(false); return; }
    setSelectedCat(catId);
    setDetailRows([]);
    setDetailCount(0);
    setDetailBusy(true);
    setDetailError(null);
    try {
      await initDb();
      const ledgerId = await getActiveLedgerId();
      const categoryWhere = catId === null ? 't.category_id IS NULL' : 't.category_id = ?';
      const rows = await db.getAllAsync<TransactionRow>(
        `SELECT t.* FROM transactions t WHERE t.is_deleted = 0 AND t.ledger_id = ? AND t.happened_at >= ? AND t.happened_at < ? AND t.type = 'expense' AND ${categoryWhere}`,
        catId === null ? [ledgerId, mr.start, mr.end] : [ledgerId, mr.start, mr.end, catId],
      );
      rows.sort((a, b) => Number(b.happened_at) - Number(a.happened_at));
      if (request !== detailRequest.current) return;
      setDetailCount(rows.length);
      setDetailRows(rows.slice(0, 50));
    } catch (e) {
      if (request === detailRequest.current) setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request === detailRequest.current) setDetailBusy(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 }}>
        <Pressable onPress={() => setMonthOffset((m) => m + 1)}><Text style={{ fontSize: 18, color: '#4a5160' }}>‹</Text></Pressable>
        <Text style={{ fontWeight: '700', color: '#1a1c23', fontSize: 15 }}>{monthOffset === 0 ? '本月报表' : `${mr.label}报表`}</Text>
        {monthOffset > 0
          ? <Pressable onPress={() => setMonthOffset((m) => Math.max(0, m - 1))}><Text style={{ fontSize: 18, color: '#4a5160' }}>›</Text></Pressable>
          : <Text style={{ fontSize: 18, color: 'transparent' }}>›</Text>}
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 10 }}>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1, backgroundColor: '#eafaf1', borderRadius: 12, padding: 14 }}>
            <Text style={{ fontSize: 12, color: '#1f9d6c' }}>本月收入</Text>
            <Text style={{ fontSize: 18, fontWeight: '800', color: '#1f9d6c', marginTop: 4 }}>¥{formatAmount(String(sum.income))}</Text>
          </View>
          <View style={{ flex: 1, backgroundColor: '#fdeeee', borderRadius: 12, padding: 14 }}>
            <Text style={{ fontSize: 12, color: '#d64545' }}>本月支出</Text>
            <Text style={{ fontSize: 18, fontWeight: '800', color: '#d64545', marginTop: 4 }}>¥{formatAmount(String(sum.expense))}</Text>
          </View>
        </View>
        <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14 }}>
          <Text style={{ fontSize: 12, color: '#4a5160', marginBottom: 8 }}>本月结余</Text>
          <Text style={{ fontSize: 20, fontWeight: '800', color: '#1a1c23' }}>
            ¥{formatAmount(String(sum.income - sum.expense))}
          </Text>
        </View>
        <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: '#1a1c23' }}>支出分类排行 Top10</Text>
            <Pressable style={{ backgroundColor: '#eef0f6', borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8 }}
              onPress={() => {
                setAiBusy(true); setAiText('');
                void (async () => {
                const _lid = await getActiveLedgerId();
                const _ms = new Date(new Date().getFullYear(), new Date().getMonth() - monthOffset, 1).getTime();
                const _me = new Date(new Date().getFullYear(), new Date().getMonth() - monthOffset + 1, 1).getTime();
                  try {
                    if (!(await aiEnabledFlag())) { setAiText('已在「安全与隐私」中关闭 AI 分析'); return; }
                    // N1+: 传当月全部流水明细,让 AI 做笔级分析
                    const monthTxRows = await db.getAllAsync<{ happened_at: number; amount: string; note: string | null; category_id: string | null }>(
                      'SELECT happened_at, amount, note, category_id FROM transactions WHERE is_deleted = 0 AND ledger_id = ? AND happened_at >= ? AND happened_at < ? ORDER BY happened_at',
                      [_lid, _ms, _me]);
                    const catLkp = new Map((await db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM categories WHERE is_deleted = 0 AND ledger_id = ?', [_lid])).map((c) => [c.id, c.name]));
                    const recentTxs = monthTxRows.map((t) => ({
                      note: (t.note ?? '').slice(0, 8),
                      amount: t.amount,
                      date: new Date(t.happened_at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }),
                      category: t.category_id ? (catLkp.get(t.category_id) ?? '') : '',
                    }));
                    const r = await aiInsights({
                      month: monthOffset === 0 ? '本月' : mr.label,
                      income: String(sum.income), expense: String(sum.expense),
                      budget: null,
                      topCategories: byCat.slice(0, 10).map((c) => ({ name: c.name, amount: String(c.total) })),
                      recentTxs,
                    });
                    setAiText(r.text);
                  } catch (e) { setAiText(`分析失败:${e instanceof Error ? e.message : String(e)}`); }
                  finally { setAiBusy(false); }
                })();
              }}>
              <Text style={{ fontSize: 12, color: '#4361ee' }}>{aiBusy ? '分析中…' : '🤖 AI 分析'}</Text>
            </Pressable>
          </View>
          {aiText && <Text style={{ fontSize: 12, color: '#1a1c23', lineHeight: 18, marginBottom: 10, backgroundColor: '#f6f7ff', borderRadius: 8, padding: 8 }}>{aiText}</Text>}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
            <TextInput
              style={{ ...styles.input, flex: 1, minHeight: 36 }}
              value={askText}
              onChangeText={(t) => setAskText(t.slice(0, 200))}
              placeholder="🤖 问一问:如「这个月吃饭花多少」"
              placeholderTextColor="#b4bac6"
              onSubmitEditing={() => {
                void (async () => {
                  const q = askText.trim();
                  if (!q || askBusy) return;
                  if (!(await aiEnabledFlag())) { setAskAnswer('已在「安全与隐私」中关闭 AI 分析'); return; }
                  setAskBusy(true); setAskAnswer('');
                  try {
                    const top = byCat.slice(0, 10).map((c) => `${c.name} ${c.total}元`).join('、');
                    const ctx = `记账数据(${monthOffset === 0 ? '本月' : mr.label}):收入 ${sum.income} 元,支出 ${sum.expense} 元。支出分类排行: ${top || '无'}。`;
                    const r = await aiChat(`${ctx}\n用户问题: ${q}`);
                    setAskAnswer(r.text);
                  } catch (e) { setAskAnswer(`问答失败:${e instanceof Error ? e.message : String(e)}`); }
                  finally { setAskBusy(false); }
                })();
              }}
            />
            <Pressable style={{ backgroundColor: askBusy || !askText.trim() ? '#b4bac6' : '#4361ee', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, justifyContent: 'center' }}
              disabled={askBusy || !askText.trim()}
              onPress={() => {
                void (async () => {
                  const q = askText.trim();
                  if (!q || askBusy) return;
                  if (!(await aiEnabledFlag())) { setAskAnswer('已在「安全与隐私」中关闭 AI 分析'); return; }
                  setAskBusy(true); setAskAnswer('');
                  try {
                    const top = byCat.slice(0, 10).map((c) => `${c.name} ${c.total}元`).join('、');
                    const ctx = `记账数据(${monthOffset === 0 ? '本月' : mr.label}):收入 ${sum.income} 元,支出 ${sum.expense} 元。支出分类排行: ${top || '无'}。`;
                    const r = await aiChat(`${ctx}\n用户问题: ${q}`);
                    setAskAnswer(r.text);
                  } catch (e) { setAskAnswer(`问答失败:${e instanceof Error ? e.message : String(e)}`); }
                  finally { setAskBusy(false); }
                })();
              }}>
              <Text style={{ color: '#fff', fontSize: 12 }}>{askBusy ? '思考中…' : '提问'}</Text>
            </Pressable>
          </View>
          {askAnswer && <Text style={{ fontSize: 12, color: '#1a1c23', lineHeight: 18, marginBottom: 10, backgroundColor: '#f6f7ff', borderRadius: 8, padding: 8 }}>{askAnswer}</Text>}
          {byCat.length === 0 && <Text style={{ color: '#8a93a5', fontSize: 12 }}>本月暂无支出</Text>}
          {byCat.map((c, i) => (
            <Pressable key={c.name + i} style={{ marginBottom: 10 }} onPress={() => void showDetails(c.catId)}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={{ fontSize: 12, color: '#1a1c23' }}>{c.icon} {c.name} {selectedCat === c.catId ? '⌄' : '›'}</Text>
                <Text style={{ fontSize: 12, color: '#4a5160' }}>¥{formatAmount(String(c.total))}</Text>
              </View>
              <View style={{ height: 6, backgroundColor: '#eef0f6', borderRadius: 3 }}>
                <View style={{ height: 6, width: `${Math.max(4, c.pct)}%`, backgroundColor: i === 0 ? '#4361ee' : '#8fa3f5', borderRadius: 3 }} />
              </View>
            </Pressable>
          ))}
          {selectedCat !== undefined && (
            <View style={{ borderTopWidth: 1, borderTopColor: '#eef0f6', paddingTop: 10, gap: 8 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#1a1c23' }}>
                {byCat.find((c) => c.catId === selectedCat)?.name ?? '未分类'} · 流水明细{detailCount ? `(${detailCount})` : ''}
              </Text>
              {detailBusy && <Text style={styles.muted}>加载中…</Text>}
              {detailError && <Text style={{ color: '#d64545', fontSize: 12 }}>明细加载失败：{detailError}</Text>}
              {!detailBusy && !detailError && detailRows.length === 0 && <Text style={styles.muted}>暂无流水</Text>}
              {detailRows.map((row) => (
                <View key={row.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 5 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 12, color: '#4a5160' }}>{new Date(row.happened_at).toLocaleString('zh-CN')}</Text>
                    {!!row.note && <Text style={{ fontSize: 13, color: '#1a1c23', marginTop: 2 }}>{row.note}</Text>}
                  </View>
                  <Text style={{ fontSize: 13, color: '#d64545' }}>-¥{formatAmount(String(row.amount))}</Text>
                </View>
              ))}
              {detailCount > 50 && <Text style={styles.muted}>仅显示最近 50 笔</Text>}
              {selectedCat !== null && detailCount > 0 && (
                <Pressable onPress={() => onDrill(selectedCat, monthOffset)}>
                  <Text style={{ color: '#4361ee', fontSize: 13 }}>在明细页查看全部 ›</Text>
                </Pressable>
              )}
            </View>
          )}
          {busy && <Text style={{ color: '#8a93a5', fontSize: 12 }}>加载中…</Text>}
        </View>
      </ScrollView>
    </View>
  );
}

/** 账本管理:多账本切换 / 新建 / 重命名 */
