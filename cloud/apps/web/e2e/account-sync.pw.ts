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
    // Change each durable setting field on A, then observe B's applied account state. 'button' is the removed
    // button-colour option (WP-I1): an older client may still send it; it is accepted and ignored everywhere.
    for (const [field, value] of Object.entries({ theme: 'dark', palette: 'forest', button: '#b6e36b', model: 'sync-model', provider: 'sync-provider', effort: 'high' })) {
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
  await page.getByRole('link', { name: 'Create one', exact: true }).click();
  await expect(page.getByText('Create your Praxis account')).toBeVisible();
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

test('sign-in hierarchy: links switch screens, OAuth has logos, only the pressed button spins', async ({ page }) => {
  // Hold the dev sign-in request in the page (WebKit's page.route misses this POST) to see the in-flight state.
  await page.addInitScript({ content: `{
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/v1/auth/dev')) await new Promise(resolve => { window.__releaseDev = resolve; });
      return original(input, init);
    };
  }` });
  await page.goto('/');
  const dev = page.getByTestId('local-dev-sign-in');
  await expect(dev).toHaveText('Continue as local dev user');
  await expect(page.getByText('Dev only', { exact: true })).toBeVisible();
  // Secondary navigation is links, not buttons.
  for (const name of ['Forgot password?', 'Sign in with an email code', 'Create one']) {
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  // Order: fields, primary, "or", OAuth, footer.
  const top = async (l: ReturnType<Page['getByRole']>) => (await l.boundingBox())!.y;
  const signIn = page.getByRole('button', { name: 'Sign in', exact: true });
  const google = page.getByRole('button', { name: 'Continue with Google', exact: true });
  const apple = page.getByRole('button', { name: 'Continue with Apple', exact: true });
  expect(await top(page.getByLabel('Password', { exact: true }))).toBeLessThan(await top(signIn));
  expect(await top(signIn)).toBeLessThan(await top(page.getByRole('separator', { name: 'or' })));
  expect(await top(page.getByRole('separator', { name: 'or' }))).toBeLessThan(await top(google));
  expect(await top(apple)).toBeLessThan(await top(page.getByRole('link', { name: 'Create one' })));
  await expect(google.locator('svg[data-logo="google"]')).toHaveCount(1);
  await expect(apple.locator('svg[data-logo="apple"]')).toHaveCount(1);
  // Primary is ink-on-paper and differs from the neutral OAuth fill.
  const bg = (l: ReturnType<Page['getByRole']>) => l.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(await bg(signIn)).not.toBe(await bg(google));
  // Forgot password and email code switch the screen in place; the footer link returns.
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to sign in' }).click();
  await page.getByRole('link', { name: 'Sign in with an email code' }).click();
  await expect(page.getByRole('button', { name: 'Send code', exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to sign in' }).click();
  await page.getByRole('link', { name: 'Create one' }).click();
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Sign in to your Praxis server')).toBeVisible();
  // While signing in, only the pressed button spins; the others are disabled but stay legible.
  await page.getByLabel('Email', { exact: true }).fill('fake@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fake-password-123');
  await signIn.click();
  await page.waitForFunction(() => typeof (window as any).__releaseDev === 'function');
  await expect(signIn).toBeDisabled();
  await expect(signIn.locator('.rt-Spinner')).toHaveCount(1);
  await expect(google).toBeDisabled();
  await expect(google.locator('.rt-Spinner')).toHaveCount(0);
  await expect(dev.locator('.rt-Spinner')).toHaveCount(0);
  expect(Number(await google.evaluate(el => getComputedStyle(el).opacity))).toBeGreaterThanOrEqual(0.5);
  await page.evaluate(() => (window as any).__releaseDev());
  await page.getByTestId('chat-top-bar').waitFor();
});
test('phone sign-in fits without scrolling at rest', async ({ page }) => {
  await page.setViewportSize({ width: 402, height: 874 });
  await page.goto('/');
  await page.getByTestId('local-dev-sign-in').waitFor();
  for (const screen of ['login', 'register']) {
    if (screen === 'register') await page.getByRole('link', { name: 'Create one' }).click();
    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollHeight - innerHeight, document.querySelector('main')!.scrollHeight - document.querySelector('main')!.clientHeight));
    expect(overflow, screen).toBeLessThanOrEqual(0);
  }
});
