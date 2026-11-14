// WP-G2 visual gate: frame strips and videos of open, close and interrupted open for both classes,
// in the lab scene and in the real app. Frames are real screencast frames, placed by the barcode.
//   BASE=http://127.0.0.1:5231 ONLY=open,close,interrupted,real THEME=light node apps/web/scripts/g2-capture.mjs
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { clean, disarm, installClock, launch, open, OUT, record } from './g2-lib.mjs';
const here = new URL('.', import.meta.url).pathname;
const THEME = process.env.THEME ?? 'light';
const ONLY = process.env.ONLY?.split(',');
const want = (name) => !ONLY || ONLY.includes(name);
const RUNS = Number(process.env.RUNS ?? 8);
const STRIPS = `${OUT}/strips`;
const VIDEOS = `${OUT}/videos`;
await mkdir(STRIPS, { recursive: true });
await mkdir(VIDEOS, { recursive: true });
const browser = await launch();
const OPEN_TIMES = [0, 40, 80, 100, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250, 260, 270, 280, 290, 300, 320, 340, 360, 400, 500];
const CLOSE_TIMES = [0, 8, 16, 24, 32, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 170, 190, 210, 240];
const INTERRUPT_TIMES = [100, 130, 150, 170, 180, 190, 200, 210, 220, 230, 240, 250, 260, 270, 280, 290, 300, 310, 320, 340, 360];
const LAB_CROP = [130, 0, 402, 300];
const name = (which, kind) => `${which}-${kind}${THEME === 'light' ? '' : `-${THEME}`}`;

function strip(dir, out, times, crop, viewport = [402, 874], cols = 7, select) {
  execFileSync('python3', [`${here}g2-board.py`, dir, out, JSON.stringify({ viewport, crop, times, cols, select })], { stdio: 'inherit' });
}

/** Slow motion from every distinct frame of several identical runs, in true time order. */
function slowmo(dir, out, viewportWidth = 402) {
  execFileSync('python3', [`${here}g2-slowmo.py`, dir, out, String(viewportWidth)], { stdio: 'inherit' });
}

/** A real-time recording, with no capture hooks in the page. */
async function realtime(which, kind, act) {
  const dir = `/tmp/g2-video-${which}-${kind}`;
  await rm(dir, { recursive: true, force: true });
  const context = await browser.newContext({ viewport: { width: 402, height: 500 }, deviceScaleFactor: 2, colorScheme: THEME, recordVideo: { dir, size: { width: 804, height: 1000 } } });
  await context.addInitScript((t) => localStorage.setItem('praxis-theme', t), THEME);
  const page = await context.newPage();
  await page.request.post(`${process.env.BASE ?? 'http://127.0.0.1:5231'}/v1/auth/dev`, { data: { type: 'auth.dev' } });
  await page.goto(`${process.env.BASE ?? 'http://127.0.0.1:5231'}/lab/glass?morph`);
  await page.getByTestId(`${which}-top`).waitFor();
  await page.waitForTimeout(600);
  await act(page, page.getByTestId(`${which}-top`));
  await page.waitForTimeout(400);
  await context.close();
  const [file] = await readdir(dir);
  await rename(`${dir}/${file}`, `${VIDEOS}/${name(which, kind)}-realtime.webm`);
}

const landed = (page) => page.waitForFunction(() => { const m = document.querySelector('[role=menu]'); return m && m.style.transform === ''; });

for (const which of ['separate', 'attached']) {
  const { context, page } = await open(browser, { path: '/lab/glass?morph', theme: THEME });
  const trigger = page.getByTestId(`${which}-top`);
  await trigger.waitFor();
  await installClock(page);
  await page.waitForTimeout(800);

  if (want('open')) {
    const dir = `/tmp/g2-frames/${name(which, 'open')}`;
    await clean(dir);
    for (let run = 0; run < RUNS; run++) {
      await record(page, dir, `r${run}`, async () => {
        await trigger.click();
        await page.waitForTimeout(600);
        await disarm(page);
      });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(450);
    }
    strip(dir, `${STRIPS}/${name(which, 'open')}.png`, OPEN_TIMES, LAB_CROP);
    slowmo(dir, `${VIDEOS}/${name(which, 'open')}-slowmo.mp4`);
    await realtime(which, 'open', async (p, t) => { for (let i = 0; i < 3; i++) { await t.click(); await p.waitForTimeout(900); await p.keyboard.press('Escape'); await p.waitForTimeout(600); } });
  }

  if (want('close')) {
    const dir = `/tmp/g2-frames/${name(which, 'close')}`;
    await clean(dir);
    await page.evaluate(() => { window.__armKeys = true; });
    for (let run = 0; run < RUNS; run++) {
      await disarm(page);
      await trigger.click();
      await landed(page);
      await disarm(page);
      await page.waitForTimeout(100);
      await record(page, dir, `r${run}`, async () => {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(420);
        await disarm(page);
      });
      await page.waitForTimeout(100);
    }
    await page.evaluate(() => { window.__armKeys = false; });
    strip(dir, `${STRIPS}/${name(which, 'close')}.png`, CLOSE_TIMES, LAB_CROP);
    slowmo(dir, `${VIDEOS}/${name(which, 'close')}-slowmo.mp4`);
  }

  if (want('interrupted')) {
    const dir = `/tmp/g2-frames/${name(which, 'interrupted')}`;
    await clean(dir);
    for (let run = 0; run < RUNS; run++) {
      await record(page, dir, `r${run}`, async () => {
        // Escape exactly 170 ms after the press, from inside the page, so every run is the same motion.
        await page.evaluate((id) => {
          window.addEventListener('pointerdown', () => {
            setTimeout(() => document.querySelector(`[data-testid="${id}"]`).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), 170);
          }, { once: true, capture: true });
        }, `${which}-top`);
        await trigger.click();
        await page.waitForTimeout(500);
        await disarm(page);
      });
      await page.waitForTimeout(250);
    }
    strip(dir, `${STRIPS}/${name(which, 'interrupted')}.png`, INTERRUPT_TIMES, LAB_CROP);
    slowmo(dir, `${VIDEOS}/${name(which, 'interrupted')}-slowmo.mp4`);
    await realtime(which, 'interrupted', async (p, t) => {
      for (let i = 0; i < 3; i++) { await t.click(); await p.waitForTimeout(170); await p.keyboard.press('Escape'); await p.waitForTimeout(600); }
      for (let i = 0; i < 9; i++) { await t.click(); await p.waitForTimeout(90); }
      await p.waitForTimeout(700);
    });
  }
  await context.close();
}

if (want('real')) {
  // The real app, over a real chat: a chat row's menu (attached) and the composer tray (attached).
  const { context, page } = await open(browser, { width: 1440, height: 900, dpr: 2, theme: THEME, path: process.env.CHAT_PATH ?? '/' });
  const dev = page.getByRole('button', { name: /local dev user/i });
  if (await dev.isVisible({ timeout: 1500 }).catch(() => false)) await dev.click();
  await page.getByTestId('chat-top-bar').waitFor();
  await installClock(page);
  await page.waitForTimeout(800);
  const row = page.locator('[data-sidebar-row]').first();
  const box = await row.boundingBox();
  const dir = `/tmp/g2-frames/${name('real', 'row')}`;
  await clean(dir);
  for (let run = 0; run < RUNS; run++) {
    await row.hover();
    await record(page, dir, `r${run}`, async () => {
      await row.getByRole('button', { name: /^Actions for/ }).click();
      await page.waitForTimeout(600);
      await disarm(page);
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(450);
  }
  strip(dir, `${STRIPS}/${name('real', 'row')}.png`, OPEN_TIMES, [box.x, Math.max(0, box.y - 20), box.x + 300, Math.max(0, box.y - 20) + 300], [1440, 900]);
  slowmo(dir, `${VIDEOS}/${name('real', 'row')}-slowmo.mp4`, 1440);
  const plus = await page.getByTestId('composer-plus-button').boundingBox();
  const trayDir = `/tmp/g2-frames/${name('real', 'tray')}`;
  await clean(trayDir);
  for (let run = 0; run < RUNS; run++) {
    await record(page, trayDir, `r${run}`, async () => {
      await page.getByTestId('composer-plus-button').click();
      await page.waitForTimeout(650);
      await disarm(page);
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(450);
  }
  strip(trayDir, `${STRIPS}/${name('real', 'tray')}.png`, OPEN_TIMES, [plus.x - 20, plus.y - 480, plus.x + 400, plus.y + 60], [1440, 900]);
  slowmo(trayDir, `${VIDEOS}/${name('real', 'tray')}-slowmo.mp4`, 1440);
  await context.close();
}
await browser.close();
