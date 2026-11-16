import { expect, test, type Page } from '@playwright/test';

// WP-G4 A: what leaves leaves at once, the corner never swaps at rest, and the rows land before the shape.
test.use({ serviceWorkers: 'block' });

async function signIn(page: Page) {
  await page.goto('/');
  const dev = page.getByRole('button', { name: /local dev user/i });
  await Promise.race([dev.waitFor(), page.getByTestId('chat-top-bar').waitFor()]);
  if (await dev.isVisible().catch(() => false)) await dev.click();
  await page.getByTestId('chat-top-bar').waitFor();
}

async function watchClose(page: Page) {
  await page.evaluate(() => {
    type Sample = {present: boolean; closing: boolean; hits: boolean};
    const state = window as unknown as {closeSamples: Sample[]; closeObserver: MutationObserver};
    state.closeSamples = [];
    let closing = false;
    const mark = () => {closing = true;};
    window.addEventListener('keydown', mark, {capture: true, once: true});
    window.addEventListener('pointerdown', mark, {capture: true, once: true});
    state.closeObserver = new MutationObserver(() => {
      if (!closing) return;
      const el = document.querySelector<HTMLElement>('[data-testid="search-palette"]');
      const box = el?.getBoundingClientRect();
      const hit = box ? document.elementFromPoint(box.left + box.width / 2, box.top + 20) : null;
      state.closeSamples.push({present: !!el, closing: el?.dataset.state === 'closing',
        hits: !!(el && hit && el.contains(hit))});
    });
    state.closeObserver.observe(document.body, {subtree: true, childList: true, attributes: true});
  });
}

for (const how of ['Escape', 'an outside click', 'choosing a result'] as const) {
  test(`search closes by ${how}, disabling hit targets before removal`, async ({page}) => {
    await signIn(page);
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByTestId('search-palette');
    const input = palette.getByRole('combobox');
    await input.fill(how === 'choosing a result' ? 'new chat' : 'search the workspace');
    if (how === 'choosing a result') await expect(palette.getByRole('option').first()).toBeVisible();
    else await expect(input).toHaveValue('search the workspace');
    await watchClose(page);
    if (how === 'Escape') await input.press('Escape');
    else if (how === 'an outside click') await page.mouse.click(1300, 760);
    else await palette.getByRole('option').first().click();
    await expect(palette).toHaveCount(0);
    const track = await page.evaluate(() => {
      const state = window as unknown as {closeSamples: {present: boolean; closing: boolean; hits: boolean}[];
        closeObserver: MutationObserver};
      state.closeObserver.disconnect();
      return state.closeSamples;
    });
    const closing = track.filter(sample => sample.closing);
    expect(closing.length).toBeGreaterThan(0);
    expect(closing.some(sample => sample.hits)).toBe(false);
    expect(track.at(-1)?.present).toBe(false);
    await expect(page.locator('[data-testid="search-palette"] [class*="blur"]')).toHaveCount(0);
  });
}

test.describe('menus', () => {
  test.beforeEach(async ({ page }) => {
    expect((await page.request.post('/v1/auth/dev', { data: { type: 'auth.dev', userId: 'close-check' } })).ok()).toBeTruthy();
    await page.goto('/lab/glass?morph');
    await page.getByTestId('morph-lab').waitFor();
    await page.waitForTimeout(400);
  });

  for (const support of ['native corner-shape', 'no corner-shape'] as const) {
    test(`the corner it lands on is the corner at rest, with no late swap (${support})`, async ({ page }) => {
      if (support === 'no corner-shape') {
        await page.addInitScript(() => {
          const original = CSS.supports.bind(CSS);
          CSS.supports = ((a: string, v?: string) => (String(a).includes('corner-shape') ? false : original(a, v as string))) as typeof CSS.supports;
          document.addEventListener('DOMContentLoaded', () => {
            const style = document.createElement('style');
            style.textContent = '*{corner-shape: round !important}';
            document.head.appendChild(style);
          });
        });
        await page.reload();
        await page.getByTestId('morph-lab').waitFor();
      }
      await page.evaluate(() => {
        const w = window as unknown as { __corner: Array<{ r: number; morphing: boolean; round: boolean }> };
        w.__corner = [];
        const tick = () => {
          const surface = document.querySelector<HTMLElement>('[role="menu"] [data-glass-surface]');
          // The corner on screen: the morph writes it against the glass's scale (radius / sx), so read it back at that scale.
          const scale = surface ? surface.getBoundingClientRect().width / surface.offsetWidth : 1;
          if (surface) w.__corner.push({ r: parseFloat(getComputedStyle(surface).borderTopLeftRadius) * scale, morphing: surface.dataset.morphing === 'true', round: surface.dataset.morphRound === 'true' });
          if (w.__corner.length < 400) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await page.getByTestId('attached-top').click();
      const menu = page.getByRole('menu');
      await expect.poll(() => menu.evaluate((el: HTMLElement) => el.style.transform), { timeout: 10000 }).toBe('');
      await page.waitForTimeout(300);
      const track = await page.evaluate(() => (window as unknown as { __corner: Array<{ r: number; morphing: boolean; round: boolean }> }).__corner);
      const rest = track[track.length - 1]!.r;
      // Once the corner has squared it is the rest corner, through the settle and when the inline styles clear.
      const squared = track.findIndex((f, i) => i > 3 && !f.round);
      expect(squared).toBeGreaterThan(0);
      for (const f of track.slice(squared)) expect(Math.abs(f.r - rest), JSON.stringify(f)).toBeLessThan(0.75);
      // And the squared phase starts well before the morph ends (it is not swapped at rest).
      const cleared = track.findIndex((f) => !f.morphing && f !== track[0]);
      expect(cleared - squared).toBeGreaterThan(5);
    });
  }

  test('the rows are sharp, inked and in place before the shape reaches 95 % of its size', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as { __rows: Array<{ t: number; w: number; h: number; rows: number; sharp: number; blur: number }> };
      w.__rows = [];
      let t0 = 0;
      window.addEventListener('pointerdown', () => { t0 = performance.now(); }, { capture: true, once: true });
      const tick = (now: number) => {
        const menu = document.querySelector<HTMLElement>('[role="menu"]');
        if (menu && t0) {
          const box = menu.getBoundingClientRect();
          const body = menu.querySelector<HTMLElement>('[data-morph-body]')!;
          const blurred = menu.querySelector<HTMLElement>('[data-glass-surface] > [class*="blurred"]');
          const scale = new DOMMatrixReadOnly(getComputedStyle(body).transform).a * (box.width / menu.offsetWidth);
          w.__rows.push({ t: now - t0, w: box.width / menu.offsetWidth, h: box.height / menu.offsetHeight, rows: scale, sharp: Number(getComputedStyle(body.firstElementChild!).opacity), blur: blurred ? Number(getComputedStyle(blurred).opacity) : 0 });
        }
        if (!w.__rows.length || w.__rows.length < 200) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.getByTestId('attached-top').click();
    await page.waitForTimeout(800);
    const track = await page.evaluate(() => (window as unknown as { __rows: Array<{ t: number; w: number; h: number; rows: number; sharp: number; blur: number }> }).__rows);
    const shape95 = track.find((f) => f.w >= 0.95 && f.h >= 0.95)!.t;
    const rowsDone = track.find((f) => f.sharp > 0.995 && f.blur < 0.005 && Math.abs(f.rows - 1) < 0.005)!.t;
    expect(rowsDone).toBeLessThanOrEqual(shape95);
    // WP-I1: it lands once. No overshoot to come back from after it has visibly arrived.
    expect(Math.max(...track.map((f) => f.w))).toBeLessThanOrEqual(1.005);
  });
});
