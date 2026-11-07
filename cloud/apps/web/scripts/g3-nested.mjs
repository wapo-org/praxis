// WP-G3: frame strips of nested and wide menus, to read frame by frame.
//   BASE=... OUT=... node apps/web/scripts/g3-nested.mjs [in-place|cascade|wide]
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { clean, disarm, installClock, launch, open, OUT, record } from './g2-lib.mjs';
const here = new URL('.', import.meta.url).pathname;
const ONLY = process.argv[2];
const RUNS = Number(process.env.RUNS ?? 6);
await mkdir(`${OUT}/strips`, { recursive: true });
const browser = await launch();
const OPEN = [0, 60, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300, 340, 380, 440, 500, 600];
const SUB = [0, 16, 33, 50, 66, 83, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300, 340, 380, 440, 500];
const crop = [0, 180, 402, 620];
async function page402(width = 402) {
  const { context, page } = await open(browser, { path: '/lab/glass?morph', width, height: 874 });
  await page.getByTestId('morph-lab').waitFor();
  await installClock(page);
  await page.waitForTimeout(700);
  return { context, page };
}
const strip = (dir, name, times, width = 402) => execFileSync('python3', [`${here}g2-board.py`, dir, `${OUT}/strips/${name}.png`, JSON.stringify({ viewport: [width, 874], crop: [0, crop[1], width, crop[3]], times, cols: 7 })], { stdio: 'inherit' });
const landed = (page) => page.waitForFunction(() => { const m = document.querySelector('[role=menu]'); return m && m.style.transform === ''; });

if (!ONLY || ONLY === 'wide') {
  const { context, page } = await page402();
  const dir = '/tmp/g2-frames/wide-open';
  await clean(dir);
  for (let run = 0; run < RUNS; run++) {
    await record(page, dir, `r${run}`, async () => { await page.getByTestId('wide-menu').click(); await page.waitForTimeout(650); await disarm(page); });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(450);
  }
  strip(dir, 'wide-open', OPEN);
  await context.close();
}
for (const [mode, id] of [['in-place', 'nested-morph'], ['cascade', 'nested-cascade']]) {
  if (ONLY && ONLY !== mode) continue;
  // Cascade needs somewhere to go: a submenu cannot sit beside a menu on a phone.
  const width = mode === 'cascade' ? 720 : 402;
  const { context, page } = await page402(width);
  const dir = `/tmp/g2-frames/${mode}-sub`;
  await clean(dir);
  for (let run = 0; run < RUNS; run++) {
    await page.getByTestId(id).click();
    await landed(page);
    await disarm(page);
    await page.waitForTimeout(80);
    await record(page, dir, `r${run}`, async () => { await page.getByRole('menuitem', { name: 'Save as', exact: true }).click(); await page.waitForTimeout(600); await disarm(page); });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(450);
  }
  strip(dir, `${mode}-open`, SUB, width);
  await context.close();
}
await browser.close();
