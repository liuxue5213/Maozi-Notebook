import type { PullResponse, PushResponse, SyncTransport } from '@ledgerone/domain';
import type { ChangeOp } from '@ledgerone/domain';
import { metaGet, metaSet } from '@ledgerone/sqlite-sync';
import * as SecureStore from 'expo-secure-store';
import { db } from './db';

const DEFAULT_SERVER = 'http://localhost:60505';

/** token 存系统安全区(F-05):不再落 SQLite meta(整库加密外的第二道防线) */
const SS_ACCESS = 'lo_access';
const SS_REFRESH = 'lo_refresh';
const SS_UID = 'lo_uid';

export async function getServerUrl(): Promise<string> {
  return ((await metaGet(db, 'server_url')) as string) || DEFAULT_SERVER;
}

export async function setServerUrl(url: string): Promise<void> {
  await metaSet(db, 'server_url', url.trim().replace(/\/+$/, ''));
}

export async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync(SS_ACCESS);
}

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(SS_REFRESH);
}

export async function saveSession(data: { accessToken: string; refreshToken: string; user: { id: string } }): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(SS_ACCESS, data.accessToken),
    SecureStore.setItemAsync(SS_REFRESH, data.refreshToken),
    SecureStore.setItemAsync(SS_UID, data.user.id),
  ]);
}

export async function clearSession(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(SS_ACCESS),
    SecureStore.deleteItemAsync(SS_REFRESH),
    SecureStore.deleteItemAsync(SS_UID),
    // 清理旧版落库的明文 token(骨架期升级残留)
    metaSet(db, 'access_token', null),
    metaSet(db, 'refresh_token', null),
    metaSet(db, 'uid', null),
  ]);
}

export async function isLoggedIn(): Promise<boolean> {
  return !!(await getAccessToken());
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
  const rt = await getRefreshToken();
  if (!rt) return false;
  try {
    const res = await fetch(`${await getServerUrl()}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    });
    if (!res.ok) return false;
    saveSession(await res.json());
    return true;
  } catch {
    return false;
  }
}

export async function apiFetch(path: string, init: RequestInit = {}, retry = true): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = await getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${await getServerUrl()}${path}`, { ...init, headers });
  if (res.status === 401 && retry && (await tryRefresh())) {
    return apiFetch(path, init, false);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(String(body.code ?? `http.${res.status}`), String(body.message ?? `请求失败(${res.status})`), res.status);
  }
  return body;
}

export const authApi = {
  login: (email: string, password: string) =>
    apiFetch('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (email: string, password: string) =>
    apiFetch('/v1/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),
};

export async function makeTransport(): Promise<SyncTransport> {
  return {
    push: async (changes: ChangeOp[]): Promise<PushResponse> =>
      (await apiFetch('/v1/sync/push', { method: 'POST', body: JSON.stringify({ changes }) })) as unknown as PushResponse,
    pull: async (cursor: number, limit?: number): Promise<PullResponse> =>
      (await apiFetch(`/v1/sync/pull?cursor=${cursor}&limit=${limit ?? 500}`)) as unknown as PullResponse,
  };
}
