// WP-G2: the morph's actual numbers per frame (no screencast overhead): shape, radius, content pose.
//   BASE=... node apps/web/scripts/g2-trace.mjs separate-top|attached-top [close]
import { launch, open } from './g2-lib.mjs';
const id = process.argv[2] ?? 'separate-top';
const browser = await launch();
const { page } = await open(browser, { path: '/lab/glass?morph' });
await page.getByTestId(id).waitFor();
await page.waitForTimeout(800);
await page.evaluate(() => {
  window.__trace = [];
  let t0 = 0;
  window.addEventListener('pointerdown', () => { t0 = performance.now(); }, { capture: true });
  const tick = (now) => {
    const menu = document.querySelector('[role=menu]');
    if (menu && t0) {
      const r = menu.getBoundingClientRect();
      const s = menu.querySelector('[data-glass-surface]');
      const cs = getComputedStyle(s);
      const blurred = s.querySelector(':scope > [aria-hidden][class*=blurred]');
      const sharp = s.querySelector('[data-morph-body] > *');
      const lens = s.querySelector(':scope > [data-glass-lens]');
      const transit = s.querySelector(':scope > [data-glass-transit]');
      window.__trace.push({ t: Math.round(now - t0), x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), rx: Math.round(parseFloat(cs.borderTopLeftRadius) * r.width / menu.offsetWidth), blur: blurred ? +blurred.style.opacity : -1, sharp: +(sharp.style.opacity || 1), tint: +(lens.style.opacity || 1), transit: +(transit.style.opacity || 0) });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.getByTestId(id).click();
await page.waitForTimeout(900);
const out = await page.evaluate(() => window.__trace);
console.log('frames', out.length, 'median dt', out.slice(1).map((f, i) => f.t - out[i].t).sort((a, b) => a - b)[out.length >> 1]);
console.log('t      x      y      w      h     r  blur sharp tint transit');
for (const f of out.filter((_, i) => i % 3 === 0 || i < 4).slice(0, 44)) console.log(String(f.t).padEnd(5), String(f.x).padEnd(6), String(f.y).padEnd(6), String(f.w).padEnd(6), String(f.h).padEnd(6), String(f.rx).padEnd(4), f.blur, f.sharp, f.tint, f.transit);
await browser.close();
