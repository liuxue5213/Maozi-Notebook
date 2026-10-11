import { ApiError as ClientApiError, createApiClient, createDebouncer } from '@ledgerone/sync-client';

const SERVER_KEY = 'lo_server';
const ACCESS_KEY = 'lo_access';
const REFRESH_KEY = 'lo_refresh';
const UID_KEY = 'lo_uid';

export { defaultServerUrl };

export interface SessionUser {
  id: string;
  email: string | null;
  phone: string | null;
  nickname: string;
  baseCurrency?: string;
}

function defaultServerUrl(): string {
  const { protocol, hostname } = window.location;
  // 开发环境前端 60500 / 后端 60505 分端口;生产同域部署时直接用当前域名
  if (import.meta.env.DEV) {
    return `${protocol}//${hostname}:60505`;
  }
  return window.location.origin;
}

export function getServerBase(): string {
  const stored = localStorage.getItem(SERVER_KEY);
  // 旧默认端口 3000 的存留值视为未配置,自动切到新默认
  if (!stored || stored === 'http://localhost:3000') return defaultServerUrl();
  return stored;
}

export function setServerBase(v: string): void {
  // P1-10(Review):仅允许 http(s) 绝对地址 —— 修复前可填任意串(如 javascript:/相对路径)
  // 并把 Bearer token 发往不可控目标;协议白名单是最小防线(完整域名白名单需产品级配置)
  let url = v.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
    localStorage.setItem(SERVER_KEY, parsed.origin);
  } catch {
    return; // 非法输入静默丢弃,保留原值
  }
}

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_KEY);
}
export function isLoggedIn(): boolean {
  return !!getAccessToken();
}
export function getUserId(): string | null {
  return localStorage.getItem(UID_KEY);
}

export interface TokenPairLike {
  accessToken: string;
  refreshToken: string;
  user?: { id: string; nickname?: string; baseCurrency?: string };
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

export interface SessionUser {
  id: string;
  email: string | null;
  phone: string | null;
  nickname: string;
  baseCurrency?: string;
}

// ---- 共享客户端(P1-2):apiFetch/401 刷新/auth 端点唯一实现 ----
const client = createApiClient({
  getServerUrl: getServerBase,
  getAccessToken,
  getRefreshToken: () => localStorage.getItem(REFRESH_KEY),
  onRefreshed: (pair: { accessToken: string; refreshToken: string; user?: unknown }) => saveTokens(pair as Parameters<typeof saveTokens>[0]),
});

/** 同步去抖器(P0-2 对齐):窗口内多次 schedule 合并为一次 syncOnce */
export const syncDebouncer = createDebouncer(() => {
  void import('./wiring').then((m) => void m.engine.syncOnce());
}, 2000);

export class ApiError extends ClientApiError {}

export const apiFetch = client.apiFetch as (
  path: string,
  init?: RequestInit,
  retry?: boolean,
) => Promise<Record<string, unknown>>;

/** SyncEngine transport(P0-3/P0-4 全量过滤与批推的传输层,复用共享 apiFetch) */
export function makeTransport(): { push: (changes: unknown[]) => Promise<unknown>; pull: (cursor: number, limit?: number) => Promise<unknown> } {
  return {
    push: (changes: unknown[]): Promise<unknown> =>
      apiFetch('/v1/sync/push', { method: 'POST', body: JSON.stringify({ changes }) }),
    pull: (cursor: number, limit?: number): Promise<unknown> =>
      apiFetch(`/v1/sync/pull?cursor=${cursor}&limit=${limit ?? 500}`),
  };
}

export const authApi = {
  login: (email: string, password: string) => client.auth.login(email, password),
  register: (email: string, password: string, nickname = '') => client.auth.register(email, password, nickname),
  logoutRemote: client.auth.logoutRemote,
  logout: client.auth.logoutRemote,
  me: client.auth.me as unknown as () => Promise<SessionUser>,
  updateMe: client.auth.updateMe as unknown as (patch: { nickname?: string; baseCurrency?: string }) => Promise<SessionUser & { baseCurrency: string }>,
  /** 注销账号(P0-6,第 28 轮) */
  deleteMe: client.auth.deleteMe as (password: string) => Promise<{ deleted: true }>,
};

function aiErrorMessage(e: unknown, feature: string): Error {
  if (e instanceof ApiError) {
    if (e.status === 401) return new Error(`${feature}需登录后使用`);
    if (e.status === 429) return new Error('今日 AI 次数已达上限,明天再来吧');
    return new Error(e.message);
  }
  return e instanceof Error ? e : new Error(String(e));
}

/** AI 消费洞察(百炼 qwen-plus,服务端代理;走共享 apiFetch 获得 401 自动刷新) */
export async function aiInsights(body: {
  month: string; income: string; expense: string; budget?: string | null;
  topCategories: Array<{ name: string; amount: string }>;
  recentTxs: Array<{ note: string; amount: string; date: string }>;
  question?: string;
}): Promise<{ text: string }> {
  if (!isAiEnabled()) throw new Error('已在「安全与隐私」中关闭 AI 分析,如需使用请重新开启');
  try {
    return await apiFetch('/v1/ai/insights', { method: 'POST', body: JSON.stringify(body) }) as unknown as { text: string };
  } catch (e) {
    throw aiErrorMessage(e, 'AI 分析');
  }
}

/** AI 文字记账解析(T-41:与移动端同交互——预填后由用户确认保存;走共享 apiFetch 获得 401 自动刷新) */
export async function aiParse(text: string, categories: string[]): Promise<{
  amount: number; type: 'expense' | 'income'; category: string | null; note: string; day: number | null;
}> {
  if (!isAiEnabled()) throw new Error('已在「安全与隐私」中关闭 AI 分析,如需使用请重新开启');
  try {
    return await apiFetch('/v1/ai/parse', { method: 'POST', body: JSON.stringify({ text, categories }) }) as unknown as {
      amount: number; type: 'expense' | 'income'; category: string | null; note: string; day: number | null;
    };
  } catch (e) {
    throw aiErrorMessage(e, '文字记账');
  }
}

/** Q5 AI 授权开关(默认开):关闭后所有 AI 功能在端上拒绝发起,不出域任何数据 */
const AI_OPTIN_KEY = 'lo_ai_optin';
export function isAiEnabled(): boolean {
  return localStorage.getItem(AI_OPTIN_KEY) !== '0';
}
export function setAiEnabled(on: boolean): void {
  if (on) localStorage.removeItem(AI_OPTIN_KEY);
  else localStorage.setItem(AI_OPTIN_KEY, '0');
}

/** AI 对话式查询(N5「问一问」):端上拼好本期数据上下文+用户问题,走 /v1/ai/chat(用户级配额/审计复用) */
export async function aiChat(content: string): Promise<{ text: string }> {
  try {
    return await apiFetch('/v1/ai/chat', { method: 'POST', body: JSON.stringify({ content: content.slice(0, 2000) }) }) as unknown as { text: string };
  } catch (e) {
    throw aiErrorMessage(e, 'AI 问答');
  }
}
