import { expect, test, type Locator, type Page } from '@playwright/test';

async function signIn(page: Page, path = '/') {
  await page.goto(path);
  const dev = page.getByRole('button', { name: /local dev user/i });
  await Promise.race([dev.waitFor(), page.getByTestId('chat-top-bar').waitFor(), page.getByTestId('settings-page').waitFor()]);
  if (await dev.isVisible().catch(() => false)) await dev.click();
  await Promise.race([page.getByTestId('chat-top-bar').waitFor(), page.getByTestId('settings-page').waitFor()]);
  await page.waitForTimeout(300);
}

/** Per-frame read of `read(el)` while `act` runs. */
async function sample(locator: Locator, act: () => Promise<unknown>, read = 'left'): Promise<number[]> {
  await locator.evaluate((el, prop) => {
    const w = window as unknown as { __v: number[]; __go: boolean };
    w.__v = [];
    w.__go = true;
    const tick = () => {
      if (!w.__go) return;
      w.__v.push(prop === 'matrixY' ? new DOMMatrixReadOnly(getComputedStyle(el).transform).m42 : prop === 'matrixX' ? new DOMMatrixReadOnly(getComputedStyle(el).transform).m41 : prop === 'opacity' ? Number(getComputedStyle(el).opacity) : el.getBoundingClientRect().left);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, read);
  await act();
  return locator.page().evaluate(() => {
    const w = window as unknown as { __v: number[]; __go: boolean };
    w.__go = false;
    return w.__v;
  });
}
const biggestStep = (values: number[]) => values.slice(1).reduce((max, v, i) => Math.max(max, Math.abs(v - values[i]!)), 0);
const inBetween = (values: number[], a: number, b: number) => values.filter((v) => v > Math.min(a, b) + 0.5 && v < Math.max(a, b) - 0.5).length;

test.beforeEach(async ({ page }) => signIn(page));

test('the sidebar is simply there on load: it does not fly in', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __lefts: number[] };
    w.__lefts = [];
    const tick = () => {
      const el = document.querySelector('[data-testid="app-sidebar"]');
      if (el) w.__lefts.push(el.getBoundingClientRect().left);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.reload();
  await page.getByTestId('app-sidebar').waitFor();
  await page.waitForTimeout(500);
  const lefts = await page.evaluate(() => (window as unknown as { __lefts: number[] }).__lefts);
  expect(lefts.length).toBeGreaterThan(3);
  expect(Math.min(...lefts)).toBeCloseTo(12, 0);
});

test('the sidebar slides, and reversing mid-flight continues from where it is', async ({ page }) => {
  const aside = page.getByTestId('app-sidebar');
  await aside.evaluate((el) => {
    const w = window as unknown as { __track: Array<[number, number]> };
    w.__track = [];
    const tick = (now: number) => {
      w.__track.push([now, el.getBoundingClientRect().left]);
      if (w.__track.length < 2000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.getByTestId('sidebar-toggle').click();
  await page.waitForFunction(() => {
    const track = (window as unknown as { __track: Array<[number, number]> }).__track;
    return track[track.length - 1]![1] < -40;
  });
  await page.keyboard.press('Control+K'); // reopen while it is still leaving
  await page.waitForTimeout(1000);
  const track = await page.evaluate(() => (window as unknown as { __track: Array<[number, number]> }).__track);
  const lefts = track.map(([, left]) => left);
  expect(Math.min(...lefts)).toBeLessThan(-40);
  expect(Math.min(...lefts)).toBeGreaterThan(-290); // it never finished leaving
  // No teleport: however coarse the frames, the speed stays a spring's (the whole trip is 286 px).
  // Measured over three frames: a frame's own timestamp can land just either side of the write.
  const speeds = track.slice(3).map(([t, left], i) => Math.abs(left - track[i]![1]) / Math.max(1, t - track[i]![0]));
  expect(Math.max(...speeds)).toBeLessThan(5);
  expect(lefts[lefts.length - 1]).toBeCloseTo(12, 0);
});

test('hover is instant and pill-shaped: nothing glides between rows', async ({ page }) => {
  // A fresh API has only the welcome chat; this needs two rows.
  if ((await page.locator('[data-sidebar-row]').count()) < 2) {
    await page.getByTestId('starter-chip-2').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-sidebar-row]').length >= 2);
    await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'));
    await page.waitForTimeout(300);
  }
  const first = page.locator('[data-sidebar-row]:not([data-active="true"])').first();
  await first.hover();
  await expect.poll(() => first.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  const radius = await first.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
  expect(radius).toBeGreaterThanOrEqual((await first.boundingBox())!.height / 2);
  // No pill element moves between rows: the row owns its own background, with no transition on it.
  expect(await first.evaluate((el) => getComputedStyle(el).transitionProperty.includes('background') && getComputedStyle(el).transitionDuration !== '0s')).toBe(false);
  await expect(page.locator('[data-glide]')).toHaveCount(0);
  await page.getByTestId('sidebar-new-chat').hover();
  await expect.poll(() => first.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await expect.poll(() => page.getByTestId('sidebar-new-chat').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
});

test('the segmented thumb springs and can reverse from where it is', async ({ page }) => {
  await signIn(page, '/settings/general');
  const thumb = page.getByRole('group', { name: 'Appearance' }).locator('span').first();
  await page.getByRole('button', { name: 'Light' }).click();
  await page.waitForTimeout(500);
  const values = await sample(thumb, async () => {
    await page.getByRole('button', { name: 'System' }).click();
    await page.waitForTimeout(70);
    await page.getByRole('button', { name: 'Light' }).click();
    await page.waitForTimeout(500);
  }, 'matrixX');
  const peak = Math.max(...values);
  expect(peak).toBeGreaterThan(5);
  expect(inBetween(values, 0, peak)).toBeGreaterThanOrEqual(2);
  expect(values[values.length - 1]).toBeCloseTo(0, 0);
});

test('settings content swaps with the panel staying put', async ({ page }) => {
  const panel = page.locator('[data-testid="app-sidebar"] [data-glass-surface]').first();
  const rest = (await panel.boundingBox())!;
  await page.getByTestId('sidebar-account').click();
  await page.waitForTimeout(40);
  // Mid-transition both views exist, overlapping inside the same glass.
  await expect(page.getByTestId('settings-nav-general')).toBeVisible();
  expect((await panel.boundingBox())!.width).toBeCloseTo(rest.width, 1);
  await expect(page.getByTestId('sidebar-new-chat')).toHaveCount(0, { timeout: 2000 });
});

test('a sent message rises in; a loaded chat does not', async ({ page }) => {
  const input = page.getByTestId('composer-input');
  await input.fill(`Arrival probe ${Date.now()}`);
  await page.evaluate(() => {
    const w = window as unknown as { __arrived: number[] };
    w.__arrived = [];
    new MutationObserver(() => {
      const bubble = document.querySelector<HTMLElement>('[data-testid="user-message-bubble"]:last-of-type');
      if (bubble) w.__arrived.push(Number(getComputedStyle(bubble).opacity));
    }).observe(document.body, { subtree: true, childList: true });
  });
  await input.press('Enter');
  await page.getByTestId('user-message-bubble').first().waitFor();
  const opacity = page.getByTestId('user-message-bubble').first();
  await expect(opacity).toHaveCSS('opacity', '1');
  const path = new URL(page.url()).pathname;
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'));
  // Reload: history appears with no entrance at all.
  await page.goto(path);
  await page.getByTestId('user-message-bubble').first().waitFor();
  expect(await page.getByTestId('user-message-bubble').first().evaluate((el) => (el as HTMLElement).style.opacity)).toBe('');
});

test('opening the activity disclosure glides what follows, by transform', async ({ page }) => {
  await page.getByTestId('starter-chip-1').click();
  const toggle = page.getByTestId('agent-activity-toggle').first();
  await toggle.waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'));
  await page.waitForTimeout(300);
  const follower = toggle.locator('xpath=ancestor::*[@data-testid="assistant-turn"][1]/following-sibling::*[1]');
  const values = await sample(follower, async () => {
    await toggle.click();
    await page.waitForTimeout(500);
  }, 'matrixY');
  expect(Math.min(...values)).toBeLessThan(-5); // starts where it was
  expect(values[values.length - 1]).toBeCloseTo(0, 0);
});
