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
  // P1-4 作用域后明细只看当前账本:造数必须挂在真实 active ledger 与其账户上
  const seeded = await page.evaluate(async () => {
    const db = (window as unknown as { __ledgerone: { db: {
      transactions: { bulkPut(rows: unknown[]): Promise<unknown>; count(): Promise<number> };
      ledgers: { toArray(): Promise<Array<{ id: string }>> };
      accounts: { toArray(): Promise<Array<{ id: string; ledger_id: string }>> };
      meta: { get(k: string): Promise<{ value: unknown } | undefined> };
    } } }).__ledgerone.db;
    const activeLedger = ((await db.meta.get('active_ledger'))?.value as string | undefined) ?? (await db.ledgers.toArray())[0]?.id;
    const accId = (await db.accounts.toArray()).find((a) => a.ledger_id === activeLedger)?.id ?? '';
    const BASE = Date.now() - 550 * 86_400_000;
    const rows = Array.from({ length: 550 }, (_, i) => ({
      id: `bulk-${String(i).padStart(4, '0')}`,
      ledger_id: activeLedger, user_id: 'local', member_id: null, type: 'expense',
      amount: '1.00', currency: 'CNY', amount_base: '1.00', exchange_rate: null,
      category_id: null, account_id: accId, to_account_id: null,
      happened_at: BASE + i * 86_400_000, note: `bulk-${String(i).padStart(4, '0')}`,
      is_refunded: false, refund_of_id: null, reimburse_status: null, exclude_from_budget: false,
      attachment_count: 0, source: 'manual', client_version: 1, server_version: null,
      is_deleted: false, deleted_at: null, created_at: BASE, updated_at: BASE,
    }));
    await db.transactions.bulkPut(rows);
    return db.transactions.count();
  });
  expect(seeded).toBeGreaterThanOrEqual(550);

  // ② 无筛选:分页加载 —— 首批 50/共 550;滑到底哨兵触发自动加载下一批(P0-4 无限滚动)
  await page.getByRole('navigation').getByRole('button', { name: /明细/ }).click();
  await page.waitForTimeout(1200);
  console.log('[dbg]', (await page.locator('.tx-list-wrap').innerText()).slice(0, 300).replace(/\n/g, '|'));
  await expect(page.getByText(/已加载 50 \/ 550 条/)).toBeVisible({ timeout: 15_000 });
  // .app 为 min-height:100%(随内容撑高),实际滚动发生在 window;.content 因不溢出而 scrollTop 恒 0
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(800);
  console.log('[dbg-scroll]', await page.evaluate(() => {
    const c = document.querySelector('.content');
    const el = document.querySelector('[data-testid=load-more-sentinel]');
    const r = el ? el.getBoundingClientRect() : null;
    return `scrollTop=${c ? Math.round(c.scrollTop) : -1} scrollH=${c ? Math.round(c.scrollHeight) : -1} sentinel=${r ? Math.round(r.top) : 'none'}`;
  }));
  await expect(page.getByText(/已加载 100 \/ 550 条/)).toBeVisible({ timeout: 15_000 });

  // ① 修复核心:关键词搜「bulk-0010」(第 11 新 → 展示上限之外的老流水)必须命中
  await page.getByRole('button', { name: /筛选/ }).click();
  await page.getByPlaceholder('如 咖啡').fill('bulk-0010');
  await expect(page.getByText('bulk-0010').first()).toBeVisible({ timeout: 15_000 });
  // ③ 计数不失真:唯一命中 → 1/550(注意 bulk-0010 不会子串命中 bulk-0100 系列)
  await expect(page.getByText(/1\/550 条/)).toBeVisible({ timeout: 10_000 });
});
