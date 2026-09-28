import { defineConfig } from '@playwright/test';

/**
 * 浏览器端到端(全检第 11 轮,固化第 5/6 轮手工回归):
 * - API server:全新临时 PGlite 库(cwd 在 apps/server 以加载 drizzle 迁移);
 * - Web:vite dev(与开发态一致);先 `pnpm build`(server)再运行本套件(见 package.json e2e 脚本)。
 */
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:60500',
    viewport: { width: 480, height: 900 },
    actionTimeout: 10_000,
    // 使用系统 Chrome(本机 macOS 13 不在新版 Playwright 浏览器分发支持列表,且真 Chrome 更贴近用户环境);
    // CI 或无 Chrome 环境可改回默认 chromium 并执行 `playwright install chromium`
    channel: 'chrome',
  },
  webServer: [
    {
      command: 'node dist/main.js',
      cwd: '../server',
      url: 'http://localhost:60505/readyz',
      reuseExistingServer: false,
      timeout: 60_000,
      env: { DATABASE_URL: 'pglite://e2e-data', DEV_MODE: 'true' },
    },
    {
      command: 'pnpm dev',
      url: 'http://localhost:60500/',
      reuseExistingServer: false,
      timeout: 90_000,
    },
  ],
});
