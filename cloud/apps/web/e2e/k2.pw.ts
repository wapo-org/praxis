import { signIn as convexSignIn } from './sign-in';
import { test, expect, type Page } from '@playwright/test';
// WP-K2: search shortcut, sidebar press, title without a box, the run background, the tray's own list.
test.use({ serviceWorkers: 'block' });

async function scriptedChat(page: Page, title: string, script = 'text') {
  return page.evaluate(async ({ title, script }) => {
    // @ts-expect-error Vite source import.
    const { apiClient } = await import('/src/lib/api.ts');
    const chat = await apiClient.createChat({ title });
    const run = await apiClient.startRun({ chatId: chat.id, text: 'hi', script, providerId: 'scripted', modelId: 'scripted', clientTurnId: crypto.randomUUID() });
    for (let i = 0; i < 100; i++) {
      const s = await apiClient.getRunSnapshot(run.id);
      if (['completed', 'failed', 'cancelled'].includes(s.run.status)) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return chat.id as string;
  }, { title, script });
}

test('⌘K (Ctrl+K off macOS) opens search from anywhere, including the composer; again or Escape closes', async ({ page }) => {
  await convexSignIn(page);
  const palette = page.getByTestId('search-palette');
  await page.getByTestId('composer-input').click();
  await page.keyboard.type('half a thought');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('combobox')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette).toHaveCount(0);
  // The draft is untouched: the shortcut never reached the field.
  await expect(page.getByTestId('composer-input')).toHaveValue('half a thought');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  // Other modifiers belong to the browser: nothing opens.
  await page.keyboard.press('ControlOrMeta+Shift+k');
  await page.keyboard.press('Alt+k');
  await page.waitForTimeout(250);
  await expect(palette).toHaveCount(0);
});

test('chat rows take the Settings rows\' press: scale and fill, by pointer and by keyboard', async ({ page }) => {
  await convexSignIn(page);
  await scriptedChat(page, 'Press me');
  await page.reload();
  await page.getByTestId('chat-top-bar').waitFor();
  const row = page.locator('[data-sidebar-row]').filter({ hasText: 'Press me' }).first();
  await row.waitFor();
  const scale = () => row.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(scale).toBeLessThan(0.985);
  await expect(row).toHaveAttribute('data-pressed', 'true');
  await page.mouse.up();
  await expect.poll(scale).toBeCloseTo(1, 2);
  // The actions button does not press the row.
  await row.hover();
  const actions = row.getByRole('button', { name: /^Actions for/ });
  const at = (await actions.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(120);
  expect(await row.getAttribute('data-pressed')).toBeNull();
  await page.mouse.up();
  await page.keyboard.press('Escape');
  // Keyboard: held Enter presses, release lets go.
  await row.locator('[data-sidebar-row-select]').focus();
  await page.keyboard.down('Enter');
  await expect(row).toHaveAttribute('data-pressed', 'true');
  await expect.poll(scale).toBeLessThan(0.985);
  await page.keyboard.up('Enter');
  await expect.poll(scale).toBeCloseTo(1, 2);
  // The Search row presses too.
  const search = page.getByRole('button', { name: 'Search conversations', exact: true });
  const sb = (await search.boundingBox())!;
  await page.mouse.move(sb.x + 30, sb.y + sb.height / 2);
  await page.mouse.down();
  await expect.poll(() => search.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)).toBeLessThan(0.985);
  await page.mouse.up();
});

test('the chat title has no box: it sits on the stretched blur', async ({ page }) => {
  await convexSignIn(page);
  const title = page.getByTestId('nav-chat-title-pill');
  await expect(title.locator('xpath=ancestor-or-self::*[@data-glass-surface]')).toHaveCount(0);
  const look = await title.evaluate((el) => {
    const s = getComputedStyle(el.parentElement!);
    return { bg: s.backgroundColor, border: s.borderTopWidth, shadow: s.boxShadow, scrim: (document.querySelector('[data-slot="progressive-blur-top"]') as HTMLElement).getBoundingClientRect().height, titleBottom: el.getBoundingClientRect().bottom };
  });
  expect(look.bg).toBe('rgba(0, 0, 0, 0)');
  expect(look.border).toBe('0px');
  expect(look.shadow).toBe('none');
  // One ramp from the very top to past the title.
  expect(look.scrim).toBeGreaterThan(look.titleBottom);
});

test('a run shows the living background while it streams, and only then', async ({ page }) => {
  await convexSignIn(page);
  const backdrop = page.getByTestId('run-backdrop');
  await expect(backdrop).toHaveCount(0);
  await page.route('**/v1/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = JSON.parse(route.request().postData() ?? '{}');
    await route.continue({ postData: JSON.stringify({ ...body, providerId: 'scripted', modelId: 'scripted', script: 'long' }) });
  });
  await page.getByTestId('composer-input').fill('Write a long answer');
  await page.getByTestId('composer-input').press('Enter');
  await expect(backdrop).toHaveAttribute('data-active', 'true');
  const opacity = await backdrop.evaluate((el) => new Promise<number>((r) => setTimeout(() => r(Number(getComputedStyle(el).opacity)), 900)));
  expect(opacity).toBeGreaterThan(0.05);
  expect(opacity).toBeLessThanOrEqual(0.12);
  // Only transforms animate on the blobs.
  const props = await backdrop.evaluate((el) => [...el.querySelectorAll('*')].flatMap((n) => n.getAnimations().map((a) => Object.keys((a.effect as KeyframeEffect).getKeyframes()[0] ?? {}).filter((k) => !['offset', 'easing', 'composite', 'computedOffset'].includes(k)))).flat());
  expect(new Set(props)).toEqual(new Set(['transform']));
  await expect(page.getByTestId('composer-stop-button')).toHaveCount(0, { timeout: 30000 });
  await expect(backdrop).toHaveCount(0, { timeout: 3000 });
});

test('reduced motion: no run background', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  await convexSignIn(page);
  await page.route('**/v1/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = JSON.parse(route.request().postData() ?? '{}');
    await route.continue({ postData: JSON.stringify({ ...body, providerId: 'scripted', modelId: 'scripted', script: 'long' }) });
  });
  await page.getByTestId('composer-input').fill('Write a long answer');
  await page.getByTestId('composer-input').press('Enter');
  await page.getByTestId('composer-stop-button').waitFor();
  await page.waitForTimeout(700);
  await expect(page.getByTestId('run-backdrop')).toHaveCount(0);
  await context.close();
});

test('the tray\'s rows group into one translucent squircle with flat, hairline joins', async ({ page }) => {
  await convexSignIn(page);
  await page.getByTestId('composer-plus-button').click();
  const tray = page.getByTestId('plus-tray');
  await tray.waitFor();
  const list = tray.getByRole('button', { name: /Model providers/ }).locator('..');
  const group = await list.evaluate((el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, border: s.borderTopWidth, radius: parseFloat(s.borderTopLeftRadius), overflow: s.overflow, shadow: s.boxShadow }; });
  const alpha = (bg: string) => Number(/[\d.]+\)$/.exec(bg)?.[0]?.slice(0, -1) ?? (bg.includes('color(') ? /\/ ([\d.]+)\)/.exec(bg)?.[1] : '1'));
  expect(alpha(group.bg), group.bg).toBeGreaterThan(0);
  expect(alpha(group.bg), group.bg).toBeLessThan(0.2);
  expect(group).toMatchObject({ border: '0px', overflow: 'hidden', shadow: 'none' });
  expect(group.radius).toBeGreaterThanOrEqual(16);
  const rows = await list.locator('> *').evaluateAll((els) => els.map((el) => {
    const s = getComputedStyle(el), d = getComputedStyle(el, '::before');
    return { bg: s.backgroundColor, radius: parseFloat(s.borderTopLeftRadius), top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, divider: d.content !== 'none' && d.content !== 'normal', dividerLeft: parseFloat(d.left) };
  }));
  expect(rows.length).toBeGreaterThanOrEqual(3);
  rows.forEach((r, i) => {
    expect(r.bg).toBe('rgba(0, 0, 0, 0)');
    expect(r.radius).toBe(0);
    expect(r.divider).toBe(i > 0);
    if (i > 0) { expect(Math.abs(r.top - rows[i - 1]!.bottom)).toBeLessThan(0.5); expect(r.dividerLeft).toBeGreaterThan(8); }
  });
  // The hover fill of an end row is clipped by the group's rounded corner.
  const last = tray.getByRole('button', { name: /Model providers/ });
  await last.hover();
  await expect.poll(() => last.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
});
