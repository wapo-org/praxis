import { expect, test } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  await page.request.post('/v1/auth/dev', {
    data: { type: 'auth.dev', userId: 'g4b-check-' + Date.now() },
  });
  await page.goto('/');
  await page.getByTestId('sidebar-new-chat').waitFor();
  await page.evaluate(() => document.fonts.ready);
});
test('the measured dark sidebar keeps glass in both themes and matches the reference dimensions', async ({
  page,
}) => {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const sidebar = page.getByTestId('app-sidebar');
    const box = (await sidebar.boundingBox())!;
    expect(box.width).toBe(214);
    expect(box.y).toBe(18);
    expect(box.height).toBe(858);
    const searchIcon = await page.getByRole('button', { name: 'Search conversations' }).locator('svg').boundingBox();
    expect(searchIcon!.x).toBe(29);
    expect(searchIcon!.width).toBe(16);
    await expect(page.getByRole('button', { name: 'Search conversations' }).locator('svg')).toHaveCSS('color', 'rgb(242, 241, 237)');
    await expect(page.getByTestId('sidebar-new-chat')).toHaveCSS(
      'background-color',
      'rgb(255, 255, 255)',
    );
    await expect(page.getByTestId('sidebar-new-chat')).toHaveCSS('height', '34px');
    const surface = sidebar.locator('[data-glass-surface]').first();
    expect(await surface.getAttribute('data-glass-surface')).toMatch(/svg|frost/);
    expect(
      await surface.evaluate((el) =>
        Number(
          /,\s*([.\d]+)\)/.exec(getComputedStyle(el).getPropertyValue('--glass-thick-tint'))?.[1],
        ),
      ),
    ).toBe(0.94);
    await expect(sidebar.locator('[data-sidebar-row]').first()).toHaveCSS('height', '31px');
    await expect(sidebar.locator('[data-sidebar-row-select]').first()).toHaveCSS(
      'color',
      'rgb(242, 241, 237)',
    );
  }
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
test('all accent swatches work in both themes, persist and colour sign-in before its first render', async ({
  page,
  context,
}) => {
  await page.goto('/settings/general');
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    for (const label of ['Neutral', 'Blue', 'Violet', 'Rose', 'Amber', 'Green']) {
      const radio = page.getByRole('radio', { name: label, exact: true });
      await radio.click();
      await expect(radio).toHaveAttribute('aria-checked', 'true');
      expect(await page.evaluate(() => document.documentElement.dataset.accent)).toBe(
        label.toLowerCase(),
      );
    }
  }
  const blue = page.getByRole('radio', { name: 'Blue', exact: true });
  await blue.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Violet', exact: true })).toBeFocused();
  await blue.click();
  await page.addInitScript(() => {
    const w = window as unknown as { firstAccent?: string };
    new MutationObserver(() => {
      if (!w.firstAccent && document.querySelector('button'))
        w.firstAccent = document.documentElement.dataset.accent;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Blue', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect(
    await page.evaluate(() => (window as unknown as { firstAccent: string }).firstAccent),
  ).toBe('blue');
  await context.clearCookies();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCSS(
    'background-color',
    'rgb(139, 180, 255)',
  );
  expect(
    await page.evaluate(() => (window as unknown as { firstAccent: string }).firstAccent),
  ).toBe('blue');
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
test('accent reaches send, approval, selected checkmarks, links, toggles and focus rings', async ({
  page,
}) => {
  await page.goto('/settings/general');
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  const green = page.getByRole('radio', { name: 'Green', exact: true });
  await green.click();
  await green.focus();
  await expect(green).toHaveCSS('outline-color', 'rgb(20, 107, 72)');
  await page.goto('/settings/providers/new');
  const toggle = page.getByRole('switch', { name: 'Tool calling', exact: true });
  await toggle.check({ force: true });
  await expect(toggle.locator('xpath=..')).toHaveCSS('background-color', 'rgb(20, 107, 72)');
  const chat = await (
    await page.request.post('/v1/chats', { data: { type: 'chat.input', title: 'Accent coverage' } })
  ).json();
  await page.goto('/c/' + chat.id);
  await page.getByTestId('composer-input').fill('A message');
  await expect(page.getByTestId('composer-send-button')).toHaveCSS(
    'background-color',
    'rgb(20, 107, 72)',
  );
  await page.getByTestId('composer-input').fill('');
  await page.getByTestId('composer-plus-button').click();
  await page.getByTestId('tray-model-picker-trigger').click();
  await expect(page.getByRole('option', { selected: true }).locator('.lucide-check')).toHaveCSS(
    'color',
    'rgb(20, 107, 72)',
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.request.post('/v1/runs', {
    data: {
      type: 'run.start',
      chatId: chat.id,
      text: '\n\n[Docs](https://example.com)',
      script: 'text',
    },
  });
  await expect(page.getByRole('link', { name: /Docs/ })).toHaveCSS('color', 'rgb(20, 107, 72)');
  await page.request.post('/v1/runs', {
    data: { type: 'run.start', chatId: chat.id, text: 'Review this change', script: 'approval' },
  });
  await expect(page.getByTestId('approval-allow-once')).toHaveCSS(
    'background-color',
    'rgb(20, 107, 72)',
  );
  await page.getByTestId('approval-deny').click();
});
