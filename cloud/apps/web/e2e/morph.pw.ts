import { expect, test, type Locator, type Page } from '@playwright/test';

// The menu morph, in a real browser, on the lab scene: both button classes in two corners, over text.
test.beforeEach(async ({ page }) => {
  expect((await page.request.post('/v1/auth/dev', { data: { type: 'auth.dev', userId: 'morph-check' } })).ok()).toBeTruthy();
  await page.goto('/lab/glass?morph');
  await page.getByTestId('morph-lab').waitFor();
  await page.waitForTimeout(400);
});

interface Sample {
  t: number;
  menu: { x: number; y: number; w: number; h: number; right: number; bottom: number } | null;
  sourceFade: number;
  sourceBox: { x: number; y: number; w: number; h: number };
  capsule: { x: number; w: number; opacity: string; fade: string; scale: string; transform: string } | null;
  radius: number;
  transform: string;
}

/** Every animation frame: the menu's box and the source's state. */
async function startSampling(page: Page, triggerId: string) {
  await page.evaluate((id) => {
    const w = window as unknown as { __samples: Sample[]; __sampling: boolean };
    w.__samples = [];
    w.__sampling = true;
    const trigger = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    const surface = trigger.closest<HTMLElement>('[data-glass-surface]');
    const start = performance.now();
    const tick = () => {
      if (!w.__sampling) return;
      const menu = document.querySelector<HTMLElement>('[role="menu"]');
      const box = menu?.getBoundingClientRect();
      const glass = menu?.querySelector<HTMLElement>('[data-glass-surface]');
      const t = trigger.getBoundingClientRect();
      const s = surface?.getBoundingClientRect();
      const style = surface ? getComputedStyle(surface) : null;
      w.__samples.push({
        t: performance.now() - start,
        menu: box ? { x: box.x, y: box.y, w: box.width, h: box.height, right: box.right, bottom: box.bottom } : null,
        sourceFade: surface ? Number(style!.getPropertyValue('--glass-fade') || 1) : 1,
        sourceBox: { x: t.x, y: t.y, w: t.width, h: t.height },
        capsule: s && style ? { x: s.x, w: s.width, opacity: style.opacity, fade: style.getPropertyValue('--glass-fade'), scale: style.scale, transform: style.transform } : null,
        radius: glass ? parseFloat(getComputedStyle(glass).borderTopLeftRadius) * (box!.width / menu!.offsetWidth) : 0,
        transform: menu?.style.transform ?? '',
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, triggerId);
}
const stopSampling = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __samples: Sample[]; __sampling: boolean };
    w.__sampling = false;
    return w.__samples;
  });
const landed = (menu: Locator) => expect.poll(() => menu.evaluate((el: HTMLElement) => el.style.transform), { timeout: 10000 }).toBe('');
const biggestStep = (values: number[]) => values.slice(1).reduce((max, v, i) => Math.max(max, Math.abs(v - values[i]!)), 0);

test.describe('a separate button: its glass becomes the menu', () => {
  test('starts on the button, leaves nothing behind, and comes back on close', async ({ page }) => {
    const trigger = page.getByTestId('separate-top');
    const surface = trigger.locator('xpath=ancestor::*[@data-glass-surface][1]');
    const source = (await surface.boundingBox())!;
    await startSampling(page, 'separate-top');
    await trigger.click();
    const menu = page.getByRole('menu');
    await landed(menu);
    expect(await surface.evaluate((el: HTMLElement) => el.style.getPropertyValue('--glass-fade'))).toBe('0');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    expect(await surface.evaluate((el: HTMLElement) => el.style.getPropertyValue('--glass-fade'))).toBe('');
    const samples = (await stopSampling(page)).filter((s) => s.menu);
    const first = samples[0]!.menu!;
    expect(Math.abs(first.x - source.x)).toBeLessThan(2);
    expect(Math.abs(first.y - source.y)).toBeLessThan(2);
    expect(Math.abs(first.w - source.width)).toBeLessThan(2);
    // Near-circle through the fast phase: radius about half the short side when mid-size.
    const mid = samples.find((s) => s.menu!.w > 120)!;
    expect(mid.radius).toBeGreaterThan(Math.min(mid.menu!.w, mid.menu!.h) * 0.4);
    // It returns into the button.
    const last = samples[samples.length - 1]!.menu!;
    expect(Math.abs(last.x - source.x)).toBeLessThan(4);
    expect(Math.abs(last.w - source.width)).toBeLessThan(6);
  });

  test('the button keeps its layout and is not scaled while the menu is open', async ({ page }) => {
    const trigger = page.getByTestId('separate-top');
    const before = (await trigger.boundingBox())!;
    await trigger.click();
    await landed(page.getByRole('menu'));
    const during = (await trigger.boundingBox())!;
    expect(during.x).toBeCloseTo(before.x, 1);
    expect(during.width).toBeCloseTo(before.width, 1);
    await expect(trigger).toBeFocused();
  });
});

test.describe('a button in a bigger object: the object does not change', () => {
  test('the capsule and button stay exactly put; a small blob grows at the button', async ({ page }) => {
    const trigger = page.getByTestId('attached-top');
    const button = (await trigger.boundingBox())!;
    await startSampling(page, 'attached-top');
    await trigger.click();
    const menu = page.getByRole('menu');
    await landed(menu);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    const samples = await stopSampling(page);
    const capsule = samples[0]!.capsule!;
    for (const sample of samples) {
      expect(sample.capsule!.x).toBeCloseTo(capsule.x, 1);
      expect(sample.capsule!.w).toBeCloseTo(capsule.w, 1);
      expect(sample.capsule!.opacity).toBe('1');
      expect(sample.capsule!.fade).toBe('');
      expect(sample.capsule!.scale).toBe('none');
      expect(sample.capsule!.transform).toBe('none');
    }
    const first = samples.find((s) => s.menu)!.menu!;
    expect(first.w).toBeLessThan(button.width);
    expect(Math.abs(first.x + first.w / 2 - (button.x + button.width / 2))).toBeLessThan(2);
    expect(Math.abs(first.y + first.h / 2 - (button.y + button.height / 2))).toBeLessThan(2);
  });

  test('has the same timing and path as a separate button', async ({ page }) => {
    const curve = async (id: string) => {
      await startSampling(page, id);
      await page.getByTestId(id).click();
      const menu = page.getByRole('menu');
      await landed(menu);
      const samples = (await stopSampling(page)).filter((s) => s.menu);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      const final = samples[samples.length - 1]!.menu!.w;
      const t0 = samples[0]!.t;
      return { grown: samples.find((s) => s.menu!.w >= 0.9 * final)!.t - t0, rest: samples[samples.length - 1]!.t - t0 };
    };
    const separate = await curve('separate-top');
    const attached = await curve('attached-top');
    expect(Math.abs(separate.grown - attached.grown)).toBeLessThan(60);
    expect(Math.abs(separate.rest - attached.rest)).toBeLessThan(120);
  });
});

test.describe('a button with text stays in place', () => {
  test('it has its own glass, but only icon buttons morph: the menu grows from a blob at it', async ({ page }) => {
    const trigger = page.getByTestId('text-top');
    const surface = trigger.locator('xpath=ancestor::*[@data-glass-surface][1]');
    const button = (await trigger.boundingBox())!;
    await startSampling(page, 'text-top');
    await trigger.click();
    const menu = page.getByRole('menu');
    await landed(menu);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    const samples = await stopSampling(page);
    for (const sample of samples) expect(sample.capsule!.fade).toBe('');
    const first = samples.find((s) => s.menu)!.menu!;
    expect(first.w).toBeLessThan(button.width / 2);
    expect(await surface.evaluate((el: HTMLElement) => el.style.getPropertyValue('--glass-fade'))).toBe('');
  });
});

test.describe('every frame is one piece of glass', () => {
  test('the rim is there at any scale, through the lens handover and at rest', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as { __rims: Array<{ onScreen: number; alpha: number }>; __on: boolean };
      w.__rims = [];
      w.__on = true;
      const tick = () => {
        if (!w.__on) return;
        const menu = document.querySelector<HTMLElement>('[role="menu"]');
        const rim = menu?.querySelector<HTMLElement>('[data-glass-rim]');
        if (menu && rim) {
          const style = getComputedStyle(rim);
          const local = parseFloat(style.getPropertyValue('--morph-rim'));
          const box = menu.getBoundingClientRect();
          const color = /rgba\([^)]*,\s*([\d.]+)\)/.exec(style.boxShadow);
          w.__rims.push({ onScreen: local * Math.min(box.width / menu.offsetWidth, box.height / menu.offsetHeight), alpha: Number(style.opacity) * Number(color?.[1] ?? 1) });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.getByTestId('attached-top').click();
    await landed(page.getByRole('menu'));
    const rims = await page.evaluate(() => {
      const w = window as unknown as { __rims: Array<{ onScreen: number; alpha: number }>; __on: boolean };
      w.__on = false;
      return w.__rims;
    });
    expect(rims.length).toBeGreaterThan(10);
    // Once the blob has appeared, the line is about 1 px on screen and at full strength in every frame.
    const shown = rims.slice(rims.findIndex((r) => r.alpha > 0.1) + 3);
    for (const rim of shown) {
      expect(rim.onScreen).toBeGreaterThan(0.9);
      expect(rim.onScreen).toBeLessThan(1.15);
      expect(rim.alpha).toBeGreaterThan(0.1);
    }
  });

  test('it holds a circle through the fast phase, squares up late, and overshoots on landing', async ({ page }) => {
    await startSampling(page, 'separate-top');
    await page.getByTestId('separate-top').click();
    const menu = page.getByRole('menu');
    await landed(menu);
    const samples = (await stopSampling(page)).filter((s) => s.menu);
    const rest = samples[samples.length - 1]!.menu!;
    const big = samples.filter((s) => s.menu!.w > rest.w * 0.75 && s.radius > Math.min(s.menu!.w, s.menu!.h) * 0.45);
    expect(big.length).toBeGreaterThan(1);
    for (const s of big) expect(s.menu!.w / s.menu!.h).toBeLessThan(1.12);
    expect(Math.max(...samples.map((s) => s.menu!.w))).toBeGreaterThan(rest.w + 2);
    expect(Math.max(...samples.map((s) => s.menu!.w))).toBeLessThan(rest.w * 1.07);
  });
});

test.describe('the limits', () => {
  test('a menu never passes the width cap, whatever its minWidth or labels; long labels truncate', async ({ page }) => {
    await page.getByTestId('wide-menu').click();
    const menu = page.getByRole('menu');
    await landed(menu);
    expect((await menu.boundingBox())!.width).toBeLessThanOrEqual(280.5);
    const row = menu.getByRole('menuitem').first();
    const clipped = await row.locator('span').filter({ hasText: 'am i missing' }).last().evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped).toBe(true);
  });

  test('rows are pills, with more inset, under instant hover', async ({ page }) => {
    await page.getByTestId('attached-top').click();
    const menu = page.getByRole('menu');
    await landed(menu);
    const row = menu.getByRole('menuitem').first();
    await row.hover();
    await expect(row).toHaveAttribute('data-highlighted', 'true');
    await expect(row).toHaveCSS('padding-left', '16px');
    const box = (await row.boundingBox())!;
    const radius = await row.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
    expect(radius).toBeGreaterThanOrEqual(box.height / 2);
    await expect(row).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  });

  test('the divider is thin and faint', async ({ page }) => {
    await page.getByTestId('attached-top').click();
    const menu = page.getByRole('menu');
    await landed(menu);
    const line = menu.getByRole('separator');
    const box = (await line.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(1);
    const alpha = await line.evaluate((el) => Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(getComputedStyle(el).backgroundColor)?.[1] ?? 1));
    expect(alpha).toBeLessThan(0.08);
  });
});

test.describe('nested menus', () => {
  test('in place: the glass glides to the new height with its rows at rest size, and nothing stacks at the end', async ({ page }) => {
    await page.getByTestId('nested-morph').click();
    const menu = page.getByRole('menu');
    await landed(menu);
    const before = (await menu.boundingBox())!;
    // Read after each paint: a rAF would see the new layout just before the ResizeObserver covers it, which no one sees.
    await page.evaluate(() => {
      const w = window as unknown as { __boxes: Array<{ y: number; h: number }>; __on: boolean };
      w.__boxes = [];
      w.__on = true;
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        const box = document.querySelector('[role="menu"]')?.getBoundingClientRect();
        if (box) w.__boxes.push({ y: box.y, h: box.height });
      };
      const tick = () => {
        if (!w.__on) return;
        channel.port2.postMessage(0);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await menu.getByRole('menuitem', { name: 'Save as', exact: true }).click();
    await expect(menu.getByRole('menuitem', { name: 'Save as TXT' })).toBeVisible();
    await landed(menu);
    const samples = await page.evaluate(() => {
      const w = window as unknown as { __boxes: Array<{ y: number; h: number }>; __on: boolean };
      w.__on = false;
      return w.__boxes;
    });
    const after = (await menu.boundingBox())!;
    expect(after.height).toBeGreaterThan(before.height + 10);
    const heights = samples.map((s) => s.h);
    // Never a jump to the end on the first frame, and it passes through values in between.
    expect(heights.filter((h) => h > before.height + 3 && h < after.height - 3).length).toBeGreaterThan(1);
    expect(biggestStep(heights)).toBeLessThan((after.height - before.height) * 0.6);
    for (const s of samples) expect(Math.abs(s.y - before.y)).toBeLessThan(1.5);
  });

  test('cascade: the submenu is visible beside its row, unclipped, and grows from it', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.getByTestId('nested-cascade').click();
    await landed(page.getByRole('menu').first());
    const row = page.getByRole('menuitem', { name: 'Save as', exact: true });
    const at = (await row.boundingBox())!;
    await row.click();
    const child = page.getByRole('menuitem', { name: 'Save as TXT' });
    await expect(child).toBeVisible();
    await expect.poll(async () => (await child.boundingBox())!.x).toBeGreaterThan(at.x + at.width - 2);
    await expect.poll(() =>
      child.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return !!hit && el.contains(hit);
      }),
    ).toBe(true);
  });
});

test.describe('interruption', () => {
  for (const id of ['separate-top', 'attached-top']) {
    test(`${id}: Escape mid-open reverses from the current shape with no jump`, async ({ page }) => {
      const menu = page.getByRole('menu');
      await startSampling(page, id);
      await page.getByTestId(id).click();
      await page.waitForFunction(() => {
        const box = document.querySelector('[role="menu"]')?.getBoundingClientRect();
        return !!box && box.width > 100;
      });
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      const widths = (await stopSampling(page)).filter((s) => s.menu).map((s) => s.menu!.w);
      const peak = Math.max(...widths);
      expect(peak).toBeLessThan(236 * 1.06);
      expect(widths[widths.length - 1]!).toBeLessThan(60);
      // However coarse the frames, a spring's step, not a teleport from wherever it was to the end.
      expect(biggestStep(widths.slice(widths.indexOf(peak)))).toBeLessThan(peak * 0.75);
    });
  }

  test('re-tapping the button mid-open closes it, and mid-close reopens it from where it is', async ({ page }) => {
    const trigger = page.getByTestId('separate-top');
    const menu = page.getByRole('menu');
    await trigger.click();
    await page.waitForFunction(() => (document.querySelector('[role="menu"]')?.getBoundingClientRect().width ?? 0) > 80);
    await trigger.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="separate-top"]')?.getAttribute('aria-expanded') === 'false');
    await startSampling(page, 'separate-top');
    await trigger.click();
    await landed(menu);
    const widths = (await stopSampling(page)).filter((s) => s.menu).map((s) => s.menu!.w);
    expect(biggestStep(widths)).toBeLessThan(170);
    expect((await menu.boundingBox())!.width).toBeCloseTo(236, 0);
  });

  test('fast repeated toggling ends clean: one menu or none, nothing inline, the source restored', async ({ page }) => {
    const trigger = page.getByTestId('separate-top');
    const surface = trigger.locator('xpath=ancestor::*[@data-glass-surface][1]');
    for (let i = 0; i < 9; i++) {
      await trigger.click();
      await page.waitForTimeout(35 + (i % 3) * 40);
    }
    // Nine toggles: open.
    const menu = page.getByRole('menu');
    await expect(menu).toHaveCount(1);
    await landed(menu);
    await expect(menu.locator('[data-glass-surface]')).not.toHaveAttribute('data-morphing', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    expect(await surface.evaluate((el: HTMLElement) => el.style.getPropertyValue('--glass-fade'))).toBe('');
    await page.getByTestId('attached-top').click();
    await landed(page.getByRole('menu'));
  });

  test('a plain click opens: the release over the growing glass selects nothing', async ({ page }) => {
    for (let i = 0; i < 3; i++) {
      await page.getByTestId('separate-top').click();
      await expect(page.getByTestId('separate-top')).toHaveAttribute('aria-expanded', 'true');
      await landed(page.getByRole('menu'));
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
    }
  });
});

test.describe('the rest of what menus do', () => {
  test('a menu opening upward from the bottom corner grows upward, on screen, and nothing clips it', async ({ page }) => {
    const trigger = page.getByTestId('separate-bottom');
    const source = (await trigger.boundingBox())!;
    await startSampling(page, 'separate-bottom');
    await trigger.click();
    const menu = page.getByRole('menu');
    await landed(menu);
    const samples = (await stopSampling(page)).filter((s) => s.menu);
    const rest = (await menu.boundingBox())!;
    expect(rest.y + rest.height).toBeLessThanOrEqual(source.y);
    // Growing up: the top edge climbs, and it stays on the button's side.
    const mid = samples.find((s) => s.menu!.w > 120)!.menu!;
    expect(mid.y).toBeLessThan(source.y);
    expect(mid.x).toBeLessThan(source.x + source.width);
    expect(mid.x).toBeGreaterThan(-4);
    // Portaled: no ancestor in the lab can clip it.
    expect(await menu.evaluate((el) => el.parentElement === document.body)).toBe(true);
    const clipped = await menu.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !!hit && el.contains(hit);
    });
    expect(clipped).toBe(true);
  });

  test('the stretch works during the settle, and the far side holds', async ({ page }) => {
    const trigger = page.getByTestId('separate-top');
    const at = (await trigger.boundingBox())!;
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.down();
    const menu = page.getByRole('menu');
    const surface = menu.locator('[data-glass-surface]').first();
    await page.waitForFunction(() => (document.querySelector('[role="menu"]') as HTMLElement | null)?.style.pointerEvents === '');
    await page.mouse.move(at.x + at.width / 2, at.y + 420, { steps: 5 });
    await page.waitForTimeout(450);
    const box = (await surface.boundingBox())!;
    const rest = await menu.evaluate((el: HTMLElement) => ({ y: el.offsetTop, h: el.offsetHeight }));
    expect(box.height).toBeGreaterThan(rest.h + 5);
    expect(Math.abs(box.y - rest.y)).toBeLessThan(2);
    await page.mouse.up();
    await expect(menu).toHaveCount(0);
  });

  test('no map or filter value is written while it moves, and nothing runs at rest', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as { __writes: string[]; __observer: MutationObserver };
      w.__writes = [];
      w.__observer = new MutationObserver((list) => {
        for (const m of list) {
          if (m.type === 'attributes' && m.target instanceof SVGElement && m.target.tagName !== 'svg' && m.target.closest('filter')) w.__writes.push(`${m.target.tagName}.${m.attributeName}`);
          if (m.type === 'attributes' && m.attributeName === 'style' && m.target instanceof HTMLElement && m.target.style.filter) {
            if (m.oldValue?.includes('filter') && !m.oldValue.includes(m.target.style.filter)) w.__writes.push(`filter ${m.target.style.filter}`);
          }
        }
      });
      w.__observer.observe(document.body, { subtree: true, attributes: true, attributeOldValue: true });
    });
    const trigger = page.getByTestId('separate-top');
    await trigger.click();
    const menu = page.getByRole('menu');
    await landed(menu);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __writes: string[] }).__writes)).toEqual([]);
    await trigger.click();
    await landed(menu);
    await expect(menu.locator('[class*="blurred"]')).toHaveCount(0);
    await expect(menu.locator('[data-glass-surface]')).toHaveCSS('border-top-left-radius', '42px');
  });

  test('keyboard: opens, moves focus in, Escape returns focus and the source', async ({ page }) => {
    const trigger = page.getByTestId('separate-top');
    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await landed(menu);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

test.describe('prefers-reduced-motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a plain short fade: no scale, no shape change, no copy, the source stays', async ({ page }) => {
    const trigger = page.getByTestId('separate-top');
    const surface = trigger.locator('xpath=ancestor::*[@data-glass-surface][1]');
    await startSampling(page, 'separate-top');
    await trigger.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await page.waitForTimeout(250);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    const samples = (await stopSampling(page)).filter((s) => s.menu);
    expect(samples.length).toBeGreaterThan(1);
    const box = samples[0]!.menu!;
    for (const sample of samples) {
      expect(sample.transform).toBe('');
      expect(sample.menu!.w).toBeCloseTo(box.w, 1);
      expect(sample.menu!.x).toBeCloseTo(box.x, 1);
      expect(sample.radius).toBeCloseTo(42, 0);
    }
    expect(await surface.evaluate((el: HTMLElement) => el.style.getPropertyValue('--glass-fade'))).toBe('');
  });
});
