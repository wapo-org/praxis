import { BASE } from './check-env.mjs';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const suffix = Date.now();
  const title = `Doomed chat ${suffix}`;
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Continue as local dev user' }).waitFor();
  const token = await page.evaluate(
    async ({ suffix, title }) => {
      const { apiClient } = await import('/src/lib/api.ts');
      const session = await (await import('/src/lib/dev-auth.ts')).devAuth(`wp-d2-${suffix}`);
      await apiClient.createChat({ title });
      return session.bearerToken;
    },
    { suffix, title },
  );
  await page.reload();
  await page.getByTestId('chat-top-bar').waitFor();
  if (await page.getByTestId('nav-history-button').isVisible()) await page.getByTestId('nav-history-button').click();
  await page.getByText(title, { exact: true }).first().waitFor();
  // Verify replica hits disk before deletion so empty IDB is meaningful.
  await page.waitForFunction(
    async () =>
      (await indexedDB.databases()).some((d) => d.name === 'praxis-cloud-scoped-v2') &&
      Object.keys(localStorage).some((k) => k.startsWith('praxis-replica-owner:')),
  );
  await page.goto(`${BASE}/settings/account`);
  await page.getByTestId('delete-account-row').click();
  const dialog = page.getByRole('dialog', { name: 'Delete account' });
  await dialog.getByText('This can’t be undone', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: 'Delete account permanently' }).click();
  await page.getByTestId('account-notice').filter({ hasText: 'Account deleted' }).waitFor();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await page.getByTestId('chat-screen').count(), 0);
  const after = await page.evaluate(async (token) => {
    const cookie = await fetch('/v1/auth/session', { credentials: 'include' });
    const bearer = await fetch('/v1/bootstrap', { headers: { authorization: `Bearer ${token}` } });
    return {
      cookie: cookie.status,
      bearer: bearer.status,
      databases: (await indexedDB.databases()).map((d) => d.name),
      markers: Object.keys(localStorage).filter((k) => k.startsWith('praxis-replica')),
    };
  }, token);
  assert.equal(after.cookie, 401, 'cookie session must be gone');
  assert.equal(after.bearer, 401, 'bearer credential must be revoked');
  assert.deepEqual(
    after.databases.filter((n) => n?.startsWith('praxis-cloud')),
    [],
    'IndexedDB must be empty',
  );
  assert.deepEqual(after.markers, []);
  await page.reload();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await page.getByText(title, { exact: true }).count(), 0);
  const status = await page.evaluate(async (suffix) => {
    await (await import('/src/lib/dev-auth.ts')).devAuth(`wp-d2-${suffix}`);
    return (await fetch('/v1/bootstrap', { credentials: 'include' })).status;
  }, suffix);
  assert.equal(status, 200, 'fresh dev sign-in after deletion must work');
  await page.goto(BASE); // Tab starts on /settings; navigate home before opening history.
  await page.getByTestId('chat-top-bar').waitFor();
  if (await page.getByTestId('nav-history-button').isVisible()) await page.getByTestId('nav-history-button').click();
  await page.waitForTimeout(500);
  assert.equal(await page.getByText(title, { exact: true }).count(), 0);
  console.log(
    'PASS: Settings → Account → Delete account: API session gone (cookie+bearer 401), IndexedDB empty, sign-in with notice; fresh dev sign-in is a clean account',
  );
} finally {
  await browser.close();
}
