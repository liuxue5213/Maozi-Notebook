/**
 * 端无关同步客户端(P1-2,第 29 轮):Web 与 App 的唯一接线实现。
 * 两端只注入「存储/地址」差异(Web=localStorage 同步取,App=SecureStore/SQLite 异步取),
 * apiFetch 的 401→refresh→单次重试、auth 端点封装、去抖器均在此一份维护 —— 修复两端口径漂移(Review 4.6)。
 */

/** TokenPair 最小面(与 domain SyncFlow 响应一致) */
export interface TokenPairLike {
  accessToken: string;
  refreshToken: string;
  user?: unknown;
}

export interface ApiClientDeps {
  /** 服务端地址(Web 同步取/App 异步取均可) */
  getServerUrl: () => string | Promise<string>;
  getAccessToken: () => string | null | Promise<string | null>;
  getRefreshToken: () => string | null | Promise<string | null>;
  /** refresh 成功后持久化新 token 对(两端各自的存储实现) */
  onRefreshed: (pair: TokenPairLike) => void | Promise<void>;
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

type FetchLike = (path: string, init?: RequestInit, retry?: boolean) => Promise<Record<string, unknown>>;

export function createApiClient(deps: ApiClientDeps) {
  const resolve = async (v: string | null | Promise<string | null>): Promise<string> => {
    const s = await v;
    return s ?? '';
  };

  async function tryRefresh(): Promise<boolean> {
    const rt = await deps.getRefreshToken();
    if (!rt) return false;
    try {
      const base = await deps.getServerUrl();
      const res = await fetch(`${base}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) return false;
      const pair = (await res.json()) as TokenPairLike;
      await deps.onRefreshed(pair);
      return true;
    } catch {
      return false;
    }
  }

  /** 单次重试语义:401 → refresh 成功则原请求重发一次;refresh 失败 → 401 原样抛出 */
  const apiFetch: FetchLike = async (path, init = {}, retry = true) => {
    const base = await deps.getServerUrl();
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) };
    const token = await resolve(deps.getAccessToken());
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${path}`, { ...init, headers });
    if (res.status === 401 && retry && (await tryRefresh())) {
      return apiFetch(path, init, false);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new ApiError(String(body.code ?? `http.${res.status}`), String(body.message ?? `请求失败(${res.status})`), res.status);
    }
    return body;
  };

  /** auth 端点封装:与 apiFetch 同源(token 注入/错误语义一致) */
  const auth = {
    login: (email: string, password: string) => apiFetch('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    register: (email: string, password: string, nickname = '') =>
      apiFetch('/v1/auth/register', { method: 'POST', body: JSON.stringify({ email, password, nickname }) }),
    logoutRemote: () => apiFetch('/v1/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined),
    me: () => apiFetch('/v1/users/me') as Promise<Record<string, unknown>>,
    updateMe: (patch: { nickname?: string; baseCurrency?: string }) =>
      apiFetch('/v1/users/me', { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<Record<string, unknown>>,
    deleteMe: (password: string) =>
      apiFetch('/v1/users/me', { method: 'DELETE', body: JSON.stringify({ password }) }) as Promise<{ deleted: true }>,
  };

  return { apiFetch, auth, ApiError };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** 同步去抖器(P0-2 对齐):窗口内的多次 schedule 合并为一次执行;cancel 显式取消 */
export function createDebouncer(fn: () => void | Promise<void>, delayMs = 2000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule(delay = delayMs): void {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void fn();
      }, delay);
    },
    cancel(): void {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
