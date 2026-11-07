import { expect, test, type Locator, type Page } from '@playwright/test';

async function signIn(page: Page, path = '/') {
  await page.goto(path);
  const dev = page.getByRole('button', { name: /local dev user/i });
  await Promise.race([dev.waitFor(), page.getByTestId('chat-top-bar').waitFor(), page.getByTestId('settings-page').waitFor()]);
  if (await dev.isVisible().catch(() => false)) await dev.click();
  await Promise.race([page.getByTestId('chat-top-bar').waitFor(), page.getByTestId('settings-page').waitFor()]);
  await page.waitForTimeout(900); // anything still settling from sign-in has stopped
}

const surfaceOf = (locator: Locator) => locator.locator('xpath=ancestor-or-self::*[@data-glass-surface][1]');
const sidebar = (page: Page) => page.locator('[data-testid="app-sidebar"] [data-glass-surface]').first();

type Edges = { t: number; l: number; r: number; top: number; b: number };
const startSampling = (surface: Locator) =>
  surface.evaluate((el) => {
    const w = window as unknown as { __s: Edges[]; __on: boolean };
    w.__s = [];
    w.__on = true;
    const tick = () => {
      if (!w.__on) return;
      const r = el.getBoundingClientRect();
      w.__s.push({ t: performance.now(), l: r.left, r: r.right, top: r.top, b: r.bottom });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
const stopSampling = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __s: Edges[]; __on: boolean };
    w.__on = false;
    return w.__s;
  });

/** Geometry is only meaningful once the glass has landed: the morph leaves nothing inline at rest. */
async function landed(shell: Locator) {
  await expect.poll(() => shell.evaluate((el: HTMLElement) => el.style.transform)).toBe('');
}

async function pull(page: Page, from: { x: number; y: number }, dx: number, dy: number, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps });
  await page.waitForTimeout(350);
}

const center = async (locator: Locator) => {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test.describe('the stretch', () => {
  test.beforeEach(async ({ page }) => signIn(page));

  test('pulling right moves only the right edge, from any start point', async ({ page }) => {
    const surface = sidebar(page);
    const rest = (await surface.boundingBox())!;
    for (const start of [{ x: rest.x + 10, y: rest.y + 10 }, { x: rest.x + rest.width / 2, y: rest.y + rest.height / 2 }, { x: rest.x + rest.width - 10, y: rest.y + rest.height - 10 }]) {
      await pull(page, start, 120, 0);
      const box = (await surface.boundingBox())!;
      expect(Math.abs(box.x - rest.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.y - rest.y)).toBeLessThanOrEqual(1);
      expect(box.x + box.width).toBeGreaterThan(rest.x + rest.width + 10);
      expect(Math.abs(box.height - rest.height)).toBeLessThanOrEqual(1);
      await page.mouse.up();
      await page.waitForTimeout(1100);
    }
  });

  test('pulling left moves only the left edge; pulling up only the top', async ({ page }) => {
    const surface = surfaceOf(page.getByTestId('composer-input'));
    const rest = (await surface.boundingBox())!;
    await pull(page, { x: rest.x + rest.width / 2, y: rest.y + 2 }, -150, 0);
    let box = (await surface.boundingBox())!;
    expect(Math.abs(box.x + box.width - (rest.x + rest.width))).toBeLessThanOrEqual(1);
    expect(box.x).toBeLessThan(rest.x - 10);
    await page.mouse.up();
    await page.waitForTimeout(1000);
    await pull(page, { x: rest.x + rest.width / 2, y: rest.y + 2 }, 0, -120);
    box = (await surface.boundingBox())!;
    expect(Math.abs(box.y + box.height - (rest.y + rest.height))).toBeLessThanOrEqual(1);
    expect(box.y).toBeLessThan(rest.y - 5);
    await page.mouse.up();
  });

  test('no jump at engage, wherever the press started', async ({ page }) => {
    const surface = sidebar(page);
    const rest = (await surface.boundingBox())!;
    for (const start of [{ x: rest.x + 8, y: rest.y + 8 }, { x: rest.x + 130, y: rest.y + 440 }]) {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await startSampling(surface);
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(start.x + i * 2, start.y);
        await page.waitForTimeout(20);
      }
      const frames = await stopSampling(page);
      let worst = 0;
      for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1]!;
        const b = frames[i]!;
        worst = Math.max(worst, Math.abs(b.l - a.l), Math.abs(b.r - a.r), Math.abs(b.top - a.top), Math.abs(b.b - a.b));
      }
      expect(frames.length).toBeGreaterThan(5);
      expect(worst).toBeLessThanOrEqual(5);
      await page.mouse.up();
      await page.waitForTimeout(1100);
    }
  });

  test('release overshoots: the pull crosses zero and wobbles out', async ({ page }) => {
    const surface = sidebar(page);
    const rest = (await surface.boundingBox())!;
    await pull(page, { x: rest.x + 130, y: rest.y + 500 }, 160, 0);
    await startSampling(surface);
    await page.mouse.up();
    await page.waitForTimeout(1200);
    const frames = await stopSampling(page);
    // One-sided: past zero the far side flips, so the left edge goes left of rest.
    expect(Math.min(...frames.map((f) => f.l))).toBeLessThan(rest.x - 0.5);
    const last = frames[frames.length - 1]!;
    expect(Math.abs(last.l - rest.x)).toBeLessThan(0.5);
    expect(Math.abs(last.r - (rest.x + rest.width))).toBeLessThan(0.5);
    expect(await surface.evaluate((el) => (el as HTMLElement).style.scale)).toBe('');
  });

  const realClickAfterPull = async (page: Page, target: Locator, surface: Locator) => {
    const start = await center(target);
    const rest = (await surface.boundingBox())!;
    await pull(page, start, 70, -40);
    const box = (await surface.boundingBox())!;
    const grew = Math.abs(box.width - rest.width) + Math.abs(box.height - rest.height);
    await page.mouse.up();
    await page.waitForTimeout(150);
    return grew;
  };

  test('a pull from a button stretches and does not click; a plain click clicks', async ({ page }) => {
    const button = page.getByTestId('sidebar-new-chat');
    const log = () => page.evaluate(() => (window as unknown as { __clicks: number }).__clicks);
    await button.evaluate((el) => {
      const w = window as unknown as { __clicks: number };
      w.__clicks = 0;
      el.addEventListener('click', () => { w.__clicks += 1; });
    });
    expect(await realClickAfterPull(page, button, sidebar(page))).toBeGreaterThan(8);
    expect(await log()).toBe(0);
    await page.waitForTimeout(1000);
    await button.click();
    expect(await log()).toBe(1);
  });

  test('a pull from a chat row stretches without selecting; a click selects', async ({ page }) => {
    const row = page.locator('[data-sidebar-row-select]').nth(1); // the seeded list may run past the window
    const url = page.url();
    expect(await realClickAfterPull(page, row, sidebar(page))).toBeGreaterThan(8);
    expect(page.url()).toBe(url);
    await page.waitForTimeout(1000);
    await row.click();
    await expect(page).toHaveURL(/\/c\//);
  });

  test('a pull from a link stretches, drags nothing and does not navigate', async ({ page }) => {
    await page.locator('[data-testid="app-sidebar"] footer').evaluate((footer) => {
      const a = document.createElement('a');
      a.href = '#pulled';
      a.textContent = 'A link';
      a.dataset.testid = 'probe-link';
      footer.prepend(a);
    });
    const link = page.locator('[data-testid="probe-link"]');
    expect(await realClickAfterPull(page, link, sidebar(page))).toBeGreaterThan(8);
    expect(page.url()).not.toContain('#pulled');
    await page.waitForTimeout(1000);
    await link.click();
    await expect(page).toHaveURL(/#pulled/);
  });

  test('an empty composer stretches; one with text selects instead', async ({ page }) => {
    const input = page.getByTestId('composer-input');
    const surface = surfaceOf(input);
    expect(await realClickAfterPull(page, input, surface)).toBeGreaterThan(5);
    await page.waitForTimeout(1000);
    await input.fill('some text to select');
    const box = (await input.boundingBox())!;
    const rest = (await surface.boundingBox())!;
    await page.mouse.move(box.x + 8, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 8 });
    await page.waitForTimeout(200);
    const during = (await surface.boundingBox())!;
    expect(Math.abs(during.width - rest.width)).toBeLessThanOrEqual(1);
    await page.mouse.up();
    expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionEnd - el.selectionStart)).toBeGreaterThan(0);
  });

  test('every surface in the shell stretches, the navbar included', async ({ page }) => {
    const targets: Array<[string, Locator]> = [
      ['sidebar', page.getByTestId('sidebar-account')],
      ['title pill', page.getByTestId('nav-chat-title-pill')],
      ['action cluster', page.getByTestId('nav-settings-button')],
      ['composer', page.getByTestId('composer-input')],
    ];
    for (const [name, target] of targets) {
      const surface = surfaceOf(target);
      const grew = await realClickAfterPull(page, target, surface);
      expect(grew, name).toBeGreaterThan(4);
      await page.waitForTimeout(1000);
    }
    await expect(page.getByTestId('settings-page')).toHaveCount(0);
  });

  test('the tray stretches, and keeps working after', async ({ page }) => {
    await page.getByTestId('composer-plus-button').click();
    const tray = page.getByTestId('plus-tray');
    await tray.waitFor();
    await landed(tray.locator('xpath=..'));
    const rest = (await tray.boundingBox())!;
    await pull(page, { x: rest.x + rest.width / 2, y: rest.y + 20 }, 0, -120);
    const box = (await tray.boundingBox())!;
    expect(box.y).toBeLessThan(rest.y - 5);
    expect(Math.abs(box.y + box.height - (rest.y + rest.height))).toBeLessThanOrEqual(1);
    await page.mouse.up();
    await expect(tray).toBeVisible();
  });

  test('menus: scrub selects inside; past the edge the glass stretches toward the pointer', async ({ page }) => {
    const row = page.locator('[data-sidebar-row]').first();
    await row.hover();
    const trigger = row.getByRole('button', { name: /^Actions for/ });
    const at = await center(trigger);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    const menu = page.getByRole('menu');
    await menu.waitFor();
    await landed(menu);
    const surface = menu.locator('[data-glass-surface]').first();
    const rest = (await surface.boundingBox())!;
    // Inside: highlights, no stretch.
    await page.mouse.move(rest.x + rest.width / 2, rest.y + 20, { steps: 6 });
    await page.waitForTimeout(120);
    let box = (await surface.boundingBox())!;
    expect(Math.abs(box.width - rest.width)).toBeLessThanOrEqual(1);
    await expect(menu.locator('[data-highlighted]')).toHaveCount(1);
    // Past the right edge: only the right edge moves.
    await page.mouse.move(rest.x + rest.width + 140, rest.y + 20, { steps: 8 });
    await page.waitForTimeout(350);
    box = (await surface.boundingBox())!;
    expect(box.x + box.width).toBeGreaterThan(rest.x + rest.width + 5);
    expect(Math.abs(box.x - rest.x)).toBeLessThanOrEqual(1);
    // Releasing out there selects nothing.
    const url = page.url();
    await page.mouse.up();
    await expect(menu).toHaveCount(0);
    expect(page.url()).toBe(url);
    await expect(page.getByLabel('Chat title')).toHaveCount(0);
  });

  test('a press-drag-release on a menu item selects it', async ({ page }) => {
    const row = page.locator('[data-sidebar-row]').first();
    await row.hover();
    const at = await center(row.getByRole('button', { name: /^Actions for/ }));
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    const rename = page.getByRole('menuitem', { name: 'Rename' });
    await rename.waitFor();
    await landed(page.getByRole('menu'));
    const target = await center(rename);
    await page.mouse.move(target.x, target.y, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByLabel('Chat title')).toBeVisible();
  });

  test('never clipped: no ancestor of a surface clips inside the window', async ({ page }) => {
    const clipped = await page.evaluate(() => {
      const bad: string[] = [];
      for (const surface of document.querySelectorAll('[data-glass-surface]')) {
        for (let el = surface.parentElement; el && el !== document.documentElement; el = el.parentElement) {
          const style = getComputedStyle(el);
          if (style.overflow === 'visible' && style.clipPath === 'none') continue;
          const r = el.getBoundingClientRect();
          // Clipping at the window itself is fine; only an inner clip can cut the stretch.
          if (r.left > 0 || r.top > 0 || r.right < innerWidth || r.bottom < innerHeight) bad.push(`${surface.className} in ${el.className}`);
        }
      }
      return bad;
    });
    expect(clipped).toEqual([]);
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  test('turns the stretch off and keeps the click', async ({ page }) => {
    await signIn(page);
    const surface = sidebar(page);
    const rest = (await surface.boundingBox())!;
    await pull(page, { x: rest.x + 130, y: rest.y + 500 }, 120, 0);
    const box = (await surface.boundingBox())!;
    expect(Math.abs(box.width - rest.width)).toBeLessThanOrEqual(1);
    await page.mouse.up();
  });
});

test.describe('the floating sidebar height', () => {
  const chatsOf = (count: number) => async (page: Page) => {
    // At the fetch layer: a routed response does not reach the page in WebKit here.
    await page.addInitScript((total) => {
      const original = window.fetch;
      window.fetch = async (input, init) => {
        const response = await original(input, init);
        if (!String(input instanceof Request ? input.url : input).includes('/v1/bootstrap') || !response.ok) return response;
        const body = await response.json();
        const template = body.chats[0];
        body.chats = Array.from({ length: total }, (_, i) => ({ ...template, id: `${template.id}-${i}`, title: `Chat ${i + 1}`, pinned: false }));
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
    }, count);
    await signIn(page);
  };
  for (const count of [1, 100]) {
    test(`is the window minus its margins with ${count} chats, and the account row stays visible`, async ({ page }) => {
      await chatsOf(count)(page);
      await page.waitForTimeout(400);
      const box = (await sidebar(page).boundingBox())!;
      const margin = 24; // measured design bottom inset
      expect(box.height).toBe(900 - 18 - margin);
      expect(box.y).toBe(18);
      const account = (await page.getByTestId('sidebar-account').boundingBox())!;
      expect(account.y + account.height).toBeLessThanOrEqual(900 - margin);
      await expect(page.locator('[data-sidebar-row]')).toHaveCount(count);
      const list = page.locator('[data-sidebar-row]').first().locator('xpath=ancestor::*[contains(@class, "list")][1]');
      if (count === 100) expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    });
  }
});

test.describe('settings takes over the floating nav', () => {
  test('the same panel changes to the sections, with no second rail and no Done', async ({ page }) => {
    await signIn(page);
    const panel = sidebar(page);
    await panel.evaluate((el) => { el.setAttribute('data-probe', 'same-node'); });
    const rest = (await panel.boundingBox())!;
    await page.getByTestId('sidebar-account').click();
    await page.getByTestId('settings-page').waitFor();
    await page.getByTestId('settings-nav-connectors').waitFor();
    await page.waitForTimeout(600);
    await expect(page.locator('[data-probe="same-node"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="app-sidebar"] [data-testid="settings-nav-connectors"]')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Done' })).toHaveCount(0);
    expect((await panel.boundingBox())!.height).toBe(rest.height);
    // Content sits in the remaining space, beside the panel.
    const content = (await page.getByRole('group', { name: 'Appearance' }).boundingBox())!;
    expect(content.x).toBeGreaterThan(rest.x + rest.width);
    await page.getByTestId('settings-nav-connectors').click();
    await expect(page).toHaveURL(/connectors/);
    await page.getByTestId('settings-back').click();
    await expect(page.getByTestId('sidebar-new-chat')).toBeVisible();
    await expect(page.getByTestId('settings-page')).toHaveCount(0);
    await expect(page.locator('[data-probe="same-node"]')).toHaveCount(1);
  });

  test('narrow screens follow the same model', async ({ page }) => {
    await page.setViewportSize({ width: 402, height: 874 });
    await signIn(page);
    await page.getByTestId('nav-history-button').click();
    await page.getByTestId('sidebar-account').click();
    await page.getByTestId('settings-page').waitFor();
    // The root keeps the panel open on the sections; a section closes it on its page.
    await page.getByTestId('settings-nav-skills').click();
    await expect(page).toHaveURL(/skills/);
    await expect(page.getByTestId('settings-page')).toHaveAttribute('aria-label', 'Skills');
    await expect(page.getByRole('button', { name: 'Done' })).toHaveCount(0);
    await expect(page.getByTestId('settings-nav-skills')).toHaveCount(0, { timeout: 3000 });
    await page.getByTestId('nav-sidebar-button').click();
    await expect(page.getByTestId('settings-nav-skills')).toBeVisible();
    await page.getByTestId('settings-back').click();
    await expect(page.getByTestId('sidebar-new-chat')).toBeVisible();
  });
});

test.describe('touch inside glass', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Touch input is synthesised over CDP');
  test.use({ hasTouch: true, viewport: { width: 1440, height: 900 } });

  async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number, during: () => Promise<void>) {
    const cdp = await page.context().newCDPSession(page);
    const point = (x: number, y: number) => ({ touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', ...point(from.x, from.y) });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', ...point(from.x + (dx * i) / 12, from.y + (dy * i) / 12) });
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(250);
    await during();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(900);
  }
  const manyChats = (page: Page) =>
    page.addInitScript(() => {
      const original = window.fetch;
      window.fetch = async (input, init) => {
        const response = await original(input, init);
        if (!String(input instanceof Request ? input.url : input).includes('/v1/bootstrap') || !response.ok) return response;
        const body = await response.json();
        const template = body.chats[0];
        body.chats = Array.from({ length: 60 }, (_, i) => ({ ...template, id: `${template.id}-${i}`, title: `Chat ${i + 1}`, pinned: false }));
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
    });
  const listOf = (page: Page) => page.locator('[data-sidebar-row]').first().locator('xpath=ancestor::*[contains(@class, "list")][1]');

  test('a vertical pan scrolls the list instead of stretching', async ({ page }) => {
    await manyChats(page);
    await signIn(page);
    const surface = sidebar(page);
    const rest = (await surface.boundingBox())!;
    const list = listOf(page);
    const box = (await list.boundingBox())!;
    await drag(page, { x: box.x + 100, y: box.y + 300 }, 0, -200, async () => {
      expect(Math.abs((await surface.boundingBox())!.height - rest.height)).toBeLessThanOrEqual(1);
    });
    expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);
  });

  test('sideways stretches, and a pull at the scroll limit stretches', async ({ page }) => {
    await manyChats(page);
    await signIn(page);
    const surface = sidebar(page);
    const rest = (await surface.boundingBox())!;
    const box = (await listOf(page).boundingBox())!;
    await drag(page, { x: box.x + 100, y: box.y + 300 }, 120, 0, async () => {
      expect((await surface.boundingBox())!.width).toBeGreaterThan(rest.width + 5);
    });
    expect(await listOf(page).evaluate((el) => el.scrollTop)).toBe(0);
    await drag(page, { x: box.x + 100, y: box.y + 200 }, 0, 160, async () => {
      expect((await surface.boundingBox())!.height).toBeGreaterThan(rest.height + 5);
    });
  });
});
