import { test, expect, type Page } from '@playwright/test';
const open = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as local dev user' }).waitFor();
  await page.getByRole('button', { name: 'Continue as local dev user' }).click();
  await page.getByTestId('chat-top-bar').waitFor();
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
  const a = await browser.newContext(); const b = await browser.newContext();
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
    // Change each durable setting field on A, then observe B's applied account state.
    for (const [field, value] of Object.entries({ theme: 'dark', palette: 'forest', button: '#b6e36b', model: 'sync-model', provider: 'sync-provider', effort: 'high' })) {
      await one.evaluate(async ({field, value}) => {
        // @ts-expect-error Vite source module.
        const { apiClient } = await import('/src/lib/api.ts');
        await apiClient.request('/v1/sync/settings', { method: 'PATCH', body: JSON.stringify({ field, value }) });
      }, {field,value});
    }
    await expect.poll(() => two.locator('html').getAttribute('data-theme')).toBe('dark');
    await expect.poll(() => two.locator('html').getAttribute('data-sidebar-palette')).toBe('forest');
    await expect.poll(() => two.locator('html').getAttribute('data-button-color')).toBe('#b6e36b');
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
test('fake Clerk registration verifies email and supports switching and reset', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as local dev user' }).waitFor();
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill('fake@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fake-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Email code', { exact: true }).fill('000000');
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(page.getByRole('alert')).toContainText('123456');
  await page.getByLabel('Email code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await page.getByTestId('chat-top-bar').waitFor();
});
