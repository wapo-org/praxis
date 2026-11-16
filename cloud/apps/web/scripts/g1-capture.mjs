import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { engines, OUT, openApp, seedChat } from './g1-lib.mjs';
const ONLY = process.env.ONLY?.split(',');
const want = (name) => !ONLY || ONLY.includes(name);
await mkdir(`${OUT}/stills`, { recursive: true });
await mkdir(`${OUT}/strips`, { recursive: true });
await mkdir(`${OUT}/videos`, { recursive: true });
const browser = await engines.chromium.launch();
const chat = process.env.CHAT_PATH ?? (await seedChat(browser, 6));
const BUSY = `.praxis-app-root { background: repeating-linear-gradient(45deg, #d33 0 18px, #fff 18px 36px, #06c 36px 54px, #fff 54px 72px) !important; }`;
const shot = (page, name) => page.screenshot({ path: `${OUT}/stills/${name}.png` });
const settle = (page, ms = 650) => page.waitForTimeout(ms);

async function stills() {
  for (const theme of ['light', 'dark']) {
    for (const [size, width, height] of [['desktop', 1440, 900], ['mobile', 402, 874]]) {
      const name = (screen) => `${size}-${theme}-${screen}`;
      const { context, page } = await openApp(browser, { theme, width, height, path: chat });
      await page.getByTestId('assistant-turn').first().waitFor();
      await settle(page, 900);
      await shot(page, name('chat-bottom'));
      await page.getByTestId('chat-scroll-viewport').evaluate((el) => { el.scrollTop = el.scrollHeight * 0.32; });
      await settle(page, 400);
      await shot(page, name('chat-behind-glass'));
      if (size === 'desktop') {
        const row = page.locator('[data-sidebar-row]').first();
        await row.hover();
        await row.getByRole('button', { name: /^Actions for/ }).click();
        await page.getByRole('menu').waitFor();
        await settle(page);
        await shot(page, name('menu'));
        await page.keyboard.press('Escape');
        await settle(page, 300);
      } else {
        await page.getByTestId('nav-history-button').click();
        await page.getByTestId('app-sidebar').waitFor();
        await settle(page);
        await shot(page, name('history-panel'));
        await page.keyboard.press('Escape');
        await settle(page);
      }
      await page.getByTestId('composer-plus-button').click();
      await page.getByTestId('plus-tray').waitFor();
      await settle(page);
      await shot(page, name('tray'));
      await page.getByTestId('tray-model-picker-trigger').click();
      await settle(page);
      await shot(page, name('tray-models'));
      await page.keyboard.press('Escape');
      await settle(page, 300);
      await page.keyboard.press('Escape');
      await settle(page, 300);
      await page.evaluate(() => { history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); });
      await settle(page, 700);
      await shot(page, name('empty'));
      await page.addStyleTag({ content: BUSY });
      await settle(page, 300);
      await shot(page, name('busy'));
      await context.close();
      for (const [screen, path] of [['settings-root', '/settings'], ['settings-general', '/settings/general'], ['settings-models', '/settings/providers'], ['settings-connectors', '/settings/connectors'], ['settings-skills', '/settings/skills'], ['settings-account', '/settings/account']]) {
        const opened = await openApp(browser, { theme, width, height, path });
        await settle(opened.page, 900);
        await shot(opened.page, name(screen));
        await opened.context.close();
      }
    }
  }
}

/** Record `act`, then keep the one video it made. */
async function record(name, options, act) {
  const dir = `/tmp/g1/video-${name}`;
  await rm(dir, { recursive: true, force: true });
  const started = Date.now();
  const marks = { at: 0, crop: undefined };
  const { context, page } = await openApp(browser, { dpr: 1, video: dir, ...options });
  await settle(page, 700);
  await act(page, (box) => {
    marks.at = (Date.now() - started) / 1000;
    if (!box) return;
    const pad = 110;
    const x = Math.max(0, Math.round(box.x - pad));
    const y = Math.max(0, Math.round(box.y - pad));
    const w = Math.min(1440 - x, Math.round(box.width + pad * 2));
    const h = Math.min(900 - y, Math.round(box.height + pad * 2));
    marks.crop = `${w}:${h}:${x}:${y}`;
  });
  await settle(page, 300);
  await context.close();
  const [file] = await readdir(dir);
  const target = `${OUT}/videos/${name}.webm`;
  await rename(`${dir}/${file}`, target);
  return { video: target, ...marks };
}

/** A contact sheet of consecutive frames from `at`, cropped to the surface. */
function strip({ video, at, crop }, name, seconds = 1.6, tile = '8x3') {
  const filters = [`fps=15`, ...(crop ? [`crop=${crop}`] : []), `scale=380:-1`, `tile=${tile}`];
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.max(0, at)), '-t', String(seconds), '-i', video, '-vf', filters.join(','), '-frames:v', '1', `${OUT}/strips/${name}.png`]);
}

async function pullAndRelease(page, x, y, dx, dy) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  const steps = 18;
  for (let i = 1; i <= steps; i++) { await page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps); await page.waitForTimeout(16); }
  await settle(page, 300);
  await page.mouse.up();
  await settle(page, 1100);
}
const surfaceBox = (page, locator) => locator.locator('xpath=ancestor-or-self::*[@data-glass-surface][1]').boundingBox();
const centerOf = async (locator) => { const b = await locator.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };

async function strips() {
  const targets = [
    ['stretch-sidebar', (p) => p.getByTestId('sidebar-account'), 180, -60],
    ['stretch-sidebar-row', (p) => p.locator('[data-sidebar-row-select]').first(), 180, 40],
    ['stretch-composer', (p) => p.getByTestId('composer-input'), 60, -120],
    ['stretch-navbar', (p) => p.getByTestId('nav-chat-title-pill'), 120, 90],
    ['stretch-cluster', (p) => p.getByTestId('nav-settings-button'), -120, 70],
  ];
  for (const [name, target, dx, dy] of targets) {
    const take = await record(name, { path: chat }, async (page, mark) => {
      await page.getByTestId('assistant-turn').first().waitFor();
      await page.getByTestId('chat-scroll-viewport').evaluate((el) => { el.scrollTop = el.scrollHeight * 0.32; });
      await settle(page, 500);
      const [x, y] = await centerOf(target(page));
      mark(await surfaceBox(page, target(page)));
      await pullAndRelease(page, x, y, dx, dy);
    });
    strip(take, name);
  }
  const tray = await record('stretch-tray', { path: chat }, async (page, mark) => {
    await page.getByTestId('composer-plus-button').click();
    await page.getByTestId('plus-tray').waitFor();
    await settle(page);
    const [x, y] = await centerOf(page.getByTestId('plus-tray'));
    mark(await page.getByTestId('plus-tray').boundingBox());
    await pullAndRelease(page, x, y, 150, -80);
  });
  strip(tray, 'stretch-tray');
}

async function videos() {
  const sidebar = await record('sidebar-collapse', { path: chat }, async (page, mark) => {
    mark();
    for (let i = 0; i < 2; i++) {
      await page.getByTestId('sidebar-toggle').click();
      await settle(page, 700);
      await page.getByTestId('nav-sidebar-button').click();
      await settle(page, 700);
    }
    // Interrupt: reverse mid-flight.
    await page.getByTestId('sidebar-toggle').click();
    await page.waitForTimeout(90);
    await page.getByTestId('nav-sidebar-button').click({ timeout: 2000 }).catch(() => {});
    await settle(page, 800);
  });
  strip(sidebar, 'sidebar-collapse', 1.6);
  const settings = await record('settings-transition', { path: chat }, async (page, mark) => {
    mark();
    await page.getByTestId('sidebar-account').click();
    await settle(page, 900);
    for (const section of ['providers', 'connectors', 'general']) {
      await page.getByTestId(`settings-nav-${section}`).click();
      await settle(page, 600);
    }
    await page.getByTestId('settings-back').click();
    await settle(page, 900);
  });
  strip(settings, 'settings-transition', 1.6);
  const trayOpen = await record('tray-open', { path: chat }, async (page, mark) => {
    mark();
    for (let i = 0; i < 2; i++) {
      await page.getByTestId('composer-plus-button').click();
      await settle(page, 800);
      await page.getByTestId('composer-plus-button').click();
      await settle(page, 700);
    }
  });
  strip(trayOpen, 'tray-open', 1.6);
  await record('stretching', { path: chat }, async (page) => {
    await page.getByTestId('chat-scroll-viewport').evaluate((el) => { el.scrollTop = el.scrollHeight * 0.32; });
    for (const [target, dx, dy] of [[page.getByTestId('sidebar-account'), 180, -60], [page.getByTestId('composer-input'), 60, -120], [page.getByTestId('nav-chat-title-pill'), 120, 90]]) {
      const [x, y] = await centerOf(target);
      await pullAndRelease(page, x, y, dx, dy);
    }
  });
}

if (want('strips')) await strips();
if (want('videos')) await videos();
if (want('stills')) await stills();
await browser.close();
console.log('saved to', OUT);
