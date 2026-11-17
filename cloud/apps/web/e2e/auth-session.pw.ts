import { expect, test } from '@playwright/test';
import { signIn } from './sign-in';

test('a snapshot held across logout is cancelled before the revoked session reaches the API', async ({ page }) => {
  await signIn(page);
  const snapshotPath = '/v1/runs/logout-race-probe/snapshot';
  const unauthorizedSnapshots: string[] = [];
  page.on('response', response => {
    if (new URL(response.url()).pathname === snapshotPath && response.status() === 401) unauthorizedSnapshots.push(snapshotPath);
  });
  let release!: () => void;
  let dispatched!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { dispatched = resolve; });
  await page.route('**' + snapshotPath, async route => {
    dispatched();
    await held;
    await route.continue();
  });
  const pendingSnapshot = page.evaluate(async () => {
    const path = '/src/lib/api.ts';
    const { apiClient } = await import(path) as typeof import('../src/lib/api');
    try {
      await apiClient.getRunSnapshot('logout-race-probe');
      return 'complete';
    } catch (error) {
      return error instanceof Error ? error.name : 'unknown';
    }
  });
  try {
    await started;
    await page.route('**/v1/bootstrap', route => route.fulfill({ status: 401, body: '{}' }));
    await page.evaluate(async () => {
      const path = '/src/lib/api.ts';
      const { apiClient } = await import(path) as typeof import('../src/lib/api');
      await apiClient.bootstrap().catch(() => undefined);
    });
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  } finally {
    release();
  }
  expect(await pendingSnapshot).toBe('AbortError');
  expect(unauthorizedSnapshots).toEqual([]);
});
