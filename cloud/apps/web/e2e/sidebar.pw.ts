import { expect, test } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  await page.request.post('/v1/auth/dev', {
    data: { type: 'auth.dev', userId: 'g4b-check-' + Date.now() },
  });
  await page.goto('/');
  await page.getByTestId('sidebar-new-chat').waitFor();
  await page.evaluate(() => document.fonts.ready);
});
// Name, base, the reflection colour (v2's ACC), ink.
const PALETTES = [
  ['Graphite', 'rgb(22, 24, 27)', [142, 160, 179], 'rgb(242, 241, 237)'],
  ['Midnight', 'rgb(16, 28, 51)', [75, 127, 214], 'rgb(242, 241, 237)'],
  ['Forest', 'rgb(18, 38, 29)', [68, 168, 119], 'rgb(242, 241, 237)'],
  ['Plum', 'rgb(38, 21, 48)', [168, 102, 212], 'rgb(242, 241, 237)'],
  ['Sand', 'rgb(233, 228, 216)', [217, 199, 154], 'rgb(28, 28, 28)'],
  ['Paper', 'rgb(251, 251, 249)', [214, 214, 224], 'rgb(28, 28, 28)'],
] as const;
const solid = (page: import('@playwright/test').Page) =>
  page.locator('[data-testid="app-sidebar"] [data-glass-solid]').first();
const ring = (page: import('@playwright/test').Page) => page.locator('[data-testid="app-sidebar"] [data-sidebar-ring]');
/** The ring's stops as 0–255 RGB: hot (the reflection colour), mid, base (10 % of it over black). */
const ringStops = (image: string) =>
  [...image.matchAll(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)\)/g)].map((m) => [m[1], m[2], m[3]].map((v) => Math.round(Number(v) * 255)));
/** The fading base layer: solid to 45 %, then 40 % of the base at the bottom. */
const fade = (base: string) => new RegExp(`linear-gradient\\(${base.replace(/[()]/g, '\\$&')} 0%, ${base.replace(/[()]/g, '\\$&')} 45%, color\\(srgb [\\d.]+ [\\d.]+ [\\d.]+ / 0\\.4\\) 100%\\)$`);
test('the sidebar is the owner\'s v2 slab, identical in both themes, with the source metrics', async ({
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
    // No lens: one layer with the aside's gloss over grad(base), a transparent border, the inset highlight and a 14 px backdrop blur.
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
        clip: s.backgroundClip,
        backdrop: s.backdropFilter || s.getPropertyValue('-webkit-backdrop-filter'),
      };
    });
    // v2: the aside's literal gloss, then sbBg = grad(base): the same sheen (clear at the bottom) over the fading base.
    const sheen = (bottom: string) =>
      `linear-gradient(rgba(255, 255, 255, 0.2) 0%, rgba(255, 255, 255, 0.12) 2%, rgba(255, 255, 255, 0.06) 5%, rgba(255, 255, 255, 0.02) 9%, rgba(0, 0, 0, 0) 14%, ${bottom} 100%)`;
    expect(layer.image.startsWith(`${sheen('rgba(0, 0, 0, 0.12)')}, ${sheen('rgba(0, 0, 0, 0)')}, `)).toBe(true);
    expect(layer.image).toMatch(fade('rgb(22, 24, 27)'));
    expect(layer.color).toBe('rgba(0, 0, 0, 0)');
    expect(layer.clip.split(', ').every((c) => c === 'padding-box')).toBe(true);
    expect(layer.border).toBe('1px solid rgba(0, 0, 0, 0)');
    expect(layer.shadow).toBe('rgba(255, 255, 255, 0.3) 0px 1px 2px 0px inset');
    expect(layer.radius).toBe('29px');
    expect(layer.corner, 'v2 drops the squircle').not.toContain('squircle');
    expect(layer.backdrop).toBe('blur(14px)');
    // The border reflection: a 1 px conic ring over the whole box, from 45°, hot in the palette's colour.
    const reflection = await ring(page).evaluate((el) => {
      const s = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return { image: s.backgroundImage, padding: s.paddingTop, radius: s.borderTopLeftRadius, events: s.pointerEvents, mask: s.maskComposite || s.getPropertyValue('-webkit-mask-composite'), box: [box.x, box.y, box.width, box.height] };
    });
    expect(reflection.image.startsWith('conic-gradient(from 45deg')).toBe(true);
    expect(ringStops(reflection.image)[0]).toEqual([142, 160, 179]);
    expect(reflection).toMatchObject({ padding: '1px', radius: '29px', events: 'none', box: [12, 18, 232, 858] });
    expect(reflection.mask).toMatch(/exclude|xor/);
    looks.push({ layer, reflection });
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
    await expect(search).toHaveCSS('border-radius', '999px'); // WP-I1: a full pill, like the rows and New chat
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
test('the six sidebar palettes apply live, persist, and are there before first paint; there is no button colour', async ({
  page,
}) => {
  await page.goto('/settings/general');
  const look = page.getByTestId('sidebar-look');
  const palettes = look.getByRole('radiogroup', { name: 'Sidebar palette' });
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    for (const [name, base, acc, ink] of PALETTES) {
      const radio = palettes.getByRole('radio', { name, exact: true });
      await radio.click();
      await expect(radio).toHaveAttribute('aria-checked', 'true');
      await expect(solid(page)).toHaveCSS('background-image', fade(base));
      expect(ringStops(await ring(page).evaluate((el) => getComputedStyle(el).backgroundImage))[0]).toEqual(acc);
      await expect(page.locator('[data-testid="app-sidebar"] [aria-current="page"]').first()).toHaveCSS('color', ink);
      // WP-I1: Back (and New chat) is always the white pill, whatever the palette.
      await expect(page.getByTestId('settings-back')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      await expect(page.getByTestId('settings-back')).toHaveCSS('color', 'rgb(28, 28, 28)');
    }
  }
  // The button-colour option is gone from Settings.
  await expect(look.getByRole('radiogroup', { name: 'Button color' })).toHaveCount(0);
  await expect(page.getByTestId('button-color-custom')).toHaveCount(0);
  await expect(look.getByText('Button color')).toHaveCount(0);
  const midnight = palettes.getByRole('radio', { name: 'Midnight', exact: true });
  await midnight.click();
  await midnight.focus();
  await page.keyboard.press('ArrowRight');
  await expect(palettes.getByRole('radio', { name: 'Forest', exact: true })).toBeFocused();
  await expect(solid(page)).toHaveCSS('background-image', fade('rgb(18, 38, 29)'));
  // A colour stored by the old option is ignored before first paint and after, and cleared.
  await page.evaluate(() => localStorage.setItem('praxis-button-color', '#123abc'));
  await page.addInitScript(() => {
    const w = window as unknown as { firstLook?: string };
    new MutationObserver(() => {
      if (!w.firstLook && document.querySelector('button'))
        w.firstLook = `${document.documentElement.dataset.sidebarPalette} ${getComputedStyle(document.documentElement).getPropertyValue('--nb-fill').trim()}`;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  await expect(palettes.getByRole('radio', { name: 'Forest', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => (window as unknown as { firstLook: string }).firstLook)).toBe('forest #ffffff');
  await expect(page.getByTestId('settings-back')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  expect(await page.evaluate(() => localStorage.getItem('praxis-button-color'))).toBeNull();
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
test('multiline and long chat titles stay strictly single-line with ellipsis truncation in header and sidebar', async ({
  page,
}) => {
  const cases = [
    { raw: 'Hello\nHello\nHello', expectedText: 'Hello Hello Hello', expectTruncated: false },
    { raw: 'Here are a few options:\n\n* Chat: Longer Re', expectedText: 'Here are a few options: * Chat: Longer Re', expectTruncated: true },
    { raw: 'Very Long Chat Title That Should Stay On One Single Line Without Wrapping At All', expectedText: 'Very Long Chat Title That Should Stay On One Single Line Without Wrapping At All', expectTruncated: true },
  ];
  for (const c of cases) {
    const chat = await (
      await page.request.post('/v1/chats', { data: { type: 'chat.input', title: c.raw } })
    ).json();
    await page.goto('/c/' + chat.id);
    const pill = page.getByTestId('nav-chat-title-pill');
    await expect(pill).toBeVisible();
    const headerStats = await pill.evaluate((el) => {
      const textSpan = el.querySelector('span');
      const current = textSpan?.querySelector('span > span') ?? textSpan;
      const cs = getComputedStyle(textSpan!);
      return {
        text: textSpan!.textContent ?? '',
        height: Math.round(textSpan!.getBoundingClientRect().height),
        lineHeight: Math.round(parseFloat(cs.lineHeight)),
        textOverflow: getComputedStyle(current!).textOverflow,
      };
    });
    expect(headerStats.text).not.toContain('\n');
    expect(headerStats.height).toBeLessThanOrEqual(headerStats.lineHeight + 1);

    const row = page.locator('[data-sidebar-row][data-active="true"]').first();
    await expect(row).toBeVisible();
    const rowStats = await row.evaluate((el) => {
      const btn = el.querySelector('[data-sidebar-row-select]')!;
      const titleWrap = btn.querySelector('span')!;
      const stack = titleWrap.querySelector('span')!;
      const current = stack.querySelector('span')!;
      return {
        rowHeight: Math.round(el.getBoundingClientRect().height),
        text: current.textContent ?? '',
        scrollWidth: current.scrollWidth,
        clientWidth: current.clientWidth,
        wrapClientWidth: titleWrap.clientWidth,
        textOverflow: getComputedStyle(current).textOverflow,
      };
    });
    expect(rowStats.rowHeight).toBe(31);
    expect(rowStats.text).toBe(c.expectedText);
    expect(rowStats.text).not.toContain('\n');
    expect(rowStats.clientWidth).toBeLessThanOrEqual(rowStats.wrapClientWidth + 1);
    expect(rowStats.textOverflow).toBe('ellipsis');
    if (c.expectTruncated) {
      expect(rowStats.scrollWidth).toBeGreaterThan(rowStats.clientWidth);
    }
  }
});
test('argument-free approvals have no empty box and questions use a human label', async ({
  page,
}) => {
  const chat = await (
    await page.request.post('/v1/chats', { data: { type: 'chat.input', mode:'auto', title: 'Card labels' } })
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
