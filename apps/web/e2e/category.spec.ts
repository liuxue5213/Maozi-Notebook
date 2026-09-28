/**
 * 自定义分类旅程(全检第 15 轮,M03 分类管理端侧入口):
 * 注册 → 新建支出分类「🐾 宠物用品」(emoji 前缀自动拆图标)→ quickadd 网格出现且可选
 * → 用它记一笔(校验 category 归属)→ 隐藏 → 网格不再出现 → 预置分类隐藏/显示
 * → 删除自定义分类(级联确认)→ 网格消失、已有流水保留原分类引用。
 */
import { expect, test, type Page } from '@playwright/test';

const API = 'http://localhost:60505';

test('自定义分类:新建/选择记账/隐藏/删除,预置分类仅隐藏', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(page.locator('.sync-badge')).toContainText(/已同步|已登录/, { timeout: 20_000 }); // 共享登录态

  // ---- 新建支出分类「🐾 宠物用品」 ----
  await page.getByRole('navigation').getByRole('button', { name: /我的/ }).click();
  await page.getByRole('button', { name: /分类管理/ }).click();
  await expect(page.getByRole('button', { name: '新建一级' }).first()).toBeVisible();
  page.once('dialog', (d) => void d.accept('🐾 宠物用品'));
  await page.locator('.me-section').filter({ hasText: '支出分类' }).getByRole('button', { name: '新建一级' }).click();
  await expect(page.locator('.me-row').filter({ hasText: '宠物用品' }).first()).toBeVisible();

  // ---- quickadd 网格出现新分类并可选;用它记一笔 ----
  await page.getByRole('navigation').getByRole('button', { name: /记账/ }).click();
  await page.locator('.category-grid').getByRole('button', { name: /宠物用品/ }).click();
  for (const k of ['2', '5']) await page.locator('.keypad').getByRole('button', { name: k, exact: true }).click();
  const save = page.getByRole('button', { name: /^保存/ });
  await expect(save).toBeEnabled();
  await save.click();

  // ---- 隐藏「宠物用品」→ 网格不再出现(分类引用保留) ----
  await page.getByRole('navigation').getByRole('button', { name: /我的/ }).click();
  await page.getByRole('button', { name: /分类管理/ }).click();
  const row = page.locator('.me-row').filter({ hasText: '宠物用品' }).first();
  await row.getByRole('button', { name: '隐藏' }).click();
  await expect(row.getByRole('button', { name: '显示' })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: /记账/ }).click();
  await expect(page.locator('.category-grid').getByRole('button', { name: /宠物用品/ })).toHaveCount(0);

  // ---- 预置分类:隐藏「娱乐」→ 显示(无删除按钮) ----
  await page.getByRole('navigation').getByRole('button', { name: /我的/ }).click();
  await page.getByRole('button', { name: /分类管理/ }).click();
  const funRow = page.locator('.me-row').filter({ hasText: '娱乐 · 预置' }).first();
  await expect(funRow.getByRole('button', { name: '删除' })).toHaveCount(0);
  await funRow.getByRole('button', { name: '隐藏' }).click();
  await expect(funRow.getByRole('button', { name: '显示' })).toBeVisible();
  await funRow.getByRole('button', { name: '显示' }).click();
  await expect(funRow.getByRole('button', { name: '隐藏' })).toBeVisible();

  // ---- 删除自定义分类(级联确认),流水保留、分类引用不丢 ----
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: '删除' }).click();
  await expect(page.locator('.me-row').filter({ hasText: '宠物用品' }).filter({ has: page.getByRole('button', { name: '删除' }) })).toHaveCount(0, { timeout: 10_000 }); // 自定义行删除;预置子分类同名不受影响

  // 服务端收敛:分类墓碑 + 流水仍在(引用原分类 id)
  await expect
    .poll(
      async () =>
        await page.evaluate(async (api) => {
          const token = localStorage.getItem('lo_access')!;
          const pull = await (await fetch(`${api}/v1/sync/pull?cursor=0&limit=1000`, { headers: { Authorization: `Bearer ${token}` } })).json();
          const cats = pull.rows.filter((r: { entity: string }) => r.entity === 'category').map((r: { row: { name: string; is_deleted: boolean; is_preset: boolean } }) => r.row);
          const txs = pull.rows.filter((r: { entity: string }) => r.entity === 'transaction').map((r: { row: { amount: string; category_id: string | null } }) => r.row);
          // 同名预置子分类(宠物·预置 下)不受影响,只认自定义分类的墓碑
          const removed = cats.find((c: { name: string; is_preset: boolean }) => c.name === '宠物用品' && c.is_preset === false);
          if (!removed?.is_deleted) return 'pending';
          return txs.some((t: { amount: string; category_id: string | null }) => Number(t.amount) === 25 && t.category_id) ? 'done' : 'pending';
        }, API),
      { timeout: 20_000, intervals: [1000, 2000] },
    )
    .toBe('done');
});
