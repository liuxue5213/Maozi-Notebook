import { useEffect, useState, type ReactNode } from 'react';
import { db } from './db/db';

const LOCK_KEY = 'lo_lock';
const STAT_KEY = 'lo_stat_optin';
const CRASH_KEY = 'lo_crash_optin';

interface LockConfig {
  hash: string;
  enabled: boolean;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ledgerone:${s}`));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function getLockConfig(): LockConfig | null {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    return raw ? (JSON.parse(raw) as LockConfig) : null;
  } catch {
    return null;
  }
}

function isLockEnabled(): boolean {
  return getLockConfig()?.enabled === true;
}

/** 应用锁门卫(M16-F01,Web 形态):冷启动与切后台返回时要求输入 PIN;生物识别为 App 端能力 */
export function LockGate({ children }: { children: ReactNode }) {
  const [locked, setLocked] = useState(() => isLockEnabled());

  useEffect(() => {
    const onVis = () => {
      if (document.hidden && isLockEnabled()) setLocked(true);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  if (!locked) return <>{children}</>;
  return <LockOverlay onUnlock={() => setLocked(false)} />;
}

function LockOverlay({ onUnlock }: { onUnlock: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const cfg = getLockConfig();
    if (!cfg) return onUnlock();
    if ((await sha256Hex(pin)) === cfg.hash) {
      setPin('');
      onUnlock();
    } else {
      setError('PIN 不正确');
      setPin('');
    }
  };

  const forgot = async () => {
    if (!window.confirm('忘记 PIN 将清空本机数据并退出登录(云端数据不受影响,重新登录后全量拉回)。继续?')) return;
    localStorage.clear();
    await db.delete();
    location.reload();
  };

  return (
    <div className="lock-mask">
      <div className="lock-card">
        <div className="lock-icon">🔒</div>
        <div className="lock-title">随手账已锁定</div>
        <input
          className="lock-input"
          type="password"
          inputMode="numeric"
          maxLength={6}
          value={pin}
          placeholder="输入 PIN 解锁"
          autoFocus
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, ''));
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && pin.length >= 4) void submit();
          }}
        />
        {error && <div className="form-error">{error}</div>}
        <button className="primary" disabled={pin.length < 4} onClick={() => void submit()}>解锁</button>
        <button className="link small" onClick={() => void forgot()}>忘记 PIN?</button>
      </div>
    </div>
  );
}

function PinSetupModal({ onDone, onClose }: { onDone: (hash: string) => void; onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ok = /^\d{4,6}$/.test(pin) && pin === confirm;

  const submit = async () => {
    if (!/^\d{4,6}$/.test(pin)) return setError('PIN 需为 4–6 位数字');
    if (pin !== confirm) return setError('两次输入不一致');
    onDone(await sha256Hex(pin));
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>设置应用锁 PIN(4–6 位)</h3>
        <div className="field">
          <label>PIN</label>
          <input type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setError(null); }} />
        </div>
        <div className="field">
          <label>确认 PIN</label>
          <input type="password" inputMode="numeric" maxLength={6} value={confirm} onChange={(e) => { setConfirm(e.target.value.replace(/\D/g, '')); setError(null); }} />
        </div>
        {error && <div className="form-error">{error}</div>}
        <button className="primary" disabled={!ok} onClick={() => void submit()}>开启应用锁</button>
      </div>
    </div>
  );
}

function PinVerifyModal({ onVerified, onClose }: { onVerified: () => void; onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>输入 PIN 确认</h3>
        <div className="field">
          <input type="password" inputMode="numeric" maxLength={6} value={pin} autoFocus onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setError(null); }} />
        </div>
        {error && <div className="form-error">{error}</div>}
        <button
          className="primary"
          disabled={pin.length < 4}
          onClick={async () => {
            const cfg = getLockConfig();
            if (cfg && (await sha256Hex(pin)) === cfg.hash) onVerified();
            else setError('PIN 不正确');
          }}
        >
          确认
        </button>
      </div>
    </div>
  );
}

/** 安全与隐私(M16-F01/F03,Web 形态):PIN 应用锁 + 隐私开关面板 */
export function SecurityPanel({ onBack }: { onBack: () => void }) {
  const [cfg, setCfg] = useState<LockConfig | null>(() => getLockConfig());
  const [mode, setMode] = useState<'none' | 'setup' | 'verify-off'>('none');
  const [stat, setStat] = useState(() => localStorage.getItem(STAT_KEY) === '1');
  const [crash, setCrash] = useState(() => localStorage.getItem(CRASH_KEY) === '1');

  return (
    <div className="me-tab">
      <button className="link back" onClick={onBack}>‹ 返回</button>

      <div className="me-section">
        <div className="me-row static-row">
          <span>应用锁</span>
          <span className="muted">{cfg?.enabled ? '已开启 · 冷启动/切后台校验' : '未开启'}</span>
        </div>
        {!cfg?.enabled && (
          <div className="me-row">
            <span className="muted small">Web 端为 PIN 锁;手势/生物识别在 App 端提供</span>
            <button className="mini" onClick={() => setMode('setup')}>开启</button>
          </div>
        )}
        {cfg?.enabled && (
          <div className="me-row">
            <span className="muted small">关闭前需验证 PIN</span>
            <button className="mini" onClick={() => setMode('verify-off')}>关闭应用锁</button>
          </div>
        )}
      </div>

      <div className="me-section">
        <div className="me-row static-row">
          <span>隐私开关</span>
        </div>
        <div className="me-row static-row">
          <div>
            <div>云同步</div>
            <div className="muted small">Web 端始终开启(不支持纯本地模式);App 端可关闭</div>
          </div>
          <span className="muted">始终开启</span>
        </div>
        <label className="me-row check-row">
          <input
            type="checkbox"
            checked={stat}
            onChange={(e) => {
              setStat(e.target.checked);
              if (e.target.checked) localStorage.setItem(STAT_KEY, '1');
              else localStorage.removeItem(STAT_KEY);
            }}
          />
          <span>
            行为统计(匿名事件)
            <span className="muted small" style={{ display: 'block' }}>未接入采集 SDK;接入后默认开启,不含金额与备注</span>
          </span>
        </label>
        <label className="me-row check-row">
          <input
            type="checkbox"
            checked={crash}
            onChange={(e) => {
              setCrash(e.target.checked);
              if (e.target.checked) localStorage.setItem(CRASH_KEY, '1');
              else localStorage.removeItem(CRASH_KEY);
            }}
          />
          <span>
            崩溃上报(匿名)
            <span className="muted small" style={{ display: 'block' }}>未接入采集 SDK;接入后默认开启,不上报流水内容</span>
          </span>
        </label>
        <div className="me-row static-row">
          <div className="muted small">权限最小化:Web 端仅使用浏览器存储,不申请相机/麦克风/通讯录/位置权限</div>
        </div>
      </div>

      {mode === 'setup' && (
        <PinSetupModal
          onClose={() => setMode('none')}
          onDone={async (hash) => {
            const next: LockConfig = { hash, enabled: true };
            localStorage.setItem(LOCK_KEY, JSON.stringify(next));
            setCfg(next);
            setMode('none');
          }}
        />
      )}
      {mode === 'verify-off' && (
        <PinVerifyModal
          onClose={() => setMode('none')}
          onVerified={() => {
            localStorage.removeItem(LOCK_KEY);
            setCfg(null);
            setMode('none');
          }}
        />
      )}
    </div>
  );
}
