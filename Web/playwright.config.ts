import { defineConfig } from '@playwright/test';

if (process.env.XBT_E2E_ISOLATED !== '1' || !process.env.XBT_E2E_JWT_SECRET) {
  throw new Error('请使用 npm run test:e2e 创建隔离环境，不要连接现有部署');
}

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 45_000,
  outputDir: process.env.XBT_E2E_RESULTS,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:33081',
    channel: 'msedge',
    headless: process.env.XBT_E2E_HEADED !== '1',
    launchOptions: { slowMo: process.env.XBT_E2E_HEADED === '1' ? 650 : 0 },
    viewport: process.env.XBT_E2E_HEADED === '1' ? { width: 1100, height: 900 } : { width: 430, height: 932 },
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
});
