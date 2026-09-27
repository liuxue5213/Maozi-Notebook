import { useEffect, useState } from 'react';
import { useSyncExternalStore } from 'react';
import { authApi, clearTokens, defaultServerUrl, getServerBase, getUserId, isLoggedIn, saveTokens, setServerBase } from './sync/api';
import { engine, prepareAfterLogin } from './sync/wiring';
import { AccountsPage } from './accounts';
import { ExportPage } from './export';
import { SecurityPanel } from './security';
import { PendingPage } from './pending';
import { RecurringPage } from './recurring';
import { applyTheme, cycleTheme, getThemeMode, type ThemeMode } from './theme';
import { db } from './db/db';

export function AuthModal({ onClose, onAuthed }: { onClose: () => void; onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [server, setServer] = useState<string | null>(null); // null = 未修改,自动使用默认服务器
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (server !== null) setServerBase(server);
      const data =
        mode === 'login'
          ? await authApi.login(email, password)
          : await authApi.register(email, password, nickname);
      saveTokens(data);
      await prepareAfterLogin();
      onAuthed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{mode === 'login' ? '登录' : '注册'} · 多端同步</h3>
        <div className="field">
          <label>邮箱</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </div>
        <div className="field">
          <label>密码</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 8 位" />
        </div>
        {mode === 'register' && (
          <div className="field">
            <label>昵称(可选)</label>
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="怎么称呼你" />
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        <button className="primary" disabled={busy || !email || !password} onClick={() => void submit()}>
          {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录'}
        </button>
        <button className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? '没有账号?注册一个' : '已有账号?直接登录'}
        </button>
        <button className="link small" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? '收起服务器设置 ▴' : '服务器设置 ▾'}
        </button>
        {advanced && (
          <div className="field">
            <label>服务器地址(默认自动)</label>
            <input value={server ?? (getServerBase() || defaultServerUrl())} onChange={(e) => setServer(e.target.value)} placeholder={defaultServerUrl()} />
          </div>
        )}
        <p className="muted small">未登录也可完整记账,数据保存在本机;登录后开启多端同步。</p>
      </div>
    </div>
  );
}

export function MeTab({ onOpenAuth, onAuthChanged }: { onOpenAuth: () => void; onAuthChanged: () => void }) {
  const sync = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const [email, setEmail] = useState<string | null>(null);
  const [view, setView] = useState<'menu' | 'accounts' | 'export' | 'security' | 'pending' | 'recurring'>('menu');
  const [pendingCount, setPendingCount] = useState(0);
  const [theme, setTheme] = useState<ThemeMode>(() => getThemeMode());

  const switchTheme = () => {
    const next = cycleTheme();
    setTheme(next);
  };

  const THEME_LABELS: Record<ThemeMode, string> = { light: '☀️ 浅色', dark: '🌙 深色', system: '💻 跟随系统' };

  useEffect(() => {
    void db.pending_transactions
      .where('status')
      .equals('pending')
      .count()
      .then((n) => setPendingCount(n));
  }, [view]);

  useEffect(() => {
    if (!isLoggedIn()) return;
    authApi
      .me()
      .then((u) => setEmail(u.email))
      .catch(() => setEmail(null));
  }, []);

  const logout = async () => {
    try {
      await authApi.logout(); // 服务端吊销全部 refresh token(全端下线,F-08)
    } catch {
      // 服务端不可达也照常清理本地
    }
    clearTokens();
    onAuthChanged();
  };

  if (view === 'accounts') return <AccountsPage onBack={() => setView('menu')} />;
  if (view === 'export') return <ExportPage onBack={() => setView('menu')} />;
  if (view === 'security') return <SecurityPanel onBack={() => setView('menu')} />;
  if (view === 'pending') return <PendingPage onBack={() => setView('menu')} />;
  if (view === 'recurring') return <RecurringPage onBack={() => setView('menu')} />;

  return (
    <div className="me-tab">
      {isLoggedIn() ? (
        <>
          <div className="me-card">
            <div className="me-avatar">{(email ?? '👤').slice(0, 1).toUpperCase()}</div>
            <div>
              <div className="me-name">{email ?? getUserId()}</div>
              <div className="muted">已登录 · 云同步已开启</div>
            </div>
          </div>
          <div className="me-section">
            <button className="me-row link-row" onClick={() => setView('pending')}>
              <span>待确认池 📥</span>
              <span className="muted">{pendingCount > 0 ? `${pendingCount} 条待确认 ›` : '导入账单 ›'}</span>
            </button>
            <button className="me-row link-row" onClick={() => setView('recurring')}>
              <span>周期记账 🔁</span>
              <span className="muted">房租工资自动记 ›</span>
            </button>
            <button className="me-row link-row" onClick={switchTheme}>
              <span>外观</span>
              <span className="muted">{THEME_LABELS[theme]} ›</span>
            </button>
            <button className="me-row link-row" onClick={() => setView('accounts')}>
              <span>账户与资产</span>
              <span className="muted">余额 · 净值 ›</span>
            </button>
            <button className="me-row link-row" onClick={() => setView('export')}>
              <span>导出与备份</span>
              <span className="muted">CSV · 免费 ›</span>
            </button>
            <button className="me-row link-row" onClick={() => setView('security')}>
              <span>安全与隐私</span>
              <span className="muted">应用锁 · 隐私开关 ›</span>
            </button>
            <div className="me-row">
              <span>同步状态</span>
              <span className="muted">
                {sync.state === 'syncing' ? '同步中…' : sync.state === 'error' ? `失败:${sync.lastError ?? ''}` : '正常'}
                {sync.pending > 0 ? ` · 待同步 ${sync.pending} 条` : ''}
              </span>
            </div>
            <div className="me-row">
              <span>上次同步</span>
              <span className="muted">{sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleTimeString('zh-CN') : '—'}</span>
            </div>
            <div className="me-row">
              <span>手动同步</span>
              <button className="mini" onClick={() => void engine.syncOnce()}>立即同步</button>
            </div>
          </div>
          <button className="danger" onClick={logout}>退出登录(本地数据保留)</button>
        </>
      ) : (
        <>
          <div className="me-card">
            <div className="me-avatar">👤</div>
            <div>
              <div className="me-name">未登录</div>
              <div className="muted">当前为纯本地模式,数据仅存于本机</div>
            </div>
          </div>
          <div className="me-section">
            <button className="me-row link-row" onClick={() => setView('pending')}>
              <span>待确认池 📥</span>
              <span className="muted">{pendingCount > 0 ? `${pendingCount} 条待确认 ›` : '导入账单 ›'}</span>
            </button>
            <button className="me-row link-row" onClick={() => setView('recurring')}>
              <span>周期记账 🔁</span>
              <span className="muted">房租工资自动记 ›</span>
            </button>
            <button className="me-row link-row" onClick={switchTheme}>
              <span>外观</span>
              <span className="muted">{THEME_LABELS[theme]} ›</span>
            </button>
            <button className="me-row link-row" onClick={() => setView('accounts')}>
              <span>账户与资产</span>
              <span className="muted">余额 · 净值 ›</span>
            </button>
            <button className="me-row link-row" onClick={() => setView('export')}>
              <span>导出与备份</span>
              <span className="muted">CSV · 免费 ›</span>
            </button>
            <button className="me-row link-row" onClick={() => setView('security')}>
              <span>安全与隐私</span>
              <span className="muted">应用锁 · 隐私开关 ›</span>
            </button>
          </div>
          <button className="primary" onClick={onOpenAuth}>登录 / 注册</button>
        </>
      )}
    </div>
  );
}
