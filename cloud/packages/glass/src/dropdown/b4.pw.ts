import { expect, test, type Locator, type Page } from '@playwright/test';
test.use({ hasTouch: true });
test.beforeEach(async ({ page }) => {
  expect((await page.request.post('/v1/auth/dev', { data: { type: 'auth.dev', userId: 'b4-check' } })).ok()).toBeTruthy();
  await page.goto('/lab/glass?dropdown');
  await page.getByTestId('position-top-start').waitFor();
  await page.evaluate(() => document.fonts.ready);
});
/** Geometry is only meaningful once the glass has landed: the morph leaves nothing inline at rest. */
async function landed(menu: Locator) {
  await expect.poll(() => menu.evaluate((el: HTMLElement) => el.style.transform)).toBe('');
}
async function scrollable(menu: Locator) {
  await landed(menu);
  return menu.evaluate(el => {
    const nodes = [el, ...el.querySelectorAll('[data-slot="scroll-blur-viewport"]')];
    const node = nodes.find(n => !n.closest('[inert]') && n.scrollHeight > n.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(n).overflowY));
    if (!node) throw Error('Expected a scrollable menu viewport');
    node.setAttribute('data-b4-scroll', '');
  });
}
async function syntheticPan(page: Page, menu: Locator) {
  await scrollable(menu);
  const scroller = page.locator('[data-b4-scroll]');
  const box = await scroller.boundingBox();
  const point = { pointerType: 'touch', pointerId: 17, clientX: box!.x + 20, clientY: box!.y + 80 };
  await scroller.dispatchEvent('pointerdown', point);
  await scroller.dispatchEvent('pointermove', { ...point, clientY: point.clientY - 40 });
  await scroller.evaluate(el => { el.scrollTop += 80; });
  await scroller.dispatchEvent('pointercancel', point);
  await scroller.dispatchEvent('pointerup', point);
  await expect(menu).toBeVisible();
  expect(await scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
}
test('touch pans and pointercancel preserve the model picker and scrolling submenu on both engines', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); // Isolate native pan/cancel from geometry animation, checked separately.
  await page.getByTestId('position-models').click();
  const modelMenu = page.locator('.praxis-glass-dropdown-content');
  await syntheticPan(page, modelMenu);
  await expect(page.getByTestId('position-models')).toHaveText('Model 001');
  await page.keyboard.press('Escape');
  await expect(modelMenu).toHaveCount(0);
  await page.getByTestId('position-middle-end').evaluate(el => { for (let node = el.parentElement; node; node = node.parentElement) node.scrollTop = 0; });
  await page.getByTestId('position-middle-end').click();
  await page.getByRole('menuitem', { name: 'Recent chats', exact: true }).click();
  const menu = page.getByRole('menu');
  await syntheticPan(page, menu);
  await expect(page.getByRole('menuitem', { name: 'Recent chats', exact: true })).toHaveAttribute('aria-expanded', 'true');
});
test('real Chromium touch pan scrolls models without selecting or dismissing', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP native touch input is Chromium-only; WebKit pointer-cancel path is checked separately.');
  await page.getByTestId('position-models').click();
  const menu = page.locator('.praxis-glass-dropdown-content');
  await scrollable(menu);
  const scroller = page.locator('[data-b4-scroll]');
  const box = await scroller.boundingBox();
  const cdp = await context.newCDPSession(page);
  const x = box!.x + 25, y = box!.y + box!.height - 35;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 15 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(menu).toBeVisible();
  await expect(async () => expect(await scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(20)).toPass();
  await expect(page.getByTestId('position-models')).toHaveText('Model 001');
});
test('action grid corners, transparent tiles, native geometry and Math Results subtitle at both widths', async ({ page }) => {
  for (const width of [402, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByTestId('position-top-start').click();
    const menu = page.getByRole('menu');
    const grid = menu.locator('[data-slot="dropdown-action-grid"]');
    await expect(grid).toHaveCSS('overflow', 'hidden');
    await expect(grid).toHaveCSS('border-top-left-radius', '42px');
    await expect(grid).toHaveCSS('border-top-right-radius', '42px');
    await expect(grid).toHaveCSS('column-gap', '4px');
    for (const tile of await grid.getByRole('menuitem').all()) {
      await expect(tile).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(tile).toHaveCSS('border-radius','18px');
      await expect(tile).not.toHaveAttribute('data-highlighted', 'true');
    }
    const math = menu.getByRole('menuitem', { name: 'Math Results Suggest Results', exact: true });
    await expect(math).toHaveCSS('font-size', '14px');
    await expect(async () => expect((await menu.boundingBox())!.width).toBeCloseTo(240, 0)).toPass();
    const move = menu.getByRole('menuitem', { name: 'Move Note' }); expect(Math.round((await move.boundingBox())!.height)).toBeGreaterThanOrEqual(40);
    await page.keyboard.press('Escape');
  }
});
test('Esc and ArrowLeft restore the popped SubTrigger; tiles navigate horizontally; Tab leaves relative to trigger', async ({ page }) => {
  const trigger = page.getByTestId('position-top-start');
  await trigger.focus(); await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Scan', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight'); await expect(page.getByRole('menuitem', { name: 'Pin Note', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft'); await expect(page.getByRole('menuitem', { name: 'Scan', exact: true })).toBeFocused();
  for (const key of ['Escape', 'ArrowLeft']) {
    const recent = page.getByRole('menuitem', { name: 'Recent chats', exact: true });
    await recent.focus(); await page.keyboard.press('ArrowRight');
    const child = page.getByRole('menuitem').filter({ hasText: 'Design review' });
    await child.focus(); await page.keyboard.press(key);
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Recent chats', exact: true })).toBeFocused();
    await expect(page.getByRole('menuitem', { name: 'Recent chats', exact: true })).toHaveAttribute('aria-expanded', 'false');
  }
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('position-top-center')).toBeFocused();
  await expect(page.getByRole('menu')).toHaveCount(0);
});
test('plain morph header, centered preview icons and staggered children respect reduced motion', async ({ page }) => {
  await page.getByTestId('position-top-start').click();
  const [frames] = await Promise.all([
    page.evaluate(async () => {
      const frames: number[][] = [];
      for (let frame = 0; frame < 180 && frames.length < 24; frame++) {
        await new Promise(requestAnimationFrame);
        const rows = [...document.querySelectorAll('[data-dropdown-panel="recent"] [data-dropdown-child]')];
        if (rows.length) frames.push(rows.map(row => Number(getComputedStyle(row).opacity)));
      }
      return frames;
    }),
    page.getByRole('menuitem', { name: 'Recent chats', exact: true }).click(),
  ]);
  expect(frames.some(values => values[0]! > values.at(-1)! + .02)).toBeTruthy();
  const header = page.locator('[data-dropdown-morph-header]');
  await expect(header).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.getByRole('separator')).toHaveCSS('margin-left', '16px');
  const child = page.getByRole('menuitem').filter({ hasText: 'Design review' });
  await expect(child).toHaveCSS('align-items', 'center');
  expect(await page.locator('[data-dropdown-panel="recent"] [data-slot="dropdown-separator"]').count()).toBe(0);
  const identity = await header.evaluate(el => ({ row: el.getAttribute('data-framer-name'), independent: el.querySelector('[data-submenu-chevron]')?.getAttribute('data-projection-id') }));
  expect(identity.independent).toBeNull();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByTestId('position-top-start').click(); await page.getByRole('menuitem', { name: 'Recent chats', exact: true }).click();
  await expect(page.locator('[data-dropdown-panel="recent"] [data-dropdown-child]').last()).toHaveCSS('opacity', '1');
});
test('a mouse drag past the edge stretches the glass and cancellation springs it back without dismissal', async ({ page }) => {
  await page.getByTestId('position-top-start').click();
  const menu = page.getByRole('menu'); await landed(menu);
  const surface = menu.locator('[data-glass-surface]').first(); const rest = (await surface.boundingBox())!;
  await page.mouse.move(rest.x + rest.width - 3, rest.y + 20); await page.mouse.down();
  // Inside it scrubs, and the glass rests.
  await page.mouse.move(rest.x + rest.width - 35, rest.y + 60, { steps: 6 });
  expect(Math.abs((await surface.boundingBox())!.height - rest.height)).toBeLessThanOrEqual(1);
  // Past the bottom edge it stretches toward the pointer; the top stays.
  await page.mouse.move(rest.x + rest.width - 35, rest.y + rest.height + 80, { steps: 8 });
  await expect(async () => expect((await surface.boundingBox())!.height).toBeGreaterThan(rest.height + 5)).toPass();
  expect(Math.abs((await surface.boundingBox())!.y - rest.y)).toBeLessThanOrEqual(1);
  await menu.dispatchEvent('pointercancel', { pointerType: 'mouse', pointerId: 1 }); await page.mouse.up();
  await expect(menu).toBeVisible();
  await expect(async () => expect(Math.abs((await surface.boundingBox())!.height - rest.height)).toBeLessThan(1)).toPass();
});
test('full lab fits 402 px, keeps position triggers in their own section and menu in viewport', async ({ page }) => {
  await page.goto('/lab/glass');
  const main = page.locator('.glass-lab-main'); await expect(main).toBeVisible(); await page.evaluate(() => document.fonts.ready); const box = await main.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.width).toBeLessThanOrEqual(402);
  expect(await page.getByTestId('glass-lab-page').evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(402);
  const positions = page.getByRole('region', { name: 'Dropdown positioning lab' });
  const before = await positions.boundingBox(); const header = await page.locator('.glass-lab-header').boundingBox();
  expect(before!.y).toBeGreaterThan(header!.y + header!.height);
  const trigger = page.getByTestId('motion-preview-trigger'); await trigger.scrollIntoViewIfNeeded(); await trigger.click();
  await expect(page.getByRole('menu')).toBeInViewport({ ratio: 1 });
});
