// WP-G4 A captures: WebKit corner over time (video frames, native and without corner-shape), the search close
// frame by frame (headed Chromium, barcode clock), and the model list's trailing icons.
//   BASE=http://127.0.0.1:5231 node apps/web/scripts/g4-captures.mjs
import { webkit } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { clean, installClock, launch, open, record } from './g2-lib.mjs';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5231';
const OUT = process.env.OUT ?? `${homedir()}/.praxis-agent-state/cloud/design/G4/A`;
const here = new URL('.', import.meta.url).pathname;
await mkdir(`${OUT}/videos`, { recursive: true });

for (const mode of process.env.ONLY && !process.env.ONLY.includes('corner') ? [] : ['native', 'no-corner-shape']) {
  const dir = `/tmp/g4-wk-${mode}`;
  await rm(dir, { recursive: true, force: true });
  const browser = await webkit.launch();
  const context = await browser.newContext({ viewport: { width: 402, height: 420 }, deviceScaleFactor: 2, recordVideo: { dir, size: { width: 804, height: 840 } } });
  if (mode !== 'native') await context.addInitScript(() => {
    const original = CSS.supports.bind(CSS);
    CSS.supports = (a, v) => (String(a).includes('corner-shape') ? false : original(a, v));
    document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '*{corner-shape: round !important}'; document.head.appendChild(s); });
  });
  const page = await context.newPage();
  await page.request.post(`${BASE}/v1/auth/dev`, { data: { type: 'auth.dev' } });
  await page.goto(`${BASE}/lab/glass?morph`);
  await page.getByTestId('attached-top').waitFor();
  await page.waitForTimeout(1000);
  await page.getByTestId('attached-top').click();
  await page.waitForTimeout(1200);
  await context.close();
  await browser.close();
  const [file] = await readdir(dir);
  const video = `${OUT}/videos/webkit-corner-${mode}.webm`;
  await rename(`${dir}/${file}`, video);
  // Every frame from 0.9 s to 2.3 s of the recording, the menu's top-left corner enlarged.
  const frames = `/tmp/g4-wk-frames-${mode}`;
  await rm(frames, { recursive: true, force: true });
  await mkdir(frames);
  // The video draws the 402 px viewport at 1x in its top-left; the menu's top-right corner is near (390, 58).
  execFileSync('ffmpeg', ['-loglevel', 'error', '-i', video, '-vf', 'crop=70:70:332:36,scale=200:200:flags=neighbor', `${frames}/f%03d.png`]);
  execFileSync('python3', ['-c', `
import glob
from PIL import Image, ImageDraw
fs = sorted(glob.glob('${frames}/*.png'))
# keep frames where something changes, plus every 3rd
keep = []
last = None
for f in fs:
    im = Image.open(f).convert('L')
    if last is None or sum(abs(a - b) for a, b in zip(im.getdata(), last.getdata())) > 2000: keep.append(f)
    last = im
keep = keep[:32]
cols = 8
b = Image.new('RGB', (cols * 204, ((len(keep) + cols - 1) // cols) * 216), (30, 30, 30))
d = ImageDraw.Draw(b)
for i, f in enumerate(keep):
    x, y = (i % cols) * 204, (i // cols) * 216
    b.paste(Image.open(f).convert('RGB'), (x, y + 14))
    d.text((x + 2, y), f.split('/')[-1], fill=(255, 220, 90))
b.save('${OUT}/webkit-corner-${mode}.png')
`]);
}

// Search close, headed Chromium, frames placed by the barcode clock (Escape arms it).
if (!process.env.ONLY || process.env.ONLY.includes('search')) {
  const browser = await launch();
  const { page } = await open(browser, { path: '/', width: 1440, height: 900, dpr: 1 });
  const dev = page.getByRole('button', { name: /local dev user/i });
  if (await dev.isVisible({ timeout: 1500 }).catch(() => false)) await dev.click();
  await page.getByTestId('chat-top-bar').waitFor();
  await installClock(page);
  await page.evaluate(() => { window.__armKeys = true; });
  const dir = '/tmp/g4-search-close';
  await clean(dir);
  for (let run = 0; run < 5; run++) {
    await page.evaluate(() => window.dispatchEvent(new Event('praxis:search')));
    const input = page.getByTestId('search-palette').getByRole('combobox');
    await input.waitFor();
    await page.waitForTimeout(250);
    await input.fill('search the workspace');
    await page.waitForTimeout(600);
    await page.evaluate(() => { window.__armed = false; });
    await record(page, dir, `r${run}`, async () => { await input.press('Escape'); await page.waitForTimeout(300); await page.evaluate(() => { window.__armed = false; }); });
    await page.waitForTimeout(250);
  }
  await browser.close();
  execFileSync('python3', [`${here}g2-board.py`, dir, `${OUT}/search-close.png`, JSON.stringify({ viewport: [1440, 900], crop: [360, 60, 1080, 330], times: [0, 16, 33, 50, 66, 83, 100, 116, 133, 150, 166, 200], cols: 6 })], { stdio: 'inherit' });
}

// Model list trailing icons: the selected check next to the pinned star, hovered.
if (!process.env.ONLY || process.env.ONLY.includes('icons')) {
  const browser = await launch();
  const { page } = await open(browser, { path: '/', width: 1440, height: 900, dpr: 3 });
  const dev = page.getByRole('button', { name: /local dev user/i });
  if (await dev.isVisible({ timeout: 1500 }).catch(() => false)) await dev.click();
  await page.getByTestId('chat-top-bar').waitFor();
  const openList = async () => { await page.getByTestId('tray-model-picker-trigger').click(); await page.locator('[data-testid="plus-tray"] [role=option]').first().waitFor(); await page.waitForTimeout(700); };
  await page.getByTestId('composer-plus-button').click();
  await page.getByTestId('plus-tray').waitFor();
  await page.waitForTimeout(700);
  await openList();
  const sel = page.locator('[data-testid="plus-tray"] [role=option][aria-selected="true"]').first();
  const pin = sel.locator('xpath=following-sibling::button[@aria-pressed]');
  if ((await pin.getAttribute('aria-pressed')) === 'false') { await pin.click({ force: true }); await page.waitForTimeout(500); }
  if (!(await page.locator('[data-testid="plus-tray"] [role=option]').count())) await openList();
  await sel.hover();
  await page.waitForTimeout(200);
  const box = await sel.boundingBox();
  await page.screenshot({ path: `${OUT}/trailing-icons.png`, clip: { x: box.x + box.width - 140, y: box.y - 6, width: 148, height: box.height + 12 } });
  await browser.close();
}
