import { defineConfig, devices } from '@playwright/test';

const webPort = Number(process.env.WHAT_THE_REPO_E2E_WEB_PORT ?? '5307');

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  globalSetup: './e2e/global-setup.ts',
  timeout: 150_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: process.platform === 'win32' ? 'chrome' : undefined,
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
