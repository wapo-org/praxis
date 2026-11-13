import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// The old shell worker cached every .css/.js forever, so dev browsers mixed stale styles with fresh
// components (owner, Safari and Chrome: a tall black composer and menus with empty tops). Every other
// spec blocks workers, which is why none of them saw it. Here a browser that still runs the old worker
// must clean itself up on the next load.
test.use({ serviceWorkers: 'allow' });

const OLD_SW = readFileSync(fileURLToPath(new URL('./fixtures/old-sw-v1.js', import.meta.url)), 'utf8');

test('a dev page removes any shell worker and its caches, then stays uncontrolled', async ({ page, context }) => {
  await context.route('**/sw.js', (route) => route.fulfill({ contentType: 'text/javascript', body: OLD_SW }));
  await page.goto('/');
  // Simulate a browser that registered the worker in an earlier session.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(1);
  await page.reload();
  // Proves the old worker really served this load (it caches what it fetched).
  await page.waitForTimeout(1500);
  // The fresh main.tsx unregisters, purges and reloads once.
  await expect
    .poll(
      () =>
        page.evaluate(async () => ({
          regs: (await navigator.serviceWorker.getRegistrations()).length,
          caches: (await caches.keys()).filter((k) => k.startsWith('praxis-')).length,
          controlled: !!navigator.serviceWorker.controller,
        })),
      { timeout: 15_000 },
    )
    .toEqual({ regs: 0, caches: 0, controlled: false });
});
