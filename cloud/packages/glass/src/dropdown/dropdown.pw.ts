import { expect } from '@playwright/test';
import { signedInTest as test } from '../../../verify/src/web/stack-test.js';
const shot = (info: import('@playwright/test').TestInfo, name: string) => info.outputPath(name);
test.beforeEach(async ({ page }) => {
  await page.goto('/lab/glass?dropdown');
  await page.getByTestId('position-top-start').waitFor();
  await page.evaluate(() => document.fonts.ready);
});

test('measures, flips, shifts and sizes at nine viewport anchors', async ({
  page,
}, info) => {
  for (const width of [402, 1440]) {
    await page.setViewportSize({ width, height: width === 402 ? 874 : 900 });
    for (const row of ['top', 'middle', 'bottom'])
      for (const align of ['start', 'center', 'end']) {
        const trigger = page.getByTestId(`position-${row}-${align}`);
        await trigger.click();
        const menu = page.getByRole('menu');
        await expect(menu).toBeVisible();
        await expect(async () => {
          const box = await menu.boundingBox();
          const origin = await menu.evaluate((el) =>
            parseFloat(getComputedStyle(el).transformOrigin),
          );
          const anchor = await trigger.boundingBox();
          expect(origin).toBeCloseTo(anchor!.x + anchor!.width / 2 - box!.x, 0);
          expect(box!.x).toBeGreaterThanOrEqual(7.5);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width - 7.5);
          expect(box!.y).toBeGreaterThanOrEqual(7.5);
          expect(box!.y + box!.height).toBeLessThanOrEqual(
            (width === 402 ? 874 : 900) - 7.5,
          );
        }).toPass();
        if (row === 'top' && align === 'end')
          await page.screenshot({
            path: shot(info, `IMG_7752-${info.project.name}-${width}.png`),
          });
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
      }
  }
});

test('focus, disabled skipping, navigation, typeahead, selection, Escape and Tab', async ({
  page,
}) => {
  const trigger = page.getByTestId('position-top-start');
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await expect(
    page.getByRole('menuitem', { name: 'Scan', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('PageDown');
  await expect(
    page.getByRole('menuitem', { name: 'Recent chats' }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(
    page.getByRole('menuitem', { name: 'Math Results' }),
  ).toBeFocused();
  await page.keyboard.press('PageUp');
  await expect(
    page.getByRole('menuitem', { name: 'Pin Note', exact: true }),
  ).toBeFocused();
  await page.keyboard.type('mov');
  await expect(page.getByRole('menuitem', { name: 'Move Note' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('position-top-center')).toBeFocused();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await trigger.click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press(' ');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await trigger.click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('combobox/listbox ARIA, logical virtualization, filter reset, unique favorites, sibling pin action', async ({
  page,
}) => {
  await page.getByTestId('position-models').click();
  const search = page.getByRole('combobox');
  const list = page.getByRole('listbox');
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute(
    'aria-controls',
    (await list.getAttribute('id')) as string,
  );
  await expect(search).toHaveAttribute('aria-expanded', 'true');
  expect(await search.getAttribute('aria-label')).toBeTruthy();
  expect(await page.locator('button button').count()).toBe(0);
  await expect(page.getByRole('option')).toHaveCount(18);
  await expect(
    page.getByRole('option', { name: 'Model 001', exact: true }),
  ).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(
    page.getByRole('option', { name: 'Model 001', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(
    page.getByRole('option', { name: 'Model 003', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('option', { name: 'Model 500' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(
    page.getByRole('option', { name: 'Model 001', exact: true }),
  ).toBeFocused();
  await search.fill('Model 499');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('position-models')).toContainText('Model 499');
  await page.getByTestId('position-models').click();
  await page.getByRole('combobox').fill('');
  await page
    .getByRole('button', { name: 'Pin Model 001', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Pin Model 001', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('listbox')).toBeVisible();
  expect(await list.locator('[role^="menuitem"]').count()).toBe(0);
  for (const option of await list.getByRole('option').all()) {
    await expect(option).toHaveAttribute('aria-selected', /true|false/);
    expect((await option.textContent())?.trim()).toBeTruthy();
  }
});

test('mouse and touch press-drag-release select; outside release and cancel dismiss', async ({
  page,
}) => {
  for (const pointerType of ['mouse', 'touch']) {
    const trigger = page.getByTestId('position-top-start');
    await expect(trigger).toHaveCSS('touch-action', 'none');
    await trigger.dispatchEvent('pointerdown', {
      pointerId: 7,
      pointerType,
      button: 0,
      clientX: 25,
      clientY: 20,
    });
    const target = page.getByRole('menuitem', { name: 'Move Note' });
    await expect(target).toBeVisible();
    await expect(async () => expect((await page.getByRole('menu').boundingBox())!.width).toBeCloseTo(240, 0)).toPass();
    const box = await target.boundingBox();
    const point = {
      pointerId: 7,
      pointerType,
      clientX: box!.x + 30,
      clientY: box!.y + box!.height / 2,
    };
    await page.locator('body').dispatchEvent('pointermove', point);
    await expect(target).toHaveAttribute('data-highlighted', 'true');
    await trigger.dispatchEvent('pointerup', point);
    await expect(page.getByTestId('dropdown-selections')).toHaveText(
      pointerType === 'mouse' ? '1' : '2',
    );
    await expect(page.getByRole('menu')).toHaveCount(0);
    await trigger.dispatchEvent('pointerdown', {
      pointerId: 8,
      pointerType,
      button: 0,
    });
    await page.locator('body').dispatchEvent('pointerup', {
      pointerId: 8,
      pointerType,
      clientX: 400,
      clientY: 800,
    });
    await expect(page.getByRole('menu')).toHaveCount(0);
    await trigger.dispatchEvent('pointerdown', {
      pointerId: 9,
      pointerType,
      button: 0,
    });
    await page
      .locator('body')
      .dispatchEvent('pointercancel', { pointerId: 9, pointerType });
    await expect(page.getByRole('menu')).toHaveCount(0);
  }
});

test('translucent frosted material guarantees AA over every background luminance', async ({
  page,
}) => {
  await page.getByTestId('position-top-start').click();
  const result = await page
    .getByRole('menuitem', { name: 'Move Note' })
    .evaluate((el) => {
      const bg = getComputedStyle(
        el.closest('.praxis-glass-surface') ?? el.parentElement!,
      ).backgroundColor;
      let node: Element | null = el;
      const backgrounds: string[] = [];
      while (node) {
        backgrounds.push(getComputedStyle(node).backgroundColor);
        node = node.parentElement;
      }
      return {
        bg,
        backgrounds,
        tint: getComputedStyle(el.closest('.praxis-glass-surface')!).getPropertyValue('--glass-tint'),
        colors: [
          getComputedStyle(el).color,
          getComputedStyle(
            el
              .closest('[role="menu"]')!
              .querySelector('[data-tone="destructive"]')!,
          ).color,
        ],
      };
    });
  await expect(page.getByRole('menu')).toHaveCSS('filter', 'none');
  const [tr, tg, tb, ta] = result.tint.match(/[\d.]+/g)!.map(Number) as [number, number, number, number];
  expect(ta).toBeGreaterThanOrEqual(0.7);
  const luminance = (rgb: number[]) =>
    rgb
      .map((v) => v / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  for (const color of result.colors) {
    const text = luminance(
      color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number),
    );
    for (const underlying of [0, 255]) {
      const background = luminance(
        [tr, tg, tb].map((v) => v * ta + underlying * (1 - ta)),
      );
      expect((background + 0.05) / (text + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('submenu header rises in one sheet, expands and reverses; reduced motion never scales', async ({
  page,
}, info) => {
  await page.getByTestId('position-top-end').click();
  const menu = page.getByRole('menu');
  // Geometry is only meaningful once the glass has landed: the morph leaves nothing inline at rest.
  await expect.poll(() => menu.evaluate((el: HTMLElement) => el.style.transform)).toBe('');
  const old = await menu.boundingBox();
  const recent = page.getByRole('menuitem', { name: 'Recent chats' });
  const row = await recent.boundingBox();
  await recent.click();
  await expect(page.getByRole('menuitem')).toHaveCount(6);
  const header = page.getByRole('menuitem', { name: 'Recent chats' });
  await expect(async () =>
    expect((await header.boundingBox())!.y).toBeLessThan(row!.y),
  ).toPass();
  await expect(menu).toHaveCount(1);
  await expect(header.locator('[data-submenu-chevron]')).toHaveAttribute(
    'data-submenu-chevron',
    'expanded',
  );
  await expect(async () => {
    const matrix = await header
      .locator('[data-submenu-chevron]')
      .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).b);
    expect(matrix).toBeCloseTo(1, 2);
  }).toPass();
  await expect(async () =>
    expect((await menu.boundingBox())!.height).toBeGreaterThan(old!.height),
  ).toPass();
  await page.screenshot({
    path: shot(info, `IMG_7774-${info.project.name}.png`),
  });
  await header.click();
  await expect(page.getByRole('menuitem', { name: 'Move Note' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByTestId('position-top-end').click();
  const transforms = await menu.evaluate(async (el) => {
    const values = [];
    for (let i = 0; i < 8; i++) {
      await new Promise(requestAnimationFrame);
      values.push(getComputedStyle(el).transform);
    }
    return values;
  });
  for (const transform of transforms)
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(transform);
});

test('native mouse drag selects exactly once and suppressed release click cannot select twice', async ({
  page,
}) => {
  const trigger = page.getByTestId('position-top-start');
  const box = await trigger.boundingBox();
  await page.mouse.move(box!.x + 20, box!.y + 15);
  await page.mouse.down();
  const item = page.getByRole('menuitem', { name: 'Move Note' });
  await expect(item).toBeVisible();
  await expect(async () => expect((await page.getByRole('menu').boundingBox())!.width).toBeCloseTo(240, 0)).toPass();
  const target = await item.boundingBox();
  await page.mouse.move(target!.x + 50, target!.y + target!.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
  await expect(page.getByTestId('dropdown-selections')).toHaveText('1');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('menu motion captures stay on-screen inside the lab card', async ({
  page,
}, info) => {
  await page.goto('/lab/glass');
  const trigger = page.getByTestId('motion-preview-trigger');
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const id = await trigger.getAttribute('aria-controls');
  const sheet = page.locator(`[id="${id}"]`);
  await expect(sheet).toBeVisible();
  await expect(sheet).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: shot(info, `IMG_7752-replica-${info.project.name}.png`),
  });
  await page.getByTestId('recent-chats-subtrigger').click();
  await expect(
    page.getByRole('menuitem', { name: 'Recent chats', exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('menuitem', { name: 'Recent chats', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await page.screenshot({
    path: shot(info, `IMG_7774-replica-${info.project.name}.png`),
  });
});

test('a cascade near a narrow viewport edge flips, shifts and keeps its final item visible',async({page})=>{
 await page.setViewportSize({width:402,height:450});
 await page.goto('/lab/glass?morph');
 await page.getByTestId('nested-cascade').click();
 await page.getByRole('menuitem',{name:'Save as',exact:true}).click();
 const last=page.getByRole('menuitem',{name:'Save as HTML',exact:true});
 await expect(last).toBeVisible();
 await expect(async()=>{
  const menu=await last.locator('xpath=ancestor::*[@role="menu"][1]').boundingBox();
  expect(menu!.x).toBeGreaterThanOrEqual(7.5);
  expect(menu!.x+menu!.width).toBeLessThanOrEqual(394.5);
  expect(menu!.y).toBeGreaterThanOrEqual(7.5);
  expect(menu!.y+menu!.height).toBeLessThanOrEqual(442.5);
 }).toPass();
});

test('an in-place submenu grows monotonically: no frame steps back toward the old size', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto('/lab/glass');
  const trigger = page.getByTestId('motion-preview-trigger');
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const log: number[] = ((window as any).__heights = []);
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      const s = document.querySelector('.praxis-glass-dropdown-content [data-glass-surface]');
      if (s) log.push(s.getBoundingClientRect().height);
    };
    const loop = () => { ch.port2.postMessage(0); if (log.length < 60) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  await page.getByTestId('recent-chats-subtrigger').click();
  await page.waitForFunction(() => (window as any).__heights.length >= 60);
  const heights: number[] = await page.evaluate(() => (window as any).__heights);
  const from = heights[0]!, to = heights.at(-1)!;
  expect(to).toBeGreaterThan(from + 100);
  let peak = from, backstep = 0;
  for (const h of heights) { backstep = Math.max(backstep, peak - h); peak = Math.max(peak, h); }
  expect(backstep).toBeLessThan(0.5);
  const layout = await page.evaluate(() => (document.querySelector('[data-dropdown-panel]:not([inert])') as HTMLElement).offsetHeight);
  expect(layout).toBeGreaterThan(0);
});

test('a text trigger is one surface, open or closed', async ({ page }) => {
  for (const url of ['/lab/glass?dropdown', '/lab/glass']) {
    await page.goto(url);
    const trigger = page.getByTestId('position-top-start');
    await trigger.scrollIntoViewIfNeeded();
    const read = () => trigger.evaluate((button) => {
      const surface = button.parentElement!;
      const solid = surface.querySelector(':scope > [data-glass-solid]')!;
      const b = button.getBoundingClientRect(), s = surface.getBoundingClientRect();
      return { fill: getComputedStyle(button).backgroundColor, solid: getComputedStyle(solid).backgroundColor, dw: s.width - b.width, dh: s.height - b.height };
    });
    const closed = await read();
    await trigger.click();
    await expect(trigger).toHaveAttribute('data-state', 'open');
    const open = await read();
    for (const state of [closed, open]) {
      expect(state.fill).toBe('rgba(0, 0, 0, 0)');
      expect(Math.abs(state.dw)).toBeLessThan(0.5);
      expect(Math.abs(state.dh)).toBeLessThan(0.5);
    }
    expect(open.solid).not.toBe(closed.solid);
    await page.keyboard.press('Escape');
  }
});

test('without corner-shape the menu lines are strokes of the clip path', async ({ page }) => {
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((a: string, b?: string) => (String(a).includes('corner-shape') ? false : b === undefined ? supports(a) : supports(a, b))) as typeof CSS.supports;
    document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '*{corner-shape: round !important}'; document.head.append(s); });
  });
  await page.goto('/lab/glass?dropdown');
  await page.getByTestId('position-top-start').click();
  const surface = page.locator('.praxis-glass-dropdown-content [data-glass-surface]').first();
  await expect(surface).toHaveAttribute('data-glass-path', 'true');
  await expect(async () => {
    const state = await surface.evaluate((el) => {
      const outline = el.querySelector(':scope > [data-glass-outline]')!;
      const clip = getComputedStyle(el.querySelector(':scope > [data-glass-lens]')!).clipPath;
      const edge = outline.querySelector('path[data-inset="0.5"]')!.getAttribute('d') ?? '';
      return {
        shown: getComputedStyle(outline).display,
        rim: getComputedStyle(el.querySelector(':scope > [data-glass-rim]')!).boxShadow,
        lens: getComputedStyle(el.querySelector(':scope > [data-glass-lens]')!).boxShadow.split('inset').length - 1,
        clip: clip.startsWith('path('),
        edge: edge.length > 100,
        round: el.dataset.morphRound ?? null,
      };
    });
    expect(state).toEqual({ shown: 'block', rim: 'none', lens: 2, clip: true, edge: true, round: null });
  }).toPass();
});
