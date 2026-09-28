import { useState } from 'react';
import { SUPPORTED_CURRENCIES, currencySymbol } from '@ledgerone/domain';
import { authApi, getBaseCurrency } from './sync/api';

/** 账号设置(M16/第 16 轮):昵称 + 主币种。主币种应用于新建交易的记账币种;存量数据不回算。 */
export function SettingsPage({ onBack }: { onBack: () => void }) {
  const [nickname, setNickname] = useState<string>(() => localStorage.getItem('lo_nickname') ?? '');
  const [currency, setCurrency] = useState<string>(() => getBaseCurrency());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const u = await authApi.updateMe({ nickname: nickname.trim(), baseCurrency: currency });
      localStorage.setItem('lo_nickname', u.nickname ?? '');
      localStorage.setItem('lo_base_currency', u.baseCurrency ?? 'CNY');
      setMsg('已保存');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="me-tab">
      <button className="link back" onClick={onBack}>‹ 返回</button>
      <div className="me-section">
        <div className="me-row static-row">
          <span>账号设置</span>
          <span className="muted">昵称与主币种,多端同步</span>
        </div>
        <div className="field">
          <label>昵称</label>
          <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={30} placeholder="怎么称呼你" />
        </div>
        <div className="field">
          <label>主币种</label>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {SUPPORTED_CURRENCIES.map((c) => (
              <option key={c} value={c}>{currencySymbol(c)} {c}</option>
            ))}
          </select>
          <div className="muted small">作为后续新记账的记账币种;已有流水不回算改币(多币种折算在 V2.0 规划内)</div>
        </div>
        {msg && <div className="muted small">{msg}</div>}
        {error && <div className="form-error">{error}</div>}
        <button className="primary" disabled={busy} onClick={() => void save()}>保存</button>
      </div>
    </div>
  );
}
