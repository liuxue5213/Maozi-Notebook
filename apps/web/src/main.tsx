import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { LockGate } from './security';
import { ErrorBoundary } from './ErrorBoundary';
import { ensureLocalSeed } from './db/seed';
import { seedDemoData } from './db/demo';
import { engine, enqueue } from './sync/wiring';
import { runDueRecurring } from './recurring-engine';
import { startAutoSync } from '@ledgerone/sync';
import { applyTheme, getThemeMode } from './theme';
import { db } from './db/db';
import './styles.css';

applyTheme((localStorage.getItem('lo_theme') as 'light' | 'dark' | 'system' | null) ?? 'system');

void ensureLocalSeed()
  .then(() => runDueRecurring()) // 周期记账到期补生成(M01-F06)
  .finally(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <LockGate>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </LockGate>
      </React.StrictMode>,
    );
    // 定时兜底同步:每 5 分钟 + 网络恢复时立即触发(登录状态下生效)
    startAutoSync(engine, { isOnline: () => navigator.onLine && !!localStorage.getItem('lo_access') });
    window.addEventListener('online', () => {
      if (localStorage.getItem('lo_access')) void engine.syncOnce();
    });
  });

// 开发调试钩子:控制台可用 window.__ledgerone.seedDemoData() 造演示数据
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__ledgerone = { db, engine, enqueue, seedDemoData };
}
