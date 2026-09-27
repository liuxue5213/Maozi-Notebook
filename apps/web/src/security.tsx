import { useEffect, useState, type ReactNode } from 'react';
import { db } from './db/db';

const LOCK_KEY = 'lo_lock';
const STAT_KEY = 'lo_stat_optin';
const CRASH_KEY = 'lo_crash_optin';

/** PBKDF2 参数(上线全检 F-04:替换单轮无盐 SHA-256) */
const PBKDF2_ITERATIONS = 150_000;
const LOCK_MAX_ATTEMPTS = 5;
const LOCK_BACKOFF_MS = 60_000;

interface LockConfig {
  /** 格式版本:v2 = PBKDF2-SHA256 + 随机盐;缺省 = 旧版单轮 SHA-256(成功验证后自动升级) */
  v?: 2;
  salt?: string;
  hash: string;
  enabled: boolean;
  /** 连续失败次数(达到 5 次触发退避) */
  fails?: number;
  /** 退避截止时间戳 */
  lockUntil?: number;
}

function bytesToHex(buf: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return bytesToHex(d);
}

async function derivePinHash(pin: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return bytesToHex(bits);
}

function newSalt(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

export function getLockConfig(): LockConfig | null {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    return raw ? (JSON.parse(raw) as LockConfig) : null;
  } catch {
    return null;
  }
}

function saveLockConfig(cfg: LockConfig): void {
  localStorage.setItem(LOCK_KEY, JSON.stringify(cfg));
}

function isLockEnabled(): boolean {
  return getLockConfig()?.enabled === true;
}

/** 锁定状态判定:失败 5 次后退避 60 秒 */
function backoffRemaining(cfg: LockConfig | null): number {
  if (!cfg || !cfg.lockUntil) return 0;
  return Math.max(0, cfg.lockUntil - Date.now());
}

async function verifyPin(pin: string, cfg: LockConfig): Promise<boolean> {
  if (cfg.v === 2 && cfg.salt) return (await derivePinHash(pin, cfg.salt)) === cfg.hash;
  // 旧版(单轮 SHA-256 无盐):验证成功后自动升级到 v2
  if ((await sha256Hex(pin)) === cfg.hash) return true;
  return false;
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
  const [cfg, setCfg] = useState<LockConfig | null>(() => getLockConfig());

  const lockedOut = backoffRemaining(cfg) > 0;

  const submit = async () => {
    const config = getLockConfig();
    if (!config) return onUnlock();
    const wait = backoffRemaining(config);
    if (wait > 0) {
      setError(`失败次数过多,请 ${Math.ceil(wait / 1000)} 秒后再试`);
      setPin('');
      return;
    }
    if (await verifyPin(pin, config)) {
      // 旧格式(无盐单轮哈希)成功验证 → 自动升级 v2(PBKDF2 + 随机盐)
      if (config.v !== 2 || !config.salt) {
        const salt = newSalt();
        const upgraded: LockConfig = { v: 2, salt, hash: await derivePinHash(pin, salt), enabled: true, fails: 0, lockUntil: undefined };
        saveLockConfig(upgraded);
      }
      const reset: LockConfig = { ...getLockConfig()!, fails: 0, lockUntil: undefined };
      saveLockConfig(reset);
      setPin('');
      onUnlock();
    } else {
      const fails = (config.fails ?? 0) + 1;
      const next: LockConfig = { ...config, fails, lockUntil: fails >= LOCK_MAX_ATTEMPTS ? Date.now() + LOCK_BACKOFF_MS : undefined };
      saveLockConfig(next);
      setCfg(next);
      setError(next.lockUntil ? '失败次数过多,锁定 60 秒' : 'PIN 不正确');
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
        <button className="primary" disabled={pin.length < 4 || lockedOut} onClick={() => void submit()}>解锁</button>
        <button className="link small" onClick={() => void forgot()}>忘记 PIN?</button>
      </div>
    </div>
  );
}

function PinSetupModal({ onDone, onClose }: { onDone: (hash: string, salt: string) => void; onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ok = /^\d{4,6}$/.test(pin) && pin === confirm;

  const submit = async () => {
    if (!/^\d{4,6}$/.test(pin)) return setError('PIN 需为 4–6 位数字');
    if (pin !== confirm) return setError('两次输入不一致');
    const salt = newSalt();
    onDone(await derivePinHash(pin, salt), salt);
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
            if (cfg && (await verifyPin(pin, cfg))) onVerified();
            else setError('PIN 不正确');
          }}
        >
          确认
        </button>
      </div>
    </div>
  );
}

/** 安全与隐私:PIN 应用锁 + 隐私开关面板 */
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
            <span className="muted small">Web 端为 PIN 锁(PBKDF2 加盐存储);手势/生物识别在 App 端提供</span>
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
          <span>隐私开关面板</span>
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
          onDone={async (hash, salt) => {
            const next: LockConfig = { v: 2, salt, hash, enabled: true };
            saveLockConfig(next);
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
