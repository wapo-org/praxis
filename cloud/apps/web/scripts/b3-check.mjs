import { BASE, API } from './check-env.mjs';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch();
const base = BASE;
async function login(page, user) {
  page.setDefaultTimeout(15000);
  await page.goto(base);
  await page.getByRole('button', { name: 'Continue as local dev user' }).waitFor();
  await page.evaluate(async user => { const { apiClient } = await import('/src/lib/api.ts'); await (await import('/src/lib/dev-auth.ts')).devAuth(user); }, user);
  await page.reload(); await page.getByTestId('chat-top-bar').waitFor();
}
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page, `wp-b3-desktop-${Date.now()}`);
  await page.getByRole('complementary', { name: 'Conversation history' }).waitFor();
  assert.equal(await page.getByTestId('app-sidebar').isVisible(), true);
  assert.equal(new URL(page.url()).pathname, '/');
  const input = page.getByTestId('composer-input');
  await input.fill('Desktop keyboard check');
  await input.evaluate(n => n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })));
  assert.equal(new URL(page.url()).pathname, '/');
  await input.press('Shift+Enter');
  assert.equal(await input.inputValue(), 'Desktop keyboard check\n');
  await input.press('Enter'); await page.waitForURL('**/c/*');
  const chatPath = new URL(page.url()).pathname;
  await page.getByTestId('assistant-turn').first().waitFor();
  await page.reload(); await page.getByTestId('chat-top-bar').waitFor();
  await page.getByTestId('nav-chat-title-pill').getByText('Desktop keyboard check', { exact: true }).waitFor();
  const chatBounds = await page.getByTestId('composer-dock').boundingBox();
  assert(chatBounds.width <= 720); // 720 px column; the sidebar floats over the full-bleed layer
  const sidebarBounds = await page.getByTestId('app-sidebar').boundingBox();
  assert(sidebarBounds.x < 20 && sidebarBounds.y < 20); // floating: detached from the edges
  await page.getByTestId('nav-settings-button').click(); await page.waitForURL('**/settings');
  // Settings is a routed page now: no dialog chrome, content in the main area.
  const settings = page.getByTestId('settings-page'); await settings.waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Settings', exact: true }).count(), 0);
  const bounds = await settings.boundingBox(); assert(bounds.height <= 900); // full-bleed; content sits in the column beside the floating nav
  const heading = await settings.getByRole('heading', { level: 1 }).first().boundingBox(); assert(heading.width <= 720 && heading.x > sidebarBounds.x + sidebarBounds.width);
  await page.getByRole('button', { name: 'Models & providers', exact: true }).click(); await page.waitForURL('**/settings/providers');
  await page.getByRole('button', { name: 'Add provider', exact: true }).click(); await page.waitForURL('**/settings/providers/new');
  await page.reload(); await page.getByRole('heading', { name: 'Add provider', exact: true }).waitFor();
  assert.equal(await page.getByRole('switch').count(), 12);
  await page.goBack(); await page.getByRole('heading', { name: 'Models & providers', exact: true }).waitFor();
  await page.goForward(); await page.getByRole('heading', { name: 'Add provider', exact: true }).waitFor();
  // The editor shows Save, not Done; go back to the list, then Done returns to the chat.
  await page.goBack(); await page.waitForURL('**/settings/providers');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click(); await page.waitForURL('**/');
  const saved = await page.evaluate(async () => {
    const { apiClient } = await import('/src/lib/api.ts');
    return apiClient.createProvider({ name: 'Restored provider', flavor: 'openAIChat', baseUrl: 'https://example.invalid/v1', defaultModel: 'restored-model' });
  });
  await page.goto(`${base}/settings/providers/${saved.id}`);
  await page.getByRole('textbox', { name: 'Name', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Restored provider');
  await page.goto(`${base}/settings/providers/missing`); await page.getByText('Provider not found.', { exact: true }).waitFor();
  await page.goto(`${base}${chatPath}`); await page.getByTestId('chat-top-bar').waitFor();
  // WP-G3C: Meta-K opens the floating search and focuses it, independently of history.
  await page.keyboard.press('Meta+k');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Search conversations' && !!document.activeElement?.closest('[data-testid="search-palette"]'));
  assert.equal(await page.getByRole('dialog', { name: 'Chats', exact: true }).count(), 0);
  await page.keyboard.press('Escape'); await page.waitForURL(`**${chatPath}`);
  // Selecting a sidebar row must update the chat route.
  await page.getByTestId('sidebar-new-chat').click(); await page.waitForURL(`${base}/`);
  await page.locator('[data-testid="app-sidebar"] [data-sidebar-row-select]').filter({ hasText: 'Desktop keyboard check' }).click();
  await page.waitForURL(`**${chatPath}`);
  // Server-only results and cursor loading, beyond bootstrap's first model page.
  const template = await page.evaluate(async () => { const { apiClient } = await import('/src/lib/api.ts'); return (await apiClient.bootstrap()).models[0]; });
  const queries = [];
  await page.route('**/v1/models?**', async route => {
    const query = new URL(route.request().url()).searchParams; queries.push(Object.fromEntries(query));
    await route.fulfill({ json: { type: 'page', items: [{ ...template, id: query.has('cursor') ? 'cursor-result' : 'remote-result', displayName: query.has('cursor') ? 'Cursor model' : 'Beyond bootstrap', pinned: false, favorite: false }], nextCursor: query.has('cursor') ? null : 'next' } });
  });
  await page.getByTestId('composer-plus-button').click(); await page.getByTestId('tray-model-picker-trigger').click();
  await page.getByPlaceholder('Search models…').fill('remote');
  await page.getByRole('option', { name: /Beyond bootstrap/ }).waitFor();
  await page.getByRole('option', { name: 'Load more models', exact: true }).click();
  await page.getByRole('option', { name: /Cursor model/ }).waitFor();
  assert(queries.some(q => q.q === 'remote')); assert(queries.some(q => q.cursor === 'next'));
  await page.keyboard.press('Escape'); await page.getByRole('listbox', { name: 'Models' }).waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('tray-model-picker-trigger').getAttribute('aria-expanded'), 'false', 'Esc leaves the list and keeps the tray open');
  await page.keyboard.press('Escape'); await page.getByTestId('plus-tray').waitFor({ state: 'detached' });
  await page.getByTestId('sidebar-new-chat').click();
  await page.getByTestId('starter-chip-2').click();
  await page.getByRole('button', { name: 'Allow Once', exact: true }).waitFor();
  assert.equal(await page.getByTestId('assistant-turn').count(), 0, 'Pending run must have a single live activity disclosure');
  await page.getByRole('button', { name: 'Allow Once', exact: true }).click();
  const restoredChat = await page.evaluate(async () => {
    const { apiClient } = await import('/src/lib/api.ts'); const boot = await apiClient.bootstrap();
    return apiClient.createChat({ title: 'Route options', mode: 'plan', effort: 'high', modelId: boot.models[0].id, providerId: boot.models[0].providerId });
  });
  await page.goto(`${base}/c/${restoredChat.id}`); await page.getByTestId('nav-chat-title-pill').getByText('Route options', { exact: true }).waitFor();
  await page.getByTestId('composer-plus-button').click();
  assert.equal(await page.getByTestId('tray-mode-plan').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('group', { name: 'Reasoning effort' }).getByRole('button', { name: 'high', exact: true }).getAttribute('aria-pressed'), 'true');
  await context.close();
  const touch = await browser.newContext({ viewport: { width: 402, height: 874 }, colorScheme: 'dark', isMobile: true, hasTouch: true });
  const mobile = await touch.newPage(); await login(mobile, `wp-b3-touch-${Date.now()}`);
  assert.equal(await mobile.locator('[data-testid="app-sidebar"]').count(), 0);
  assert.equal(await mobile.locator('html').getAttribute('data-theme'), 'dark');
  const mobileInput = mobile.getByTestId('composer-input'); await mobileInput.fill('Touch newline'); await mobileInput.press('Enter');
  assert.equal(await mobileInput.inputValue(), 'Touch newline\n'); assert.equal(new URL(mobile.url()).pathname, '/');
  await touch.close();
  console.log('PASS: chat/settings deep links + reload + back/forward; floating sidebar + reading width + settings as a page; Enter/Shift+Enter/touch Return/IME; system dark default; single live activity; Meta-K/Esc; debounced server model search + pagination');
} finally { await browser.close(); }
