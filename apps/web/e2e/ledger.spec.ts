/**
 * 多账本旅程(全检第 14 轮,M02 多账本端侧入口):
 * (共享登录态)新建「出差账本」→ 自动切换 → 在新账本记账(校验 ledger 归属)→ 切回默认账本
 * → 删除「出差账本」(级联软删 + 确认交互)→ 服务端墓碑收敛。
 * 语义:Web 端明细跨账本展示,「切换」决定新记账归入的账本(active_ledger)。
 */
import { expect, test, type Page } from '@playwright/test';

const API = 'http://localhost:60505';

function pullLedgersRaw(page: Page): Promise<Array<{ id: string; name: string; is_deleted: boolean }>> {
  return page.evaluate(async (api) => {
    const token = localStorage.getItem('lo_access')!;
    const pull = await (await fetch(`${api}/v1/sync/pull?cursor=0&limit=1000`, { headers: { Authorization: `Bearer ${token}` } })).json();
    return pull.rows
      .filter((r: { entity: string }) => r.entity === 'ledger')
      .map((r: { row: { id: string; name: string; is_deleted: boolean } }) => r.row);
  }, API) as Promise<Array<{ id: string; name: string; is_deleted: boolean }>>;
}

test('多账本:新建/切换/归属校验/级联删除', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(page.locator('.sync-badge')).toContainText(/已同步|已登录/, { timeout: 20_000 }); // 共享登录态

  // ---- 新建「出差账本」(prompt 交互自动接受) ----
  await page.getByRole('navigation').getByRole('button', { name: /我的/ }).click();
  await page.getByRole('button', { name: /账本管理/ }).click();
  await expect(page.getByText('账本管理')).toBeVisible();
  page.once('dialog', (d) => void d.accept('出差账本'));
  await page.getByRole('button', { name: '新建账本' }).click();
  await expect(page.getByText(/出差账本 · 当前/)).toBeVisible({ timeout: 10_000 }); // 新建即切换

  // ---- 在新账本记账,校验归属 ----
  await page.getByRole('navigation').getByRole('button', { name: /记账/ }).click();
  for (const k of ['8', '.', '8']) await page.locator('.keypad').getByRole('button', { name: k, exact: true }).click();
  await page.locator('.category-grid').getByRole('button', { name: /交通/ }).click();
  const save = page.getByRole('button', { name: /^保存/ });
  await expect(save).toBeEnabled();
  await save.click();
  await expect
    .poll(
      async () =>
        await page.evaluate(async () => {
          const db = (window as unknown as { __ledgerone: { db: { transactions: { toArray(): Promise<Array<{ ledger_id: string; amount: string }>> }; ledgers: { toArray(): Promise<Array<{ id: string; name: string }>> } } } }).__ledgerone.db;
          const txs = await db.transactions.toArray();
          const target = (await db.ledgers.toArray()).find((l) => l.name === '出差账本');
          return txs.some((t) => target && t.ledger_id === target.id && Number(t.amount) === 8.8) ? 'yes' : 'pending';
        }),
      { timeout: 15_000, intervals: [500, 1000] },
    )
    .toBe('yes');

  // ---- 切回默认账本,删除「出差账本」(confirm 交互接受) ----
  await page.getByRole('button', { name: /我的/ }).click();
  await page.getByRole('button', { name: /账本管理/ }).click();
  const tripRow = page.locator('.me-row').filter({ hasText: '出差账本' });
  // 记账后 active 仍是出差账本 → 先切回默认账本(出差行没有「切换」按钮,定位默认账本行)
  await page.locator('.me-row').filter({ hasText: '我的账本' }).getByRole('button', { name: '切换' }).click();
  await expect(page.getByText(/我的账本 · 当前/)).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await tripRow.getByRole('button', { name: '删除' }).click();
  await expect(page.getByText(/出差账本/)).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText(/我的账本 · 当前/)).toBeVisible();

  // ---- 服务端收敛:墓碑下行(账本软删),流水软删随行 ----
  await expect
    .poll(
      async () => {
        const ledgers = await pullLedgersRaw(page);
        const trip = ledgers.find((l) => l.name === '出差账本');
        return trip ? (trip.is_deleted ? 'tombstoned' : 'alive') : 'missing';
      },
      { timeout: 20_000, intervals: [1000, 2000] },
    )
    .toBe('tombstoned');
});
