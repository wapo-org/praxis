import { signIn } from './sign-in';
import { latestEmailLink } from './test-mail';
import { test, expect, type Page } from '@playwright/test';
const open = async (page: Page) => {
  await signIn(page);
  await page.evaluate(async () => {
    // @ts-expect-error Vite source module.
    (window as any).__api = (await import('/src/lib/api.ts')).apiClient;
    // @ts-expect-error Vite source module.
    (window as any).__replica = (await import('/src/lib/idb.ts')).readReplicaSync;
  });
};
const openApi = async (page: Page) => { await page.evaluate(async () => {
  // @ts-expect-error Vite source module.
  (window as any).__api = (await import('/src/lib/api.ts')).apiClient;
  // @ts-expect-error Vite source module.
  (window as any).__replica = (await import('/src/lib/idb.ts')).readReplicaSync;
}); };
const action = (page: Page, method: string, ...args: unknown[]) => page.evaluate(({method, args}) => (window as any).__api[method](...args), {method,args});
const chats = (page: Page) => page.evaluate(() => (window as any).__replica()?.chats ?? []);
test('two devices converge chats, offline edits, settings, live messages and stop', async ({ browser }, testInfo) => {
  const a = await browser.newContext({ baseURL: testInfo.project.use.baseURL }); const b = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const one = await a.newPage(); const two = await b.newPage();
  try {
    await open(one); await open(two);
    const title = `Sync ${Date.now()}`;
    const chat = await action(one, 'createChat', { title });
    await expect.poll(async () => (await chats(two)).find((c: any) => c.id === chat.id)?.title).toBe(title);
    await action(one, 'patchChat', chat.id, { title: `${title} renamed`, pinned: true });
    await expect.poll(async () => (await chats(two)).find((c: any) => c.id === chat.id)?.pinned).toBe(true);
    await expect.poll(async () => (await chats(two)).find((c: any) => c.id === chat.id)?.title).toBe(`${title} renamed`);
    await expect.poll(async () => (await chats(two))[0]?.id).toBe(chat.id);
    await b.setOffline(true);
    await action(two, 'patchChat', chat.id, { title: `${title} offline` });
    await b.setOffline(false);
    await expect.poll(async () => (await chats(one)).find((c: any) => c.id === chat.id)?.title, { timeout: 15000 }).toBe(`${title} offline`);
    for (const [field, value] of Object.entries({ theme: 'dark', palette: 'forest', model: 'sync-model', effort: 'high' })) {
      await one.evaluate(async ({field, value}) => {
        // @ts-expect-error Vite source module.
        const { apiClient } = await import('/src/lib/api.ts');
        await apiClient.request('/v1/sync/settings', { method: 'PATCH', body: JSON.stringify({ field, value }) });
      }, {field,value});
    }
    await expect.poll(() => two.locator('html').getAttribute('data-theme')).toBe('dark');
    await expect.poll(() => two.locator('html').getAttribute('data-sidebar-palette')).toBe('forest');
    expect(await two.locator('html').getAttribute('data-button-color')).toBeNull();
    expect(await two.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--nb-fill').trim())).toBe('#ffffff');
    const served = await two.evaluate(async () => {
      // @ts-expect-error Vite source module.
      const { apiClient } = await import('/src/lib/api.ts');
      return (await apiClient.request('/v1/sync/settings')).items.map((item: { field: string }) => item.field);
    });
    expect(served).not.toContain('button');
    const retired = await one.evaluate(async () => {
      // @ts-expect-error Vite source module.
      const { apiClient } = await import('/src/lib/api.ts');
      const statuses: number[] = [];
      for (const [field, value] of [['button', '#b6e36b'], ['provider', 'sync-provider']]) {
        try {
          await apiClient.request('/v1/sync/settings', { method: 'PATCH', body: JSON.stringify({ field, value }) });
          statuses.push(200);
        } catch (error) {
          statuses.push((error as { status?: number }).status ?? 0);
        }
      }
      return statuses;
    });
    expect(retired).toEqual([400, 400]);
    await two.goto(`/c/${chat.id}`); await one.goto(`/c/${chat.id}`);
    await openApi(one);
    await openApi(two);
    const run = await action(one, 'startRun', { chatId: chat.id, text: `Live ${title}`, script: 'long' });
    await two.getByTestId('composer-stop-button').waitFor();
    await two.getByTestId('chat-screen').getByText(`Live ${title}`, { exact: true }).waitFor();
    await two.getByTestId('composer-stop-button').click();
    await expect(one.getByTestId('composer-stop-button')).toHaveCount(0);
    await expect.poll(async () => (await action(one, 'getRun', run.id)).status).toBe('cancelled');
    await testInfo.attach('device-a', { body: await one.screenshot(), contentType: 'image/png' });
    await testInfo.attach('device-b', { body: await two.screenshot(), contentType: 'image/png' });
    await action(one, 'deleteChat', chat.id);
    await expect.poll(async () => (await chats(two)).some((c: any) => c.id === chat.id)).toBe(false);
  } finally { await a.close(); await b.close(); }
});

test('email signup and recovery links return to the chat screen', async ({ page }) => {
  const email = `browser-${crypto.randomUUID()}@example.test`;
  const password = 'browser mango zebra telescope orchard';
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account / resend verification', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Open the link in this browser');
  await page.goto(await latestEmailLink());
  await expect(page).toHaveURL(/\/$/);
  await page.getByTestId('chat-top-bar').waitFor();
  await page.goto('/settings/account');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Forgot password?', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send recovery link', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Open the link in this browser');
  await page.goto(await latestEmailLink());
  await page.getByLabel('New password', { exact: true }).fill(password + 'new');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByTestId('chat-top-bar').waitFor();
  await expect(page.getByText('Page not found', { exact: true })).toHaveCount(0);
});

test('sign-in offers password, Google, Apple and email recovery', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Continue with Apple', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Forgot password?', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send recovery link', exact: true })).toBeVisible();
});

test('phone sign-in fits without scrolling at rest', async ({ page }) => {
  await page.setViewportSize({ width: 402, height: 874 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  for (const screen of ['login', 'register']) {
    if (screen === 'register') await page.getByRole('button', { name: 'Create account / resend verification', exact: true }).click();
    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollHeight - innerHeight, document.querySelector('main')!.scrollHeight - document.querySelector('main')!.clientHeight));
    expect(overflow, screen).toBeLessThanOrEqual(0);
  }
});
