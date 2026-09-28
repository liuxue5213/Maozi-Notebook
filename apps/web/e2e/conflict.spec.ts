/**
 * 双端并发编辑旅程(全检第 12/13 轮,PRD 5.5 / B4 字段级合并的浏览器级验证):
 * 设备 A 记账并同步 → A 离线改金额 → 设备 B(同账号)在线改备注(协议级写入:
 * B 登录后自带本地播种账本且无账本切换 UI,看不到 A 账本流水,故 B 用同权限的 sync/push 直改)
 * → A 恢复在线。
 *
 * 三方合并(第 13 轮)下的期望结果:两端改的是**不同字段**(A 金额、B 备注)→ 无冲突,
 * 干净合并为一行(金额 66 + 备注 B 的修改)——第 12 轮 LWW 时代的「冲突副本 + 备注被覆盖」
 * 两者都不再发生。关键字段双方都改的冲突副本路径由服务端集成测试(B4/三方合并场景)守护。
 */
import { expect, test, type Page } from '@playwright/test';

const API = 'http://localhost:60505';

async function addTxViaUi(page: Page, amount: string, note: string): Promise<void> {
  await page.getByRole('navigation').getByRole('button', { name: /记账/ }).click();
  for (const k of amount.replace('.', '').split('')) {
    await page.locator('.keypad').getByRole('button', { name: k, exact: true }).click();
  }
  await page.getByPlaceholder(/用途/).fill(note);
  await page.locator('.category-grid').getByRole('button', { name: /餐饮/ }).click();
  const save = page.getByRole('button', { name: /^保存/ });
  await expect(save).toBeEnabled();
  await save.click();
}

async function editTxAmountViaUi(page: Page, amount: string): Promise<void> {
  await page.getByRole('navigation').getByRole('button', { name: /明细/ }).click();
  await page.locator('.tx-row').first().click();
  await page.locator('.tx-editor .field input').first().fill(amount);
  await page.locator('.tx-editor').getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.tx-editor')).toBeHidden();
}

/** 服务端交易行(协议级 pull,绕过 UI 时序) */
function pullTxsRaw(page: Page): Promise<Array<{ id: string; amount: string; note: string | null }>> {
  return page.evaluate(async (api) => {
    const token = localStorage.getItem('lo_access')!;
    const pull = await (await fetch(`${api}/v1/sync/pull?cursor=0&limit=1000`, { headers: { Authorization: `Bearer ${token}` } })).json();
    return pull.rows
      .filter((r: { entity: string }) => r.entity === 'transaction')
      .map((r: { row: { id: string; amount: string; note: string | null } }) => r.row);
  }, API) as Promise<Array<{ id: string; amount: string; note: string | null }>>;
}

/** 协议级 B 写入:同账号直改 pulled 行的备注并 push(返回 op 结果) */
function pushNoteEdit(page: Page, targetId: string, note: string): Promise<{ status: string }> {
  return page.evaluate(async ({ api, targetId, note }) => {
    const token = localStorage.getItem('lo_access')!;
    const pull = await (await fetch(`${api}/v1/sync/pull?cursor=0&limit=1000`, { headers: { Authorization: `Bearer ${token}` } })).json();
    // 共享账号跨旅程可能有其他流水:必须按本旅程创建的行 id 精确定位
    const txRow = pull.rows.find((r: { entity: string; row: { id: string } }) => r.entity === 'transaction' && r.row.id === targetId)?.row;
    if (!txRow) return { status: 'no-tx-in-pull' };
    const op = {
      entity: 'transaction', entityId: txRow.id, op: 'upsert',
      payload: { ...txRow, note, client_version: txRow.client_version + 1 },
      clientVersion: txRow.client_version + 1, baseVersion: txRow.server_version,
      occurredAt: Date.now(), deviceId: 'device-B',
    };
    const res = await (await fetch(`${api}/v1/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ changes: [op] }),
    })).json();
    return res.results[0];
  }, { api: API, targetId, note }) as Promise<{ status: string }>;
}

test('双端并发:离线改金额 × 在线改备注 → 三方合并为一行,两端修改都保留', async ({ browser }) => {
  test.setTimeout(120_000);
  // 设备 A:注册 + 记一笔 ¥10「冲突原文」;轮询内反复点徽标强制同步
  // (无头 Chrome 下 2s 防抖定时器不可靠;引擎 busy 时 badge click 的 syncOnce 会被吞,故每轮重试)
  const ctxA = await browser.newContext({ viewport: { width: 480, height: 900 }, storageState: 'e2e/.auth/state.json' });
  const pageA = await ctxA.newPage();
  await pageA.goto('/');
  await expect(pageA.locator('.sync-badge')).toContainText(/已同步|已登录/, { timeout: 20_000 }); // 共享登录态(设备 A)
  await addTxViaUi(pageA, '10', '冲突原文');
  // 共享账号跨旅程存在其他流水:捕获本旅程目标行 id,后续全部按 id 精确断言
  let targetId = '';
  await expect
    .poll(
      async () => {
        await pageA.locator('.sync-badge').click().catch(() => undefined);
        const hit = (await pullTxsRaw(pageA)).find((t) => t.note === '冲突原文' && Number(t.amount) === 10);
        targetId = hit?.id ?? '';
        return hit ? 'found' : 'pending';
      },
      { timeout: 30_000, intervals: [1000, 2000] },
    )
    .toBe('found');
  expect(targetId).not.toBe('');

  // 设备 B:同账号登录(拉到同一份数据)
  // 设备 B:同账号第二上下文(同 storageState 即同账号)。
  const ctxB = await browser.newContext({ viewport: { width: 480, height: 900 }, storageState: 'e2e/.auth/state.json' });
  const pageB = await ctxB.newPage();
  await pageB.goto('/');
  await expect(pageB.locator('.sync-badge')).toContainText(/已同步|已登录/, { timeout: 20_000 });

  // A 离线改金额 10 → 66(本地落库、outbox 排队,不上行)
  await ctxA.setOffline(true);
  await editTxAmountViaUi(pageA, '66');

  // B 在线改备注:服务端 applied(此时金额仍 10)
  const bResult = await pushNoteEdit(pageB, targetId, 'B在在线态修改');
  expect(bResult.status).toBe('applied');

  // A 恢复在线并强制同步:两端改的是不同字段(A 金额、B 备注)→ 无冲突,干净合并为一行
  await ctxA.setOffline(false);
  await expect
    .poll(
      async () => {
        await pageA.locator('.sync-badge').click().catch(() => undefined);
        const rows = await pullTxsRaw(pageB);
        return rows.find((r) => r.id === targetId)?.note ?? 'pending';
      },
      { timeout: 30_000, intervals: [1000, 2000] },
    )
    .toBe('B在在线态修改');
  const merged = (await pullTxsRaw(pageB)).find((r) => r.id === targetId);
  expect(Number(merged?.amount), 'A 的金额修改应用').toBe(66);
  expect(merged?.note, 'B 的备注修改保留').toBe('B在在线态修改');

  // A 本地收敛:合并结果(金额 66 + B 的备注)从服务端拉回
  await pageA.getByRole('navigation').getByRole('button', { name: /明细/ }).click();
  await expect
    .poll(
      async () =>
        await pageA.evaluate(async (tid) => {
          const db = (window as unknown as { __ledgerone: { db: { transactions: { toArray(): Promise<Array<{ id: string; amount: string; note: string | null }>> } } } }).__ledgerone.db;
          const row = (await db.transactions.toArray()).find((t) => t.id === tid);
          return row ? `${row.note}|${Number(row.amount)}` : 'pending';
        }, targetId),
      { timeout: 20_000, intervals: [1000, 2000] },
    )
    .toBe('B在在线态修改|66');
  await expect(pageA.getByText('-¥66.00').first()).toBeVisible({ timeout: 15_000 });
  await expect(pageA.getByText('B在在线态修改').first()).toBeVisible();
  await expect(pageA.getByText(/冲突副本/)).toHaveCount(0); // 不同字段并发:不再产生伪冲突副本

  await ctxA.close();
  await ctxB.close();
});
