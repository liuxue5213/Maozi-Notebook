/**
 * 共享登录态 setup(全检第 15 轮):注册一次、storageState 存盘,main project 全部旅程复用。
 * 背景:注册限流 3 次/小时/IP(F-07),多旅程各自注册会撞墙;app.spec 保留独立注册以覆盖
 * 「换号清库」路径,其余旅程一律以本账号的已登录态开始。
 */
import { expect, test as setup } from '@playwright/test';

const authFile = 'e2e/.auth/state.json';

setup('register shared session', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: /我的/ }).click();
  await page.getByRole('button', { name: /登录 \/ 注册/ }).click();
  await page.getByRole('button', { name: /没有账号/ }).click();
  await page.getByPlaceholder('you@example.com').fill(`shared-${Date.now()}@test.dev`);
  await page.getByPlaceholder('至少 8 位').fill('sharedpassword123');
  await page.getByRole('button', { name: '注册并登录' }).click();
  await expect(page.locator('.sync-badge')).toContainText(/已同步|已登录/, { timeout: 20_000 });
  await page.context().storageState({ path: authFile });
});
