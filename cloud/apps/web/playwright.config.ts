import { defineConfig } from '@playwright/test';
// Real-browser tests of the glass. Needs the app running: PW_BASE_URL (default the WP-G1 port).
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.pw.ts',
  outputDir: process.env.PW_OUTPUT_DIR ?? '/tmp/praxis-pw-web',
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: process.env.PW_BASE_URL ?? 'http://127.0.0.1:5198',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
