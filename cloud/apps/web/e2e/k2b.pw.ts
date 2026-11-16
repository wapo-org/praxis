import { test, expect, type Page } from '@playwright/test';
test.use({ serviceWorkers: 'block' });

const now = '2026-11-11T00:00:00.000Z';
const caps = { type: 'capabilities', tools: true, vision: false, reasoningEffort: false, serverWebSearch: false };
const PROVIDER = { type: 'provider', id: 'k2b-router', name: 'K2b Router', flavor: 'openAIChat', baseUrl: 'https://router.invalid/v1', maskedKey: '••••', capabilities: caps, updatedAt: now };
const model = (id: string, displayName: string) => ({ type: 'model', id, providerId: PROVIDER.id, displayName, capabilities: caps, reasoningEfforts: [], pinned: false, favorite: false });
const MODELS = [model('k2b-muse', 'K2b Muse'), model('k2b-lumen', 'K2b Lumen')];

async function withRouter(page: Page) {
  await page.route('**/v1/bootstrap*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.providers = [...(body.providers ?? []).filter((p: { id: string }) => p.id !== PROVIDER.id), PROVIDER];
    body.models = [...(body.models ?? []).filter((m: { providerId: string }) => m.providerId !== PROVIDER.id), ...MODELS];
    await route.fulfill({ response, json: body });
  });
  await page.route('**/v1/providers*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    if (Array.isArray(body.items)) body.items = [...body.items.filter((p: { id: string }) => p.id !== PROVIDER.id), PROVIDER];
    await route.fulfill({ response, json: body });
  });
  await page.route('**/v1/models*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const q = (new URL(route.request().url()).searchParams.get('q') ?? '').toLowerCase();
    const extra = MODELS.filter((m) => `${m.displayName} ${m.id}`.toLowerCase().includes(q));
    if (Array.isArray(body.items)) body.items = [...extra, ...body.items.filter((m: { providerId: string }) => m.providerId !== PROVIDER.id)];
    await route.fulfill({ response, json: body });
  });
}

async function signIn(page: Page, path = '/') {
  await page.goto(path);
  const dev = page.getByRole('button', { name: 'Continue as local dev user' });
  await Promise.race([dev.waitFor(), page.getByTestId('chat-top-bar').waitFor()]);
  if (await dev.isVisible().catch(() => false)) await dev.click();
  await page.getByTestId('chat-top-bar').waitFor();
}

const headerModel = (page: Page) => page.getByTestId('nav-chat-title-pill').locator('span').last();

async function pick(page: Page, name: string) {
  await page.getByTestId('composer-plus-button').click();
  await page.getByTestId('tray-model-picker-trigger').click();
  await page.getByRole('option', { name: new RegExp(name) }).first().click();
  await page.keyboard.press('Escape');
}

/** The selection holds: checked repeatedly over `ms`, not once. */
async function holds(page: Page, name: string, ms = 2000) {
  await expect(headerModel(page)).toHaveText(name);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    expect(await headerModel(page).textContent()).toBe(name);
    await page.waitForTimeout(100);
  }
}

async function scriptedChat(page: Page, title: string) {
  return page.evaluate(async (title) => {
    // @ts-expect-error Vite source import.
    const { apiClient } = await import('/src/lib/api.ts');
    const chat = await apiClient.createChat({ title, providerId: 'scripted', modelId: 'scripted' });
    return chat.id as string;
  }, title);
}

test('a model picked in a new chat stays picked', async ({ page }) => {
  await withRouter(page);
  await signIn(page);
  await page.getByTestId('nav-new-chat-desktop').click();
  await pick(page, 'K2b Muse');
  await holds(page, 'K2b Muse');
  // Opening the picker again (which loads models) does not undo it either.
  await page.getByTestId('composer-plus-button').click();
  await page.getByTestId('tray-model-picker-trigger').click();
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await holds(page, 'K2b Muse', 1000);
});

test('a model picked in an existing chat stays picked while the save is slow', async ({ page }) => {
  await withRouter(page);
  await signIn(page);
  const id = await scriptedChat(page, 'Slow save');
  await page.goto(`/c/${id}`);
  await expect(headerModel(page)).toHaveText(/Scripted/);
  let saved = false;
  await page.route(`**/v1/chats/${id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
    saved = true;
  });
  await pick(page, 'K2b Muse');
  await holds(page, 'K2b Muse', 3000);
  expect(saved).toBe(true);
  await holds(page, 'K2b Muse', 800);
});

test('a failed save shows an error and does not silently revert', async ({ page }) => {
  await withRouter(page);
  await signIn(page);
  const id = await scriptedChat(page, 'Failing save');
  await page.goto(`/c/${id}`);
  await expect(headerModel(page)).toHaveText(/Scripted/);
  await page.route(`**/v1/chats/${id}`, (route) =>
    route.request().method() === 'PATCH' ? route.fulfill({ status: 500, json: { type: 'error', code: 'internal', message: 'Database unavailable' } }) : route.continue(),
  );
  await pick(page, 'K2b Muse');
  const alert = page.getByRole('alert').filter({ hasText: /model/i });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Database unavailable');
  await holds(page, 'K2b Muse', 1500);
});

test('reload keeps the selection, in an existing chat and in a new one', async ({ page }) => {
  await withRouter(page);
  await signIn(page);
  const id = await scriptedChat(page, 'Reload keeps');
  await page.goto(`/c/${id}`);
  await pick(page, 'K2b Lumen');
  await holds(page, 'K2b Lumen', 800);
  await page.reload();
  await page.getByTestId('chat-top-bar').waitFor();
  await holds(page, 'K2b Lumen');
  await page.getByTestId('nav-new-chat-desktop').click();
  await pick(page, 'K2b Muse');
  await holds(page, 'K2b Muse', 800);
  await page.reload();
  await page.getByTestId('chat-top-bar').waitFor();
  await holds(page, 'K2b Muse');
});
