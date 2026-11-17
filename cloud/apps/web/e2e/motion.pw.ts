import { signIn as convexSignIn } from './sign-in';
import { expect, test, type Locator, type Page } from '@playwright/test';

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
const inBetween = (values: number[], a: number, b: number) => values.filter((v) => v > Math.min(a, b) + 0.5 && v < Math.max(a, b) - 0.5).length;

test.beforeEach(async ({ page }) => convexSignIn(page));

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
    let reversed = false;
    const tick = (now: number) => {
      const left = el.getBoundingClientRect().left;
      w.__track.push([now, left]);
      // Reverse in the measured frame: a protocol round trip can outlast the exit under load.
      if (!reversed && left < -40) {
        const reopen = document.querySelector<HTMLButtonElement>('[data-testid="nav-sidebar-button"]');
        if (reopen) { reversed = true; reopen.click(); }
      }
      if (w.__track.length < 2000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.getByTestId('sidebar-toggle').click();
  await page.waitForFunction(() => {
    const track = (window as unknown as { __track: Array<[number, number]> }).__track;
    return track.some(([, left]) => left < -40);
  });
  await page.waitForTimeout(1000);
  const track = await page.evaluate(() => (window as unknown as { __track: Array<[number, number]> }).__track);
  const lefts = track.map(([, left]) => left);
  expect(Math.min(...lefts)).toBeLessThan(-40);
  expect(Math.min(...lefts)).toBeGreaterThan(-290); // it never finished leaving
  // No teleport: however coarse the frames, the speed stays a spring's (the whole trip is 286 px).
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
  await convexSignIn(page, '/settings/general');
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

test('settings content swaps instantly with the panel staying put', async ({ page }) => {
  const panel = page.locator('[data-testid="app-sidebar"] [data-glass-surface]').first();
  const rest = (await panel.boundingBox())!;
  await page.getByTestId('sidebar-account').click();
  // Instant cut: settings nav is immediately visible and chats view is immediately gone.
  await expect(page.getByTestId('settings-nav-general')).toBeVisible();
  await expect(page.getByTestId('sidebar-new-chat')).toHaveCount(0);
  expect((await panel.boundingBox())!.width).toBeCloseTo(rest.width, 1);
  expect((await panel.boundingBox())!.x).toBeCloseTo(rest.x, 1);
});

test('a sent message flies from the composer with overshoot and never renders two visible copies; a loaded chat does not', async ({ page }) => {
  const input = page.getByTestId('composer-input');

  for (const msg of [`Alpha probe ${Date.now()}`, `Bravo probe ${Date.now()}`]) {
    await input.fill(msg);
    await page.evaluate((targetMsg) => {
      const w = window as unknown as {
        __flightTops: number[];
        __flightWidths: number[];
        __visibleCounts: number[];
        __go: boolean;
      };
      w.__flightTops = [];
      w.__flightWidths = [];
      w.__visibleCounts = [];
      w.__go = true;
      const tick = () => {
        if (!w.__go) return;
        const flight = document.querySelector<HTMLElement>('[data-testid="send-flight-bubble"]');
        if (flight) {
          const rect = flight.getBoundingClientRect();
          w.__flightTops.push(rect.top);
          w.__flightWidths.push(rect.width);
        }
        let visibleCopies = 0;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const el = node.parentElement;
          if (!el || el.tagName === 'TEXTAREA') continue;
          if ((node.nodeValue ?? '').trim() !== targetMsg) continue;
          const r = el.getBoundingClientRect();
          if (r.x <= 300 || r.y <= 60) continue;
          let op = 1;
          let vis = true;
          for (let a: HTMLElement | null = el; a; a = a.parentElement) {
            const s = getComputedStyle(a);
            op *= Number(s.opacity);
            if (s.visibility === 'hidden' || s.display === 'none') vis = false;
          }
          if (vis && op > 0.02) visibleCopies++;
        }
        w.__visibleCounts.push(visibleCopies);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, msg);

    await input.press('Enter');
    await page.waitForTimeout(950);
    const { tops, widths, visibleCounts } = await page.evaluate(() => {
      const w = window as unknown as {
        __flightTops: number[];
        __flightWidths: number[];
        __visibleCounts: number[];
        __go: boolean;
      };
      w.__go = false;
      return { tops: w.__flightTops, widths: w.__flightWidths, visibleCounts: w.__visibleCounts };
    });
    expect(tops.length).toBeGreaterThan(5);
    expect(Math.max(...widths)).toBeGreaterThan(Math.min(...widths) + 40);
    expect(visibleCounts.filter((c) => c > 1).length).toBe(0);
    await expect(page.getByTestId('send-flight-bubble')).toHaveCount(0);
    await expect(page.locator('[data-user-bubble]').last()).toHaveCSS('opacity', '1');
    await expect(page.locator('[data-user-bubble]').last()).toHaveCSS('visibility', 'visible');
    await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'));
  }

  const path = new URL(page.url()).pathname;
  // Reload: history appears with no entrance at all.
  await page.goto(path);
  await page.getByTestId('user-message-bubble').first().waitFor();
  expect(await page.getByTestId('user-message-bubble').first().evaluate((el) => (el as HTMLElement).style.opacity)).toBe('');
});

async function foldTrack(page: Page, fold: Locator, chevron: Locator, follower: Locator, act: () => Promise<unknown>) {
  await page.evaluate(([f, c, n]) => {
    const w = window as unknown as { __t: unknown[]; __go: boolean };
    w.__t = []; w.__go = true;
    const clip = f!.firstElementChild as HTMLElement;
    const tick = () => {
      if (!w.__go) return;
      const m = new DOMMatrixReadOnly(getComputedStyle(c!).transform);
      w.__t.push({ h: f!.getBoundingClientRect().height, bottom: f!.getBoundingClientRect().bottom, follow: n!.getBoundingClientRect().top, angle: Math.atan2(m.b, m.a) * 180 / Math.PI, opacity: Number(getComputedStyle(clip).opacity) });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [await fold.elementHandle(), await chevron.elementHandle(), await follower.elementHandle()] as const);
  await act();
  await page.waitForTimeout(700);
  return page.evaluate(() => { const w = window as unknown as { __t: { h: number; bottom: number; follow: number; angle: number; opacity: number }[]; __go: boolean }; w.__go = false; return w.__t; });
}

function expectOneCurve(track: { h: number; bottom: number; follow: number; angle: number; opacity: number }[], opening: boolean) {
  const H = Math.max(...track.map((f) => f.h));
  if (process.env.J2_DEBUG) console.log(track.map((f) => `${(f.h / H).toFixed(2)}/${(Math.abs(f.angle) / 90).toFixed(2)}/${f.opacity.toFixed(2)}`).join(' '));
  expect(H).toBeGreaterThan(20);
  const gap = track[0]!.follow - track[0]!.bottom;
  const moving = track.filter((f) => f.h > 1 && f.h < H - 1);
  expect(moving.length).toBeGreaterThanOrEqual(3); // it glides; it does not jump
  for (const f of track) {
    expect(Math.abs(f.follow - f.bottom - gap)).toBeLessThanOrEqual(1.5); // what follows moves with the fold
    const height = f.h / H;
    const turn = Math.abs(f.angle) / 90;
    expect(Math.abs(turn - height)).toBeLessThanOrEqual(0.12); // the chevron neither leads nor lags
    expect(Math.abs(f.opacity - height)).toBeLessThanOrEqual(0.12); // nor does the content
  }
  const last = track.at(-1)!;
  expect(last.h).toBeCloseTo(opening ? H : 0, 0);
}

test('the activity disclosure opens and closes on one curve: height, fade, chevron and what follows (WP-J2)', async ({ page }) => {
  await page.getByTestId('starter-chip-1').click();
  const toggle = page.getByTestId('agent-activity-toggle').first();
  await toggle.waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'));
  await page.waitForTimeout(300);
  const turn = toggle.locator('xpath=ancestor::*[@data-testid="assistant-turn"][1]');
  const fold = turn.getByTestId('agent-activity-fold');
  const chevron = toggle.locator('span[class*="chevron"]').first();
  const follower = turn.getByTestId('agent-message-view');
  expectOneCurve(await foldTrack(page, fold, chevron, follower, () => toggle.click()), true);
  // The nested tool row: its own fold, chevron and the same rule for the answer below.
  const row = turn.locator('[data-testid^="tool-step-header-"]').first();
  const rowFold = row.locator('xpath=following-sibling::*[1]');
  expectOneCurve(await foldTrack(page, rowFold, row.locator('span[class*="chevron"]').last(), follower, () => row.click()), true);
  expectOneCurve(await foldTrack(page, rowFold, row.locator('span[class*="chevron"]').last(), follower, () => row.click()), false);
  expectOneCurve(await foldTrack(page, fold, chevron, follower, () => toggle.click()), false);
});
