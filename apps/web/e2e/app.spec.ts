/**
 * 端到端完整旅程(固化第 5/6 轮手工回归,全检第 11 轮):
 * 注册 → 云同步 → 记账(带敏感备注)→ 明细搜索 → 应用锁+字段加密(密文直读/锁定/解锁/关闭解密)→ 登出重登数据拉回。
 * 单条串行旅程:后续步骤依赖前序登录态与本地数据(Playwright 每 test 独立上下文,拆分会丢状态)。
 */
import { expect, test, type Page } from '@playwright/test';

// 本旅程自带「注册新账号」步骤(覆盖注册/换号清库路径):显式清空共享登录态,从未登录开始
test.use({ storageState: { cookies: [], origins: [] } });

const email = `e2e-${Date.now()}@test.dev`;
const password = 'e2epassword123';
const pin = '135790';
const NOTE = 'E2E自动化加密备注:星巴克';

/** 绕过中间件直读 IndexedDB 原始行(验证落盘密文/明文) */
function readRawNotes(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const open = indexedDB.open('ledgerone');
        open.onsuccess = () => {
          const idb = open.result;
          const tx = idb.transaction('transactions', 'readonly');
          const rq = tx.objectStore('transactions').getAll();
          rq.onsuccess = () => {
            resolve(rq.result.map((t) => String((t as { note?: string }).note ?? '')));
            idb.close();
          };
        };
      }),
  );
}

test('完整旅程:注册→记账→搜索→应用锁加密→登出重登', async ({ page }) => {
  // ---- 注册并确认云同步 ----
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: /我的/ }).click();
  await page.getByRole('button', { name: /登录 \/ 注册/ }).click();
  await page.getByRole('button', { name: /没有账号/ }).click();
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('至少 8 位').fill(password);
  await page.getByRole('button', { name: '注册并登录' }).click();
  await expect(page.locator('.sync-badge')).toContainText(/已同步|已登录/, { timeout: 20_000 });

  // ---- 记一笔带敏感备注的支出 ----
  await page.getByRole('navigation').getByRole('button', { name: /记账/ }).click();
  for (const k of ['2', '3', '.', '5']) await page.locator('.keypad').getByRole('button', { name: k, exact: true }).click();
  await page.getByPlaceholder(/用途/).fill(NOTE);
  await page.locator('.category-grid').getByRole('button', { name: /餐饮/ }).click();
  const save = page.getByRole('button', { name: /^保存/ });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator('[class*="toast"]')).toContainText(/星巴克/, { timeout: 10_000 });

  // ---- 明细按备注关键词搜索(解密读) ----
  await page.getByRole('navigation').getByRole('button', { name: /明细/ }).click();
  await page.getByRole('button', { name: /筛选/ }).click();
  await page.getByPlaceholder('如 咖啡').fill('星巴克');
  await expect(page.getByText(NOTE).first()).toBeVisible();

  // ---- 开启应用锁(端侧加密随之开启) ----
  await page.getByRole('navigation').getByRole('button', { name: /我的/ }).click();
  await page.getByRole('button', { name: /安全与隐私/ }).click();
  await page.locator('.me-section').filter({ hasText: '应用锁' }).getByRole('button', { name: '开启', exact: true }).click();
  await page.locator('.modal input[type="password"]').nth(0).fill(pin);
  await page.locator('.modal input[type="password"]').nth(1).fill(pin);
  await page.getByRole('button', { name: '开启应用锁' }).click();
  await expect.poll(() => page.evaluate(() => !!localStorage.getItem('lo_fenc')), { timeout: 20_000 }).toBe(true);

  // ---- 直读 IndexedDB:落盘必须是密文(lo_fenc 先于清扫落盘,直接轮询密文出现) ----
  await expect
    .poll(async () => (await readRawNotes(page)).some((n) => n.startsWith('enc1:')), { timeout: 20_000 })
    .toBe(true);

  // ---- 刷新 → 锁定门 → 错误 PIN 拒绝 / 正确 PIN 解锁 ----
  await page.reload();
  await expect(page.locator('.lock-mask')).toBeVisible();
  await page.locator('.lock-input').fill('999999');
  await page.locator('.lock-card').getByRole('button', { name: '解锁' }).click();
  await expect(page.locator('.form-error')).toContainText('PIN 不正确');
  await page.locator('.lock-input').fill(pin);
  await page.locator('.lock-card').getByRole('button', { name: '解锁' }).click();
  await expect(page.locator('.lock-mask')).toBeHidden({ timeout: 20_000 });

  // ---- 解锁后明细仍可按备注搜索(解密读恢复) ----
  await page.getByRole('navigation').getByRole('button', { name: /明细/ }).click();
  await page.getByRole('button', { name: /筛选/ }).click();
  await page.getByPlaceholder('如 咖啡').fill('星巴克');
  await expect(page.getByText(NOTE).first()).toBeVisible();

  // ---- 关闭应用锁 → 全量解密落盘 ----
  await page.getByRole('navigation').getByRole('button', { name: /我的/ }).click();
  await page.getByRole('button', { name: /安全与隐私/ }).click();
  await page.locator('.me-row').filter({ hasText: '关闭前需验证' }).getByRole('button', { name: /关闭应用锁/ }).click();
  await page.locator('.modal input[type="password"]').fill(pin);
  await page.locator('.modal').getByRole('button', { name: '确认', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lo_fenc')), { timeout: 20_000 }).toBeNull();
  const plaintext = await readRawNotes(page);
  expect(plaintext.some((n) => n.includes('星巴克'))).toBe(true);

  // ---- 登出(F-08)→ 重登 → 数据从服务端拉回 ----
  await page.getByRole('button', { name: /返回/ }).click();
  await page.getByRole('button', { name: /退出登录/ }).click();
  await expect(page.getByText(/纯本地模式/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /登录 \/ 注册/ }).click();
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('至少 8 位').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.sync-badge')).toContainText(/已同步|已登录/, { timeout: 20_000 });
  await page.getByRole('navigation').getByRole('button', { name: /明细/ }).click();
  await expect(page.getByText(NOTE).first()).toBeVisible({ timeout: 15_000 });
});
