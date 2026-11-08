import { expect, test } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  await page.request.post('/v1/auth/dev', {
    data: { type: 'auth.dev', userId: 'g4b-check-' + Date.now() },
  });
  await page.goto('/');
  await page.getByTestId('sidebar-new-chat').waitFor();
  await page.evaluate(() => document.fonts.ready);
});
const PALETTES = [
  ['Graphite', 'rgb(22, 24, 27)', 'rgb(61, 65, 71)', 'rgb(242, 241, 237)'],
  ['Midnight', 'rgb(16, 28, 51)', 'rgb(47, 69, 112)', 'rgb(242, 241, 237)'],
  ['Forest', 'rgb(18, 38, 29)', 'rgb(47, 90, 69)', 'rgb(242, 241, 237)'],
  ['Plum', 'rgb(38, 21, 48)', 'rgb(90, 58, 107)', 'rgb(242, 241, 237)'],
  ['Sand', 'rgb(233, 228, 216)', 'rgb(207, 200, 182)', 'rgb(28, 28, 28)'],
  ['Paper', 'rgb(251, 251, 249)', 'rgb(217, 217, 224)', 'rgb(28, 28, 28)'],
] as const;
const solid = (page: import('@playwright/test').Page) =>
  page.locator('[data-testid="app-sidebar"] [data-glass-solid]').first();
test('the sidebar is the owner\'s opaque slab, identical in both themes, with the source metrics', async ({
  page,
}) => {
  const looks: unknown[] = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const sidebar = page.getByTestId('app-sidebar');
    const box = (await sidebar.boundingBox())!;
    expect(box.width).toBe(232);
    expect(box.x).toBe(12);
    expect(box.y).toBe(18);
    expect(box.height).toBe(858);
    // No lens, no backdrop: one solid layer with grad(base), the palette border and the inset highlight.
    expect(await sidebar.locator('[data-glass-surface]').first().getAttribute('data-glass-surface')).toBe('solid');
    await expect(sidebar.locator('[data-glass-lens], filter')).toHaveCount(0);
    const layer = await solid(page).evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        image: s.backgroundImage,
        color: s.backgroundColor,
        border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
        shadow: s.boxShadow,
        radius: s.borderTopLeftRadius,
        corner: s.getPropertyValue('corner-shape'),
        backdrop: s.backdropFilter,
      };
    });
    // The source paints the gloss twice: its literal gradient, then sbBg = grad(base).
    const gloss =
      'linear-gradient(rgba(255, 255, 255, 0.2) 0%, rgba(255, 255, 255, 0.12) 2%, rgba(255, 255, 255, 0.06) 5%, rgba(255, 255, 255, 0.02) 9%, rgba(0, 0, 0, 0) 14%, rgba(0, 0, 0, 0.12) 100%)';
    expect(layer.image).toBe(`${gloss}, ${gloss}, none`); // then the base colour layer
    expect(layer.color).toBe('rgb(22, 24, 27)');
    expect(layer.border).toBe('1px solid rgb(61, 65, 71)');
    expect(layer.shadow).toBe('rgba(255, 255, 255, 0.3) 0px 1px 2px 0px inset');
    expect(layer.radius).toBe('29px');
    expect(layer.backdrop).toBe('none');
    looks.push(layer);
    const pill = page.getByTestId('sidebar-new-chat');
    await expect(pill).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(pill).toHaveCSS('color', 'rgb(28, 28, 28)');
    await expect(pill).toHaveCSS('height', '34px');
    await expect(pill).toHaveCSS('font-size', '13px');
    await expect(pill).toHaveCSS('font-weight', '500');
    await expect(page.getByTestId('sidebar-toggle')).toHaveCSS('width', '34px');
    await expect(page.getByTestId('sidebar-toggle')).toHaveCSS('color', 'rgb(181, 180, 176)');
    const pillBox = (await pill.boundingBox())!;
    expect(pillBox.x).toBe(12 + 1 + 8 + 4);
    expect(pillBox.y).toBe(18 + 1 + 12);
    const search = page.getByRole('button', { name: 'Search conversations' });
    await expect(search).toHaveCSS('height', '32px');
    expect((await search.boundingBox())!.y).toBe(pillBox.y + 34 + 10);
    await expect(search.locator('svg')).toHaveCSS('color', 'rgb(242, 241, 237)');
    await expect(sidebar.locator('h2').first()).toHaveCSS('font-size', '10px');
    await expect(sidebar.locator('h2').first()).toHaveCSS('color', 'rgb(181, 180, 176)');
    await expect(sidebar.locator('[data-sidebar-row]').first()).toHaveCSS('height', '31px');
    await expect(sidebar.locator('[data-sidebar-row-select]').first()).toHaveCSS('color', 'rgb(242, 241, 237)');
    await expect(sidebar.locator('footer')).toHaveCSS('border-top-color', 'rgba(255, 255, 255, 0.1)');
  }
  expect(looks[0]).toEqual(looks[1]);
});
test('settings Back is the same pill in the same position as New chat', async ({ page }) => {
  const pill = page.getByTestId('sidebar-new-chat');
  const before = (await pill.boundingBox())!;
  const cls = await pill.getAttribute('class');
  await page.getByTestId('sidebar-account').click();
  const back = page.getByTestId('settings-back');
  await expect(back).toBeVisible();
  expect(await back.getAttribute('class')).toBe(cls);
  const after = (await back.boundingBox())!;
  expect(after).toEqual(before);
  await back.click();
  await expect(page.getByTestId('sidebar-new-chat')).toBeVisible();
});
test('the six sidebar palettes and the button colours apply live, persist, and are there before first paint', async ({
  page,
}) => {
  await page.goto('/settings/general');
  const look = page.getByTestId('sidebar-look');
  const palettes = look.getByRole('radiogroup', { name: 'Sidebar palette' });
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    for (const [name, base, border, ink] of PALETTES) {
      const radio = palettes.getByRole('radio', { name, exact: true });
      await radio.click();
      await expect(radio).toHaveAttribute('aria-checked', 'true');
      await expect(solid(page)).toHaveCSS('background-color', base);
      await expect(solid(page)).toHaveCSS('border-top-color', border);
      await expect(page.locator('[data-testid="app-sidebar"] [aria-current="page"]').first()).toHaveCSS('color', ink);
    }
  }
  const buttons = look.getByRole('radiogroup', { name: 'Button color' });
  for (const [name, fill, ink] of [
    ['White', 'rgb(255, 255, 255)', 'rgb(28, 28, 28)'],
    ['Cyan', 'rgb(121, 224, 248)', 'rgb(16, 36, 45)'],
    ['Navy', 'rgb(29, 64, 86)', 'rgb(255, 255, 255)'],
    ['Gray', 'rgb(141, 141, 153)', 'rgb(16, 36, 45)'],
    ['Graphite', 'rgb(43, 46, 51)', 'rgb(255, 255, 255)'],
    ['Coral', 'rgb(244, 132, 107)', 'rgb(16, 36, 45)'],
    ['Lime', 'rgb(182, 227, 107)', 'rgb(16, 36, 45)'],
  ] as const) {
    await buttons.getByRole('radio', { name, exact: true }).click();
    // In Settings the shared pill is Back.
    await expect(page.getByTestId('settings-back')).toHaveCSS('background-color', fill);
    await expect(page.getByTestId('settings-back')).toHaveCSS('color', ink);
  }
  await page.getByTestId('button-color-custom').fill('#123abc');
  await expect(page.getByTestId('settings-back')).toHaveCSS('background-color', 'rgb(18, 58, 188)');
  await expect(buttons.getByRole('radio', { checked: true })).toHaveCount(0);
  const midnight = palettes.getByRole('radio', { name: 'Midnight', exact: true });
  await midnight.click();
  await midnight.focus();
  await page.keyboard.press('ArrowRight');
  await expect(palettes.getByRole('radio', { name: 'Forest', exact: true })).toBeFocused();
  await expect(solid(page)).toHaveCSS('border-top-color', 'rgb(47, 90, 69)');
  await page.addInitScript(() => {
    const w = window as unknown as { firstLook?: string };
    new MutationObserver(() => {
      if (!w.firstLook && document.querySelector('button'))
        w.firstLook = `${document.documentElement.dataset.sidebarPalette} ${getComputedStyle(document.documentElement).getPropertyValue('--nb-fill')}`;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  await expect(palettes.getByRole('radio', { name: 'Forest', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => (window as unknown as { firstLook: string }).firstLook)).toBe('forest #123abc');
  await expect(page.getByTestId('settings-back')).toHaveCSS('background-color', 'rgb(18, 58, 188)');
  await buttons.getByRole('radio', { name: 'White', exact: true }).click();
  await palettes.getByRole('radio', { name: 'Graphite', exact: true }).click();
});
test('the generic accent is gone: app controls keep their own ink, not a sidebar palette', async ({ page }) => {
  await page.goto('/settings/general');
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  const palettes = page.getByTestId('sidebar-look').getByRole('radiogroup', { name: 'Sidebar palette' });
  await palettes.getByRole('radio', { name: 'Plum', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.accent)).toBeUndefined();
  const chat = await (
    await page.request.post('/v1/chats', { data: { type: 'chat.input', title: 'Accent gone' } })
  ).json();
  await page.goto('/c/' + chat.id);
  await page.getByTestId('composer-input').fill('A message');
  await expect(page.getByTestId('composer-send-button')).toHaveCSS('background-color', 'rgb(21, 20, 15)');
  await page.goto('/settings/general');
  await palettes.getByRole('radio', { name: 'Graphite', exact: true }).click();
});
test('pinned rows show exactly one aligned trailing control, including menu-open and selected states', async ({
  page,
}) => {
  const chat = await (
    await page.request.post('/v1/chats', {
      data: { type: 'chat.input', title: 'Pinned alignment', pinned: true },
    })
  ).json();
  await page.goto('/c/' + chat.id);
  const row = page.locator('[data-sidebar-row]').filter({ hasText: 'Pinned alignment' });
  await row.waitFor();
  const pin = row.getByLabel('Pinned', { exact: true });
  const action = row.getByRole('button', { name: 'Actions for Pinned alignment', exact: true });
  await page.mouse.move(900, 800);
  await page.getByTestId('composer-input').focus();
  await expect(pin).toBeVisible();
  await expect(action).not.toBeVisible();
  const pinBox = (await pin.boundingBox())!;
  await row.hover();
  await expect(pin).not.toBeVisible();
  await expect(action).toBeVisible();
  const actionBox = (await action.boundingBox())!;
  expect(Math.abs(pinBox.x + pinBox.width / 2 - actionBox.x - actionBox.width / 2)).toBeLessThan(
    0.5,
  );
  expect(Math.abs(pinBox.y + pinBox.height / 2 - actionBox.y - actionBox.height / 2)).toBeLessThan(
    0.5,
  );
  await action.click();
  await page.getByRole('menu').waitFor();
  await page.mouse.move(900, 800);
  await expect(pin).not.toBeVisible();
  await expect(action).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('composer-input').focus();
  await expect(pin).toBeVisible();
  await expect(action).not.toBeVisible();
});
test('argument-free approvals have no empty box and questions use a human label', async ({
  page,
}) => {
  const chat = await (
    await page.request.post('/v1/chats', { data: { type: 'chat.input', title: 'Card labels' } })
  ).json();
  await page.goto('/c/' + chat.id);
  await page.request.post('/v1/runs', {
    data: { type: 'run.start', chatId: chat.id, text: 'Review a write', script: 'approval' },
  });
  const allow = page.getByTestId('approval-allow-once');
  await allow.waitFor();
  await expect(page.locator('[data-testid^=approval-card] pre')).toHaveCount(0);
  await allow.click();
  await expect(page.getByTestId('composer-stop-button')).toHaveCount(0);
  await page.request.post('/v1/runs', {
    data: { type: 'run.start', chatId: chat.id, text: 'A question', script: 'elicitation' },
  });
  await expect(page.getByLabel('Name', { exact: true })).toBeVisible();
  await page.getByTestId('elicitation-decline').click();
});
