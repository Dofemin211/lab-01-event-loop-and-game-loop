import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:3000/health',
    env: { ALLOWED_ORIGINS: 'http://127.0.0.1:3000' },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
