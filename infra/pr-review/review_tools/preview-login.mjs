// Server-run only: signs in to the preview outside any recording and leaves a storage state for review-check.
import { createRequire } from 'node:module';
import { chmodSync, writeFileSync } from 'node:fs';

const require = createRequire('/opt/review-tools/package.json');
const { chromium } = require('playwright');

const STATE_PATH = '/tmp/preview-state.json';
const SIGN_IN_TIMEOUT_MS = 60_000;
const BYPASS_HEADER = 'x-vercel-protection-bypass';
const SET_COOKIE_HEADER = 'x-vercel-set-bypass-cookie';

function fail(blocker, message) {
  process.stdout.write(JSON.stringify({ ok: false, blocker, message }));
  process.exit(1);
}

const config = JSON.parse(process.env.PREVIEW_LOGIN_CONFIG ?? '{}');
const { webOrigin, bypass = [], email, password } = config;
if (!webOrigin || !email || !password) fail('development_configuration', 'Preview login config is incomplete.');

const browser = await chromium.launch().catch(() => fail('browser_runtime', 'Chromium did not start.'));
try {
  const context = await browser.newContext();
  // SameSite=None lets the web preview send the API preview's protection cookie on its credentialed fetches.
  for (const { origin, secret } of bypass) {
    const response = await context.request.get(origin + '/', {
      headers: { [BYPASS_HEADER]: secret, [SET_COOKIE_HEADER]: 'samesitenone' },
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    if (response.status() === 401 || response.status() === 403) {
      fail('development_preview', `Vercel protection rejected the bypass for ${new URL(origin).host}.`);
    }
  }
  const page = await context.newPage();
  await page.goto(webOrigin, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const chat = page.getByTestId('chat-top-bar');
  const alert = page.getByRole('alert');
  await chat.or(alert).first().waitFor({ timeout: SIGN_IN_TIMEOUT_MS })
    .catch(() => fail('test_account', 'The preview did not reach the signed-in app.'));
  // The signed-in shell can show unrelated API alerts; only a missing shell means the credentials failed.
  await chat.waitFor({ timeout: 5_000 }).catch(() => fail('test_account', 'The preview rejected the test account sign-in.'));
  writeFileSync(STATE_PATH, JSON.stringify(await context.storageState()));
  chmodSync(STATE_PATH, 0o600);
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  fail('development_preview', `Preview sign-in failed: ${error instanceof Error ? error.name : 'unknown'}.`);
} finally {
  await browser.close();
}
