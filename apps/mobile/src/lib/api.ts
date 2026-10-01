import type { PullResponse, PushResponse, SyncTransport } from '@ledgerone/domain';
import type { ChangeOp } from '@ledgerone/domain';
import { createApiClient, type TokenPairLike } from '@ledgerone/sync-client';
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
  // P1-10(Review):协议白名单 + origin 归一(与 Web 对齐)
  let u = url.trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    await metaSet(db, 'server_url', parsed.origin);
  } catch {
    return;
  }
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

// ---- 共享客户端(P1-2):apiFetch/401 刷新/auth 端点唯一实现 ----
const client = createApiClient({
  getServerUrl,
  getAccessToken,
  getRefreshToken,
  onRefreshed: (pair) => saveSession(pair as Parameters<typeof saveSession>[0]),
});

export const { ApiError, apiFetch, auth } = client;
export async function logout(): Promise<void> {
  await auth.logoutRemote(); // 服务端吊销全部会话(F-08)
  await clearSession();
}

export const authApi = {
  login: (email: string, password: string) => auth.login(email, password),
  register: (email: string, password: string) => auth.register(email, password),
  logoutRemote: auth.logoutRemote,
  me: auth.me as () => Promise<Record<string, unknown>>,
};

export async function isLoggedIn(): Promise<boolean> {
  return !!(await getAccessToken());
}

export async function makeTransport(): Promise<SyncTransport> {
  return {
    push: async (changes: ChangeOp[]): Promise<PushResponse> =>
      (await apiFetch('/v1/sync/push', { method: 'POST', body: JSON.stringify({ changes }) })) as unknown as PushResponse,
    pull: async (cursor: number, limit?: number): Promise<PullResponse> =>
      (await apiFetch(`/v1/sync/pull?cursor=${cursor}&limit=${limit ?? 500}`)) as unknown as PullResponse,
  };
}
