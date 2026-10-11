import { StyleSheet } from 'react-native';

export type Tab = 'record' | 'list' | 'report' | 'me';

export interface Cat {
  id: string;
  name: string;
  icon: string;
}

export function monthRange(offset: number): { start: number; end: number; label: string } {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - offset);
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  const label = `${d.getFullYear()}年${d.getMonth() + 1}月`;
  return { start, end, label };
}

export const PAGE = 50;

export const styles = StyleSheet.create({
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
