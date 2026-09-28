import type { ChangeOp, PullResponse, PushResponse, SyncTransport } from '@ledgerone/domain';

const SERVER_KEY = 'lo_server';
const ACCESS_KEY = 'lo_access';
const REFRESH_KEY = 'lo_refresh';
const UID_KEY = 'lo_uid';

export function defaultServerUrl(): string {
  const { protocol, hostname, origin } = window.location;
  // 开发环境前端 60500 / 后端 60505 分端口;生产同域部署时直接用当前域名
  if (import.meta.env.DEV) {
    return `${protocol}//${hostname}:60505`;
  }
  return origin;
}

export function getServerBase(): string {
  const stored = localStorage.getItem(SERVER_KEY);
  // 旧默认端口 3000 的存留值视为未配置,自动切到新默认
  if (!stored || stored === 'http://localhost:3000') return defaultServerUrl();
  return stored;
}
export function setServerBase(v: string): void {
  localStorage.setItem(SERVER_KEY, v.trim().replace(/\/+$/, ''));
}
export const getAccessToken = (): string | null => localStorage.getItem(ACCESS_KEY);
export const isLoggedIn = (): boolean => !!getAccessToken();
export const getUserId = (): string | null => localStorage.getItem(UID_KEY);

export interface SessionUser {
  id: string;
  email: string | null;
  phone: string | null;
  nickname: string;
  baseCurrency?: string;
}

export function saveTokens(data: { accessToken: string; refreshToken: string; user: { id: string; nickname?: string; baseCurrency?: string } }): void {
  localStorage.setItem(ACCESS_KEY, data.accessToken);
  localStorage.setItem(REFRESH_KEY, data.refreshToken);
  localStorage.setItem(UID_KEY, data.user.id);
  // 用户偏好缓存(第 16 轮主币种):登录/注册/刷新响应均带 publicUser,顺手落地供非 React 模块读取
  if (data.user.baseCurrency) localStorage.setItem('lo_base_currency', data.user.baseCurrency);
  if (data.user.nickname !== undefined) localStorage.setItem('lo_nickname', data.user.nickname);
}

/** 主币种(M16/账号设置):新建交易的记账币种来源;localStorage 由 saveTokens/设置页维护 */
export function getBaseCurrency(): string {
  return localStorage.getItem('lo_base_currency') ?? 'CNY';
}
export function clearTokens(): void {
  [ACCESS_KEY, REFRESH_KEY, UID_KEY].forEach((k) => localStorage.removeItem(k));
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function tryRefresh(): Promise<boolean> {
  const rt = localStorage.getItem(REFRESH_KEY);
  if (!rt) return false;
  try {
    const res = await fetch(`${getServerBase()}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    });
    if (!res.ok) return false;
    saveTokens(await res.json());
    return true;
  } catch {
    return false;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function apiFetch(path: string, init: RequestInit = {}, retry = true): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${getServerBase()}${path}`, { ...init, headers });
  if (res.status === 401 && retry && (await tryRefresh())) {
    return apiFetch(path, init, false);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(body.code ?? `http.${res.status}`, body.message ?? `请求失败(${res.status})`, res.status);
  }
  return body;
}

export const authApi = {
  register: (email: string, password: string, nickname: string) =>
    apiFetch('/v1/auth/register', { method: 'POST', body: JSON.stringify({ email, password, nickname }) }),
  logout: () => apiFetch('/v1/auth/logout', { method: 'POST', body: '{}' }),
  login: (email: string, password: string) =>
    apiFetch('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => apiFetch('/v1/users/me') as Promise<SessionUser>,
  /** 账号设置(第 16 轮):昵称/主币种;响应为更新后的 publicUser */
  updateMe: (patch: { nickname?: string; baseCurrency?: string }) =>
    apiFetch('/v1/users/me', { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<SessionUser & { baseCurrency: string }>,
};

export function makeTransport(): SyncTransport {
  return {
    push: async (changes: ChangeOp[]): Promise<PushResponse> =>
      apiFetch('/v1/sync/push', { method: 'POST', body: JSON.stringify({ changes }) }),
    pull: async (cursor: number, limit?: number): Promise<PullResponse> =>
      apiFetch(`/v1/sync/pull?cursor=${cursor}&limit=${limit ?? 500}`),
  };
}
