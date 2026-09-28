/**
 * 账号设置旅程(全检第 16 轮,M16 主币种与账号设置):
 * (共享登录态)我的 → 账号设置 → 改昵称 + 主币种 USD → 保存 → localStorage 缓存更新
 * → 服务端 /me 持久化 → 新记账币种为 USD(数据级应用)→ 切回 CNY。
 */
import { expect, test, type Page } from '@playwright/test';

const API = 'http://localhost:60505';

test('账号设置:昵称 + 主币种持久化,新记账应用主币种', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(page.locator('.sync-badge')).toContainText(/已同步|已登录/, { timeout: 20_000 }); // 共享登录态

  // ---- 保存昵称 + USD ----
  await page.getByRole('navigation').getByRole('button', { name: /我的/ }).click();
  await page.getByRole('button', { name: /账号设置/ }).click();
  await expect(page.locator('.field input').first()).toBeVisible({ timeout: 10_000 });
  await page.locator('.field input').first().fill('E2E小明');
  await page.locator('.field select').selectOption('USD');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('已保存')).toBeVisible({ timeout: 10_000 });
  await expect(page.evaluate(() => localStorage.getItem('lo_base_currency'))).resolves.toBe('USD');

  // ---- 服务端持久化(/me 回读) ----
  const me = await page.evaluate(async (api) => {
    const token = localStorage.getItem('lo_access')!;
    return (await (await fetch(`${api}/v1/users/me`, { headers: { Authorization: `Bearer ${token}` } })).json()) as {
      nickname: string; baseCurrency: string;
    };
  }, API);
  expect(me.nickname).toBe('E2E小明');
  expect(me.baseCurrency).toBe('USD');

  // ---- 新记账应用主币种(数据级) ----
  await page.getByRole('navigation').getByRole('button', { name: /记账/ }).click();
  for (const k of ['3', '3']) await page.locator('.keypad').getByRole('button', { name: k, exact: true }).click();
  await page.locator('.category-grid').getByRole('button', { name: /餐饮/ }).first().click();
  const save = page.getByRole('button', { name: /^保存/ });
  await expect(save).toBeEnabled();
  await save.click();
  await expect
    .poll(
      async () =>
        await page.evaluate(async () => {
          const db = (window as unknown as { __ledgerone: { db: { transactions: { toArray(): Promise<Array<{ currency: string; amount: string }>> } } } }).__ledgerone.db;
          const hit = (await db.transactions.toArray()).find((t) => Number(t.amount) === 33);
          return hit?.currency ?? 'pending';
        }),
      { timeout: 15_000, intervals: [500, 1000] },
    )
    .toBe('USD');

  // ---- 切回 CNY(恢复共享态默认,避免影响其他旅程) ----
  await page.getByRole('navigation').getByRole('button', { name: /我的/ }).click();
  await page.getByRole('button', { name: /账号设置/ }).click();
  await page.locator('.field select').selectOption('CNY');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('已保存').first()).toBeVisible({ timeout: 10_000 });
});
