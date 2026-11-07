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
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('search-palette');
  const input = palette.getByRole('combobox');
  await input.fill('reasoning');
  await input.press('Enter');
  await expect(palette.getByRole('option', { name: 'high', exact: true })).toBeVisible();
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
  await page.keyboard.press('Meta+k');
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
