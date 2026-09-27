export type ThemeMode = 'light' | 'dark' | 'system';

const KEY = 'lo_theme';

export function getThemeMode(): ThemeMode {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(mode: ThemeMode): void {
  localStorage.setItem(KEY, mode);
  const dark = mode === 'dark' || (mode === 'system' && systemPrefersDark());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function cycleTheme(): ThemeMode {
  const order: ThemeMode[] = ['light', 'dark', 'system'];
  const next = order[(order.indexOf(getThemeMode()) + 1) % order.length];
  applyTheme(next);
  return next;
}

// 跟随系统时,系统切换实时生效
if (typeof window.matchMedia === 'function') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getThemeMode() === 'system') applyTheme('system');
  });
}
