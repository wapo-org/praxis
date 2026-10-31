import { BASE, API } from './check-env.mjs';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const suffix = Date.now();
  const title = `Private user A ${suffix}`;
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Continue as local dev user' }).waitFor();
  await page.evaluate(async ({ suffix, title }) => {
    const { apiClient } = await import('/src/lib/api.ts');
    await (await import('/src/lib/dev-auth.ts')).devAuth(`wp-b1-A-${suffix}`);
    await apiClient.createChat({ title });
  }, { suffix, title });
  await page.reload();
  await page.getByTestId('chat-top-bar').waitFor();
  await page.getByTestId('nav-history-button').click();
  await page.getByText(title, { exact: true }).first().waitFor();
  await page.evaluate(async suffix => {
    const { apiClient } = await import('/src/lib/api.ts');
    await (await import('/src/lib/dev-auth.ts')).devAuth(`wp-b1-B-${suffix}`);
  }, suffix);
  await page.addInitScript(title => {
    window.sawUserA = false;
    new MutationObserver(() => { if (document.body?.textContent?.includes(title)) window.sawUserA = true; })
      .observe(document, { childList: true, subtree: true });
  }, title);
  await page.goto(`${BASE}/`);
  await page.getByTestId('chat-top-bar').waitFor();
  await page.getByTestId('nav-history-button').click();
  assert.equal(await page.getByText(title, { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.sawUserA), false);
  await page.goto(`${BASE}/settings`);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await page.getByTestId('chat-screen').count(), 0);
  console.log('PASS: real API user A→B same browser: no A content painted; sign-out removes private UI');
} finally { await browser.close(); }
