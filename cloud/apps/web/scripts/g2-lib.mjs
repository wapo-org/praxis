// WP-G2: real frames of a menu morph from headed Chromium. The screencast's own timestamps lag by
// hundreds of ms, so each frame carries its true time as a barcode written in the same rAF that
// draws the morph: a frame shows exactly the state at the time it encodes.
import { chromium } from '@playwright/test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
export const BASE = process.env.BASE ?? 'http://127.0.0.1:5231';
export const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/G2`;
export const REF_DIR = `${homedir()}/Downloads/1234___1`;
/** The reference's frames: ms from the press at video time 7.24 s. */
export const REF_FRAMES = [[0, 7854], [80, 7855], [140, 7856], [170, 7857], [230, 7858], [250, 7859], [270, 7861], [290, 7860], [320, 7862], [360, 7863], [380, 7864], [440, 7865], [500, 7866], [620, 7867]];

export const launch = () => chromium.launch({ headless: !!process.env.HEADLESS, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });

export async function open(browser, { width = 402, height = 874, dpr = 2, theme = 'light', path = '/', reducedMotion } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, colorScheme: theme, reducedMotion });
  await context.addInitScript((t) => localStorage.setItem('praxis-theme', t), theme);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.request.post(`${BASE}/v1/auth/dev`, { data: { type: 'auth.dev' } });
  await page.goto(BASE + path);
  return { context, page };
}

/** 12 bits of "ms since the last press or release mark" along the bottom edge, updated every frame. */
export async function installClock(page) {
  await page.evaluate(() => {
    if (window.__clockOn) return;
    window.__clockOn = true;
    const bar = document.createElement('div');
    bar.setAttribute('aria-hidden', 'true');
    bar.style.cssText = 'position:fixed;left:0;bottom:0;display:flex;z-index:2147483647;pointer-events:none';
    const bits = Array.from({ length: 14 }, () => {
      const bit = document.createElement('i');
      bit.style.cssText = 'display:block;width:8px;height:8px;background:#000';
      bar.appendChild(bit);
      return bit;
    });
    document.body.appendChild(bar);
    window.__mark = 0;
    window.__armed = false; // frames before the first press carry no time
    const arm = () => { window.__mark = performance.now(); window.__armed = true; };
    window.addEventListener('pointerdown', arm, { capture: true });
    window.addEventListener('keydown', () => { if (window.__armKeys) arm(); }, { capture: true });
    const tick = (now) => {
      const t = Math.max(0, Math.min(4095, Math.round(now - window.__mark)));
      bits[0].style.background = window.__armed ? '#fff' : '#000';
      bits[13].style.background = '#fff';
      for (let i = 0; i < 12; i++) bits[i + 1].style.background = t & (1 << (11 - i)) ? '#fff' : '#000';
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Record `run`, appending every frame's JPEG to `dir`. Marks restart the clock (pointerdown, keydown). */
export async function record(page, dir, name, run) {
  await mkdir(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  let count = 0;
  const writes = [];
  cdp.on('Page.screencastFrame', async (event) => {
    writes.push(writeFile(`${dir}/${name}-${String(count++).padStart(4, '0')}.jpg`, Buffer.from(event.data, 'base64')));
    await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  const size = await page.evaluate(() => ({ w: innerWidth * devicePixelRatio, h: innerHeight * devicePixelRatio }));
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: size.w, maxHeight: size.h });
  await page.waitForTimeout(100);
  await run();
  await page.waitForTimeout(100);
  await cdp.send('Page.stopScreencast');
  await Promise.all(writes);
  await cdp.detach();
  return count;
}

/** Frames from here on carry no time, until the next press. */
export const disarm = (page) => page.evaluate(() => { window.__armed = false; });
export const clean = (dir) => rm(dir, { recursive: true, force: true });
