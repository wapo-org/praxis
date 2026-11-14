// WP-G3 visual gate: our open directly above the reference frames, with the reference shifted 15 %:
// the owner asked for a faster open, so a reference frame at t pairs with ours at 0.85 t.
//   BASE=http://127.0.0.1:5231 OUT=.../G3/A node apps/web/scripts/g3-compare.mjs separate|attached
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { clean, disarm, installClock, launch, open, OUT, record, REF_DIR, REF_FRAMES } from './g2-lib.mjs';
const here = new URL('.', import.meta.url).pathname;
const which = process.argv[2] ?? 'separate';
const RUNS = Number(process.env.RUNS ?? 10);
await mkdir(OUT, { recursive: true });
const browser = await launch();
const { page } = await open(browser, { path: '/lab/glass?morph', dpr: Number(process.env.DPR ?? 2) });
const trigger = page.getByTestId(`${which}-top`);
await trigger.waitFor();
await installClock(page);
await page.waitForTimeout(800);
const dir = `/tmp/g2-frames/${which}`;
await clean(dir);
for (let run = 0; run < RUNS; run++) {
  await record(page, dir, `open${run}`, async () => {
    await trigger.click();
    await page.waitForTimeout(760);
    await disarm(page);
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(450);
}
await browser.close();
// The reference's phone is 920 px across: match its framing around the button.
execFileSync('python3', [`${here}g2-board.py`, dir, `${OUT}/compare-${which}.png`, JSON.stringify({ viewport: [402, 874], speed: 0.85, crop: [130, 0, 402, 300], ref: REF_FRAMES, refDir: REF_DIR, refCrop: [460, 380, 1104, 380 + 710] })], { stdio: 'inherit' });
