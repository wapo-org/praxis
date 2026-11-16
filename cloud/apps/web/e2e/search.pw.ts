import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /local dev user/i }).click();
  await page.getByTestId('chat-screen').waitFor();
});
test('narrow History never focuses an input; explicit Search keeps focus after History exits', async ({ page }) => {
  await page.setViewportSize({ width: 402, height: 874 });
  await expect(page.locator('[data-testid="app-sidebar"]:not([data-variant="panel"])')).toHaveCount(0);
  await page.getByTestId('nav-history-button').click();
  await expect(page.getByTestId('app-sidebar')).toBeVisible();
  await expect(page.locator('input:focus,textarea:focus')).toHaveCount(0);
  await page.getByRole('button', { name: 'Search conversations', exact: true }).click();
  const input = page.getByTestId('search-palette').getByRole('combobox');
  await expect(page.getByTestId('app-sidebar')).toHaveCount(0);
  await expect(input).toBeFocused();
  const bounds = await page.getByTestId('search-palette').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(402);
  await input.press('Escape');
  await expect(page.getByTestId('search-palette')).toHaveCount(0);
});
test('command options stay in one panel, support filtering and back, and close on outside click', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('search-palette');
  const input = palette.getByRole('combobox');
  await input.fill('reasoning');
  await input.press('Enter');
  await expect(palette.getByRole('option', { name: 'High', exact: true })).toBeVisible();
  await input.fill('hi');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await input.fill('');
  await input.press('Backspace');
  await expect(input).toHaveAttribute('placeholder', 'Search chats and actions');
  await input.fill('Change model');
  await input.press('Enter');
  await expect(palette.getByRole('option').first()).toBeVisible();
  await input.press('Escape');
  await expect(input).toHaveAttribute('placeholder', 'Search chats and actions');
  await input.press('Tab');
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(input).toBeFocused();
  await page.mouse.click(1100, 700);
  await expect(palette).toHaveCount(0);
});
test('debounces, ignores stale network results, emphasizes Unicode, and clears rows immediately', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(r => { release = r; });
  await page.route('**/v1/search?**', async route => {
    const q = new URL(route.request().url()).searchParams.get('q');
    if (q === 'old') await pending;
    await route.fulfill({ json: { type: 'page', items: [{ chat: { id: q, title: `${q} title` }, snippet: `Context ${q} match` }], nextCursor: null } });
  });
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('search-palette');
  const input = palette.getByRole('combobox');
  const requested = page.waitForRequest('**/v1/search?q=old&*');
  await input.fill('old');
  await requested;
  await input.fill('Привет');
  await expect(palette.getByRole('option')).toContainText('Привет title');
  release();
  await expect(palette.locator('strong').first()).toHaveText('Привет');
  await expect(palette.getByRole('option')).not.toContainText('old title');
  await input.fill('');
  await expect(palette.getByRole('option')).toHaveCount(0);
});
test('the last option keeps the panel inset below it, at rest and scrolled to the end', async ({ page }) => {
  await page.route('**/v1/search?**', route => route.fulfill({ json: { type: 'page', nextCursor: null,
    items: Array.from({ length: 24 }, (_, i) => ({ chat: { id: `pad-${i}`, title: `Padding ${i}` }, snippet: `Context ${i}` })) } }));
  for (const query of ['Padding', 'Padding 1']) {
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByTestId('search-palette');
    await palette.getByRole('combobox').fill(query);
    const last = palette.getByRole('option').last();
    await expect(last).toBeVisible();
    await page.waitForTimeout(500); // the reveal spring
    const listbox = palette.getByRole('listbox');
    await listbox.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const gap = await listbox.evaluate(el => {
      const surface = el.closest('.praxis-glass-surface')!.getBoundingClientRect();
      const options = el.querySelectorAll('[role="option"]');
      return surface.bottom - options[options.length - 1]!.getBoundingClientRect().bottom;
    });
    // 8 px: the same inset the bar has from the panel's top (one row's worth less would sit on the edge).
    expect(gap).toBeGreaterThanOrEqual(7.5);
    expect(gap).toBeLessThanOrEqual(9.5);
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
  }
});
test('search is semantic: chats are found by meaning through the local API', async ({ page }) => {
  for (const [title, text] of [['Trip packing list', 'Packing list for 3 days in Lisbon'], ['Regex help', 'Match a date like 2026-11-07']] as const) {
    const chat = await (await page.request.post('/v1/chats', { data: { type: 'chat.input', title } })).json();
    await page.request.post('/v1/runs', { data: { type: 'run.start', chatId: chat.id, text } });
  }
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('search-palette');
  const input = palette.getByRole('combobox');
  for (const [query, title] of [['how to pack for a trip', 'Trip packing list'], ['date regex', 'Regex help']] as const) {
    await input.fill(query);
    await expect(palette.getByRole('option').first()).toContainText(title, { timeout: 10000 });
  }
});
test('with no input the panel is just the bar: no extra inset below it (WP-I1)', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('search-palette');
  const input = palette.getByRole('combobox');
  await expect(input).toBeFocused();
  await page.waitForTimeout(400);
  const measure = () => palette.evaluate((el) => {
    const surface = el.querySelector('.praxis-glass-surface')!.getBoundingClientRect();
    const field = el.querySelector('input')!.getBoundingClientRect();
    return { top: field.top - surface.top, bottom: surface.bottom - field.bottom };
  });
  const empty = await measure();
  // The field sits in the middle of the bar: the same inset above and below it.
  expect(Math.abs(empty.top - empty.bottom)).toBeLessThanOrEqual(0.5);
  // And after typing and clearing, it returns to exactly that.
  await input.fill('Change model');
  await expect(palette.getByRole('option').first()).toBeVisible();
  await input.fill('');
  await page.waitForTimeout(500);
  const cleared = await measure();
  expect(Math.abs(cleared.bottom - empty.bottom)).toBeLessThanOrEqual(0.5);
});
test('choosing a chat closes the panel at once, even while its messages are still loading (WP-I1)', async ({ page }) => {
  await page.route('**/v1/search?**', (route) => route.fulfill({ json: { type: 'page', nextCursor: null,
    items: [{ chat: { id: 'welcome', title: 'Welcome to Praxis Cloud' }, snippet: 'Welcome' }] } }));
  let release!: () => void;
  const slow = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const requested = new Promise<void>(resolve => {entered = resolve;});
  let responded = false;
  await page.route('**/v1/chats/welcome/messages**', async route => {
    entered();
    await slow;
    await route.continue();
    responded = true;
  });
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('search-palette');
  await palette.getByRole('combobox').fill('Welcome');
  const option = palette.getByRole('option', { name: /Welcome to Praxis Cloud/ });
  await option.waitFor();
  try {
    await option.click();
    await requested;
    await expect(palette).toHaveCount(0);
    expect(responded).toBe(false);
  } finally {
    release();
  }
  await expect(page).toHaveURL(/\/c\/welcome$/);
});
test('the panel has the dropdowns\' material and subtle rim, light and dark (WP-I1)', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByTestId('search-palette');
    const rim = palette.locator('[data-search-rim]');
    const look = await rim.evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.boxShadow = 'inset 0 0 0 1px var(--glass-morph-rim), inset 0 0 0 2px var(--glass-morph-rim-light)';
      document.body.append(probe);
      const expected = getComputedStyle(probe).boxShadow;
      probe.remove();
      const surface = el.closest<HTMLElement>('.praxis-glass-surface')!;
      return { shadow: getComputedStyle(el).boxShadow, expected, radius: getComputedStyle(el).borderTopLeftRadius, surfaceRadius: getComputedStyle(surface).borderTopLeftRadius,
        tint: getComputedStyle(surface).getPropertyValue('--glass-tint').trim(), menuTint: getComputedStyle(document.documentElement).getPropertyValue('--glass-menu-tint').trim() };
    });
    expect(look.shadow).toBe(look.expected);
    expect(look.radius).toBe(look.surfaceRadius);
    expect(look.tint).toBe(look.menuTint);
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
  }
});
