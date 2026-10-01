/** 同步客户端单测(第 29 轮):401→refresh→单次重试、错误语义、去抖合并 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, createDebouncer } from '../src/index';

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeClient(responses: Array<{ status: number; body: Record<string, unknown> }>, calls: string[] = []) {
  let i = 0;
  let currentToken = 'stale-token';
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url.replace('https://srv', '')}`);
    const r = responses[Math.min(i++, responses.length - 1)];
    return jsonResponse(r.status, r.body);
  });
  vi.stubGlobal('fetch', fetchMock);
  const refreshed: string[] = [];
  const client = createApiClient({
    getServerUrl: () => 'https://srv',
    getAccessToken: () => currentToken,
    getRefreshToken: () => 'refresh-token',
    onRefreshed: (p) => { currentToken = p.accessToken; refreshed.push(p.accessToken); },
  });
  return { client, calls, refreshed, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe('createApiClient(P1-2)', () => {
  it('携带 Bearer;401 → refresh → 原请求单次重发(带新 token)', async () => {
    const calls: string[] = [];
    const { client, refreshed, fetchMock } = makeClient(
      [
        { status: 401, body: { code: 'auth.token.401', message: '过期' } },
        { status: 200, body: { accessToken: 'NEW', refreshToken: 'R2', user: { id: 'u' } } },
        { status: 200, body: { ok: true } },
      ],
      calls,
    );
    const out = await client.apiFetch('/v1/users/me');
    expect(out).toEqual({ ok: true });
    expect(refreshed).toEqual(['NEW']);
    // 顺序:me(401) → refresh → me 重发
    expect(calls).toEqual(['GET /v1/users/me', 'POST /v1/auth/refresh', 'GET /v1/users/me']);
    const retryAuth = (fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>).Authorization;
    expect(retryAuth).toBe('Bearer NEW');
  });

  it('refresh 失败 → 401 错误原样抛出(ApiError 语义)', async () => {
    const { client } = makeClient([
      { status: 401, body: { code: 'auth.token.401' } },
      { status: 401, body: { code: 'auth.refresh.401', message: '无效' } },
    ]);
    await expect(client.apiFetch('/v1/users/me')).rejects.toMatchObject({ status: 401, code: 'auth.token.401' });
  });

  it('非 401 错误 → ApiError(code/message/status 透传)', async () => {
    const { client } = makeClient([{ status: 403, body: { code: 'x.403', message: '禁止' } }]);
    await expect(client.apiFetch('/v1/x')).rejects.toMatchObject({ status: 403, code: 'x.403', message: '禁止' });
  });
});

describe('createDebouncer(真去抖)', () => {
  it('窗口内多次 schedule 合并为一次执行;cancel 生效', async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createDebouncer(fn, 2000);
    d.schedule(); d.schedule(); d.schedule();
    vi.advanceTimersByTime(1999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    d.schedule();
    d.cancel();
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
