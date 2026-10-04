import type { PullResponse, PushResponse, SyncTransport } from '@ledgerone/domain';
import type { ChangeOp } from '@ledgerone/domain';
import { createApiClient, type TokenPairLike } from '@ledgerone/sync-client';
import { metaGet, metaSet } from '@ledgerone/sqlite-sync';
import * as SecureStore from 'expo-secure-store';
import { db } from './db';

// 默认走公网 frp 隧道:室内外都能用;局域网更快,在「我的」页一键切换
export const DEFAULT_SERVER = 'http://43.138.212.106:55505';

/** 后端预设:一键切换(公网 frp / 局域网树莓派) */
export const SERVER_PRESETS: Array<{ label: string; url: string }> = [
  { label: '公网 (frp)', url: 'http://43.138.212.106:55505' },
  { label: '局域网 (树莓派)', url: 'http://192.168.1.16:60505' },
];

/** 健康探测:2.5s 超时,只看 /healthz 是否 200 */
async function probeServer(url: string, ms = 2500): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${url}/healthz`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let lastGoodServer: string | null = null;

/**
 * 故障转移链(用户契约):自定义地址 → 公网 frp → 局域网 → 全不可达时返回当前设置(离线模式)。
 * 上次探测成功的地址优先快探(1.5s),避免每次都串等两个超时。
 */
export async function resolveServerUrl(preferred?: string): Promise<string> {
  const stored = ((await metaGet(db, 'server_url')) as string) || '';
  const candidates = [preferred || stored, stored, DEFAULT_SERVER, ...SERVER_PRESETS.map((p) => p.url)]
    .filter((v, i, a): v is string => !!v && a.indexOf(v) === i);
  if (lastGoodServer && candidates.includes(lastGoodServer) && (await probeServer(lastGoodServer, 1500))) {
    return lastGoodServer;
  }
  for (const url of candidates) {
    if (await probeServer(url)) {
      lastGoodServer = url;
      console.log(`[server] 故障转移解析 → ${url}`);
      return url;
    }
    console.log(`[server] 不可达: ${url}`);
  }
  return stored || DEFAULT_SERVER; // 全断:保持原设置,交由同步引擎进入离线态
}

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
  getServerUrl: resolveServerUrl,
  getAccessToken,
  getRefreshToken,
  onRefreshed: (pair) => saveSession(pair as Parameters<typeof saveSession>[0]),
});

export const { ApiError, apiFetch, auth } = client;
export async function logout(): Promise<void> {
  await auth.logoutRemote(); // 服务端吊销全部会话(F-08)
  await clearSession();
}

export const aiInsights = (body: Record<string, unknown>) =>
  apiFetch('/v1/ai/insights', { method: 'POST', body: JSON.stringify(body) }) as unknown as Promise<{ text: string }>;

export const authApi = {
  login: (email: string, password: string) => auth.login(email, password),
  register: (email: string, password: string) => auth.register(email, password),
  logoutRemote: auth.logoutRemote,
  me: auth.me as () => Promise<Record<string, unknown>>,
  updateMe: (body: { nickname?: string; base_currency?: string }) =>
    apiFetch('/v1/users/me', { method: 'PATCH', body: JSON.stringify(body) }) as unknown as Promise<Record<string, unknown>>,

  deleteMe: async (password: string) => {
    await apiFetch('/v1/users/me', { method: 'DELETE', body: JSON.stringify({ password }) });
  },
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
