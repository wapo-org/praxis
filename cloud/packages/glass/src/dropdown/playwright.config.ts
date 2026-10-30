import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: '*.pw.ts',
  outputDir: '/tmp/wp-b2-playwright',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5192',
    viewport: { width: 402, height: 874 },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
