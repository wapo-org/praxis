import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: '*.pw.ts',
  outputDir: process.env.PW_OUTPUT_DIR ?? 'test-results',
  workers: 1,
  use: {
    baseURL: process.env.PW_BASE_URL ?? `http://localhost:${process.env.PW_PORT ?? '5192'}`,
    viewport: { width: 402, height: 874 },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
