import { defineConfig } from '@playwright/test';
import { DEFAULT_WEB_PORT } from '../../packages/verify/src/constants.js';
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/setup.ts',
  testMatch: '*.pw.ts',
  outputDir: process.env.PW_OUTPUT_DIR ?? '/tmp/praxis-pw-web',
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: process.env.PW_BASE_URL ?? `http://127.0.0.1:${DEFAULT_WEB_PORT}`,
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
