import { defineConfig } from '@playwright/test';
import { DEFAULT_WEB_PORT } from '../../../verify/src/constants.js';
export default defineConfig({
  testDir: '.', testMatch: '*.pw.ts',
  globalSetup: '../../../verify/src/web/browser-setup.ts',
  outputDir: process.env.PW_OUTPUT_DIR ?? 'test-results',
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: process.env.PW_BASE_URL ?? `http://127.0.0.1:${DEFAULT_WEB_PORT}`,
    viewport: { width: 402, height: 874 },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
