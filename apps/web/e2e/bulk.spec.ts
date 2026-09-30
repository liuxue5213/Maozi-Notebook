/**
 * 大数据量明细旅程(全检第 22 轮,P0-3 修复验证):
 * 批量落 550 行流水(dev 钩子直写,不经同步)→
 * ① 修复核心:显示上限(500)之外的老流水(第 10 条)通过关键词筛选**必须可见**(修复前 limit(300) 先截断,永远搜不到);
 * ② 截断提示:无筛选时展示「已显示最近 500 条(共 550 条命中)」;
 * ③ 命中计数不失真:关键词唯一命中显示 1/550。
 */
import { expect, test } from '@playwright/test';

test('明细大数据量:限外老流水可搜到 + 截断提示 + 计数不失真', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(page.locator('.sync-badge')).toContainText(/已同步|已登录/, { timeout: 20_000 });

  // 批量落 550 行(倒序铺 550 天,note 补零防子串误命中)
  const seeded = await page.evaluate(async () => {
    const db = (window as unknown as { __ledgerone: { db: { transactions: { bulkPut(rows: unknown[]): Promise<unknown>; count(): Promise<number> } } } }).__ledgerone.db;
    const BASE = Date.now() - 550 * 86_400_000;
    const rows = Array.from({ length: 550 }, (_, i) => ({
      id: `bulk-${String(i).padStart(4, '0')}`,
      ledger_id: 'seed-ledger', user_id: 'local', member_id: null, type: 'expense',
      amount: '1.00', currency: 'CNY', amount_base: '1.00', exchange_rate: null,
      category_id: null, account_id: 'seed-acc', to_account_id: null,
      happened_at: BASE + i * 86_400_000, note: `bulk-${String(i).padStart(4, '0')}`,
      is_refunded: false, refund_of_id: null, reimburse_status: null, exclude_from_budget: false,
      attachment_count: 0, source: 'manual', client_version: 1, server_version: null,
      is_deleted: false, deleted_at: null, created_at: BASE, updated_at: BASE,
    }));
    await db.transactions.bulkPut(rows);
    return db.transactions.count();
  });
  expect(seeded).toBeGreaterThanOrEqual(550);

  // ② 无筛选:截断提示出现(共 550 命中 > 500)
  await page.getByRole('navigation').getByRole('button', { name: /明细/ }).click();
  await expect(page.getByText(/已显示最近 500 条/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/共 550 条命中/)).toBeVisible();

  // ① 修复核心:关键词搜「bulk-0010」(第 11 新 → 展示上限之外的老流水)必须命中
  await page.getByRole('button', { name: /筛选/ }).click();
  await page.getByPlaceholder('如 咖啡').fill('bulk-0010');
  await expect(page.getByText('bulk-0010').first()).toBeVisible({ timeout: 15_000 });
  // ③ 计数不失真:唯一命中 → 1/550(注意 bulk-0010 不会子串命中 bulk-0100 系列)
  await expect(page.getByText(/1\/550 条/)).toBeVisible({ timeout: 10_000 });
});
