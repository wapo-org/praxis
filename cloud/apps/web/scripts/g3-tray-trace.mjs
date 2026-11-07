// WP-G3: the tray's box per frame, from the press. The near (bottom) edge must not arrive late.
//   BASE=... node apps/web/scripts/g3-tray-trace.mjs
import { launch, open } from './g2-lib.mjs';
const browser = await launch();
const { page } = await open(browser, { width: 1440, height: 900, dpr: 2, path: '/' });
const dev = page.getByRole('button', { name: /local dev user/i });
if (await dev.isVisible({ timeout: 1500 }).catch(() => false)) await dev.click();
await page.getByTestId('chat-top-bar').waitFor();
await page.waitForTimeout(1200);
await page.evaluate(() => {
  window.__trace = [];
  let t0 = 0;
  window.addEventListener('pointerdown', () => { t0 = performance.now(); }, { capture: true });
  const tick = (now) => {
    const tray = document.querySelector('[data-testid="plus-tray"]');
    if (tray && t0) {
      const r = tray.getBoundingClientRect();
      window.__trace.push({ t: Math.round(now - t0), l: +r.left.toFixed(1), top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), layoutH: tray.offsetHeight, shell: tray.parentElement.offsetTop });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
for (let run = 0; run < 2; run++) {
  await page.evaluate(() => { window.__trace.length = 0; });
  await page.getByTestId('composer-plus-button').click();
  await page.waitForTimeout(900);
  const out = await page.evaluate(() => window.__trace);
  console.log(`run ${run}: frames ${out.length}`);
  for (const f of out.filter((_, i) => i % 4 === 0).slice(0, 26)) console.log(JSON.stringify(f));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}
await browser.close();
